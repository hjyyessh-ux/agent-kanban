import {
  buildProposalInput, MAX_REFINEMENT_INPUT, PROMPT_LOOP_SKILL, PROMPT_MODEL_PATTERN, PROMPT_PROPOSAL_SKILL,
  proposalSchema, readLoopOptions, readPromptModels, readPromptProposal, type PromptLoopOptions,
} from '../core/prompt-proposal';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_BYTES = 140_000; // above worst-case escaped UTF-16 input
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** `models` is the server-owned allow-list for refinement only; card run models are never read or changed here. */
type Config = { apiKey: string; model: string; models?: string[] };
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function configuredPromptProvider(env: Record<string, string | undefined>): Config | undefined {
  const apiKey = env.KANBAN_PROMPT_OPENAI_API_KEY?.trim();
  const model = env.KANBAN_PROMPT_OPENAI_MODEL?.trim();
  return env.KANBAN_PROMPT_AI_ENABLED === 'true' && apiKey && model && PROMPT_MODEL_PATTERN.test(model)
    ? {apiKey, model, models: readPromptModels(model, env.KANBAN_PROMPT_OPENAI_MODELS)} : undefined;
}

async function boundedJson(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<unknown> {
  if (!body) throw Error('invalid_body');
  const reader = body.getReader();
  const dec = new TextDecoder('utf-8', {fatal:true});
  let size = 0, text = '';
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, {once:true});
  try {
    if (signal.aborted) { cancel(); throw Error('cancelled'); }
    for (;;) {
      const {done, value} = await reader.read();
      if (signal.aborted) throw Error('cancelled');
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { void reader.cancel().catch(() => undefined); throw Error('too_large'); }
      text += dec.decode(value, {stream:true});
    }
    return JSON.parse(text + dec.decode());
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export function createPromptRefinementRoute(config: Config | undefined, request: Fetch = fetch) {
  let busy = false;
  const json = (value: unknown, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
  return async (req: Request): Promise<Response> => {
    if (new URL(req.url).search) return json({error:'unsupported_query'}, 400);
    const models = config ? config.models ?? [config.model] : [];
    if (req.method === 'GET') return json({provider: config ? {provider:'OpenAI', model:config.model, models} : null});
    if (req.method !== 'POST') return json({error:'method_not_allowed'}, 405);
    if (!config) return json({error:'provider_unavailable'}, 503);
    if (req.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase() !== 'application/json')
      return json({error:'invalid_body'}, 415);
    if (busy) return json({error:'proposal_busy'}, 429);
    busy = true;
    try {
      let body: Record<string,unknown>;
      try { body = record(await boundedJson(req.body, AbortSignal.any([req.signal, AbortSignal.timeout(5_000)]))); }
      catch { return json({error:'invalid_body'}, 400); }
      const {source, provider, model, consent} = body;
      const keys = Object.keys(body).sort().join();
      if ((keys !== 'consent,model,provider,source' && keys !== 'consent,loop,model,provider,source') ||
          typeof source !== 'string' || !source.trim() || source.length > MAX_REFINEMENT_INPUT || consent !== true)
        return json({error:'invalid_body'},400);
      let loop: PromptLoopOptions | undefined;
      try { loop = 'loop' in body ? readLoopOptions(body.loop) : undefined; }
      catch { return json({error:'invalid_body'},400); }
      // Provider/model come only from the server allow-list; the endpoint is a fixed constant.
      if (provider !== 'OpenAI' || typeof model !== 'string' || !models.includes(model))
        return json({error:'provider_changed'},409);
      if (req.signal.aborted) return json({error:'proposal_cancelled'}, 408);
      try {
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]);
        const instructions=loop ? PROMPT_PROPOSAL_SKILL + '\n' + PROMPT_LOOP_SKILL : PROMPT_PROPOSAL_SKILL;
        const input=buildProposalInput(source,loop);
        const response = await request(ENDPOINT, {
          method:'POST', redirect:'error', signal,
          headers:{authorization:'Bearer ' + config.apiKey, 'content-type':'application/json'},
          body:JSON.stringify({
            model, instructions,
            input:[{role:'user', content:input}], store:false, tools:[],
            max_output_tokens:3000,
            text:{format:{type:'json_schema', name:'kanban_prompt_proposal', strict:true, schema:proposalSchema}},
          }),
        });
        if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw Error('upstream'); }
        const envelope = record(await boundedJson(response.body, signal));
        if (envelope.status !== 'completed' || !Array.isArray(envelope.output)) throw Error('incomplete');
        const messages = envelope.output.map(record);
        if (messages.some(m => m.type !== 'message' && m.type !== 'reasoning')) throw Error('unexpected_output');
        const output = messages.filter(m => m.type === 'message');
        if (output.length !== 1 || output[0].role !== 'assistant' || !Array.isArray(output[0].content) ||
            output[0].content.length !== 1) throw Error('invalid_output');
        const block = record(output[0].content[0]);
        if (block.type !== 'output_text' || typeof block.text !== 'string') throw Error('invalid_output');
        if (signal.aborted) throw Error('cancelled');
        return json(readPromptProposal(source, JSON.parse(block.text), loop ? [loop.goal, loop.doneWhen] : []));
      } catch { return json({error:'proposal_unavailable'}, 502); }
    } finally { busy = false; }
  };
}

export type PromptRefinementRoute = ReturnType<typeof createPromptRefinementRoute>;
