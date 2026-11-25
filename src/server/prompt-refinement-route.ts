import { codexRefinerIssue, configuredCodexRefiner, type CodexRefiner } from './prompt-refinement-codex';
import { claudeRefinerIssue, configuredClaudeRefiner, type ClaudeRefiner } from './prompt-refinement-claude';
import { buildPromptCatalog, type PromptTransportStatus, type PromptCardModels } from './prompt-refinement-catalog';
import type { PromptRefinementPrefs } from '../core/prompt-refinement-prefs-store';
import {
  buildProposalInput, findCatalogModel, MAX_REFINEMENT_INPUT, PROMPT_LOOP_SKILL, PROMPT_MODEL_PATTERN, PROMPT_PROPOSAL_SKILL,
  PROMPT_REFINEMENT_DEFAULT_PATH, proposalSchema, readLoopOptions, readPromptModelRef, readPromptModels, readPromptProposal,
  type PromptLoopOptions, type PromptModelRef, type PromptRefinementCatalog,
} from '../core/prompt-proposal';

const ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_BYTES = 140_000; // above worst-case escaped UTF-16 input
const PROBE_TTL_MS = 30_000;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;
/** `models` is the server-owned allow-list for refinement only; card run models are never read or changed here. */
type Config = { apiKey: string; model: string; models?: string[] };
export type PromptTransport = Config | CodexRefiner | ClaudeRefiner;
type TransportName = 'OpenAI' | 'Codex CLI' | 'Claude CLI';
export interface PromptRouteOptions {
  /** Local default store. Without it the default endpoint answers 503 and nothing is persisted. */
  prefs?: PromptRefinementPrefs;
  /** Read-only card model inventory; it never expands the refinement allow-list. */
  cardModels?: () => Promise<PromptCardModels>;
  /** Reason shown for a provider that is not configured (variable names only, never values). */
  issues?: Partial<Record<TransportName, string>>;
}
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const providerOf = (t: PromptTransport): TransportName => 'provider' in t ? t.provider : 'OpenAI';
const modelsOf = (t: PromptTransport) => t.models ?? [t.model];

export function configuredPromptProvider(env: Record<string, string | undefined>): Config | undefined {
  const apiKey = env.KANBAN_PROMPT_OPENAI_API_KEY?.trim();
  const model = env.KANBAN_PROMPT_OPENAI_MODEL?.trim();
  return env.KANBAN_PROMPT_AI_ENABLED === 'true' && apiKey && model && PROMPT_MODEL_PATTERN.test(model)
    ? {apiKey, model, models: readPromptModels(model, env.KANBAN_PROMPT_OPENAI_MODELS)} : undefined;
}

/** Every configured transport; each request stays pinned to the provider it names.
 * An opted-in but invalid Codex config fails closed: nothing is offered rather than silently using the API. */
export function configuredPromptTransports(env: Record<string, string | undefined>): PromptTransport[] {
  const codex = configuredCodexRefiner(env);
  if (!codex && env.KANBAN_PROMPT_CODEX_ENABLED !== undefined && env.KANBAN_PROMPT_CODEX_ENABLED !== 'false') return [];
  return [codex, configuredClaudeRefiner(env), configuredPromptProvider(env)].filter((t): t is PromptTransport => t !== undefined);
}

/** Why each provider is unavailable from env alone. Names variables, never echoes values. */
export function promptTransportIssues(env: Record<string, string | undefined>): NonNullable<PromptRouteOptions['issues']> {
  const openai = env.KANBAN_PROMPT_AI_ENABLED !== 'true' ? '서버에서 꺼져 있음 (KANBAN_PROMPT_AI_ENABLED)'
    : !env.KANBAN_PROMPT_OPENAI_API_KEY?.trim() ? '전용 API 키 미설정 (KANBAN_PROMPT_OPENAI_API_KEY)'
    : '모델 미설정/형식 오류 (KANBAN_PROMPT_OPENAI_MODEL)';
  return {OpenAI: openai, 'Codex CLI': codexRefinerIssue(env), 'Claude CLI': claudeRefinerIssue(env)};
}

const OPENAI_CHECKS = [
  {key: 'transport', label: '서버 연결 설정', ok: true, detail: 'KANBAN_PROMPT_AI_ENABLED · 고정 endpoint'},
  {key: 'auth', label: '전용 API 키', ok: true, detail: '서버에만 설정됨 (값 비공개)'},
  {key: 'schema', label: '구조화 출력', ok: true, detail: 'json_schema strict 고정 · 모델 지원은 운영자 허용 목록 기준 (사전 호출 없음)'},
] as const;

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

/**
 * Several transports may be configured; each request is pinned to the provider it names
 * and never falls back to another one. `GET` and the default endpoint never call a model.
 */
export function createPromptRefinementRoute(
  configs: PromptTransport | PromptTransport[] | undefined, request: Fetch = fetch, options: PromptRouteOptions = {},
) {
  const transports: PromptTransport[] = [];
  for (const t of Array.isArray(configs) ? configs : configs ? [configs] : [])
    if (!transports.some(x => providerOf(x) === providerOf(t))) transports.push(t);
  let busy = false;
  let probed: {at: number; value: Promise<PromptTransportStatus[]>} | undefined;
  const json = (value: unknown, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
  const statuses = (fresh = false): Promise<PromptTransportStatus[]> => {
    if (!fresh && probed && Date.now() - probed.at < PROBE_TTL_MS) return probed.value;
    const value = Promise.all(transports.map(async (t): Promise<PromptTransportStatus> => {
      const base = {provider: providerOf(t), configured: true, defaultModel: t.model, models: modelsOf(t)};
      if (!('probe' in t)) return {...base, checks: OPENAI_CHECKS.map(c => ({...c}))};
      try { return {...base, checks: await t.probe()}; }
      catch { return {...base, checks: [{key: 'transport', label: '상태 점검', ok: false, detail: '점검 중 오류'}]}; }
    })).then(list => [
      ...list,
      ...(['Codex CLI', 'OpenAI', 'Claude CLI'] as const).filter(name => !list.some(s => s.provider === name))
        .map((name): PromptTransportStatus => ({provider: name, configured: false, issue: options.issues?.[name], models: [], checks: []})),
    ]);
    probed = {at: Date.now(), value};
    return value;
  };
  const catalog = async (fresh = false): Promise<PromptRefinementCatalog> => {
    const saved = options.prefs ? await options.prefs.getDefault().catch(() => null) : null;
    const cardModels = options.cardModels ? await options.cardModels().catch(() => ({})) : {};
    return buildPromptCatalog(await statuses(fresh), saved, cardModels);
  };
  const readJson = async (req: Request): Promise<Record<string, unknown> | undefined> => {
    if (req.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase() !== 'application/json') return undefined;
    try { return record(await boundedJson(req.body, AbortSignal.any([req.signal, AbortSignal.timeout(5_000)]))); }
    catch { return undefined; }
  };
  /** GET/PUT/DELETE of the saved default. Validated against a fresh catalog; never calls a model. */
  const handleDefault = async (req: Request): Promise<Response> => {
    if (req.method === 'GET') return json({catalog: await catalog()});
    if (req.method !== 'PUT' && req.method !== 'DELETE') return json({error:'method_not_allowed'}, 405);
    if (!options.prefs) return json({error:'prefs_unavailable'}, 503);
    let ref: PromptModelRef | null = null;
    if (req.method === 'PUT') {
      const body = await readJson(req);
      if (!body) return json({error:'invalid_body'}, 400);
      try { ref = readPromptModelRef(body); } catch { return json({error:'invalid_body'}, 400); }
      const entry = findCatalogModel(await catalog(true), ref);
      if (!entry?.selectable)
        return json({error:'model_not_selectable', reason: entry?.reason ?? '현재 카탈로그에 없는 모델'}, 409);
    }
    try { await options.prefs.setDefault(ref); } catch { return json({error:'prefs_write_failed'}, 500); }
    return json({catalog: await catalog()});
  };
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.search) return json({error:'unsupported_query'}, 400);
    if (url.pathname === PROMPT_REFINEMENT_DEFAULT_PATH) return handleDefault(req);
    if (req.method === 'GET') {
      const current = await catalog();
      const first = transports.find(t => providerOf(t) === current.serverDefault?.provider) ?? transports[0];
      // `provider` keeps the earlier single-transport shape for older clients.
      return json({provider: first ? {provider: providerOf(first), model: first.model, models: modelsOf(first)} : null, catalog: current});
    }
    if (req.method !== 'POST') return json({error:'method_not_allowed'}, 405);
    if (!transports.length) return json({error:'provider_unavailable'}, 503);
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
      // The named provider is pinned: an unknown one is refused, never re-routed to another transport.
      const config = transports.find(t => providerOf(t) === provider);
      if (!config) return json({error:'provider_changed'},409);
      if (typeof model !== 'string' || !modelsOf(config).includes(model)) return json({error:'model_not_allowed'},409);
      const status = (await statuses()).find(s => s.provider === provider);
      if (!status || status.checks.some(c => !c.ok)) return json({error:'provider_not_ready'},503);
      if (req.signal.aborted) return json({error:'proposal_cancelled'}, 408);
      try {
        const signal = AbortSignal.any([req.signal, AbortSignal.timeout(45_000)]);
        const instructions=loop ? PROMPT_PROPOSAL_SKILL + '\n' + PROMPT_LOOP_SKILL : PROMPT_PROPOSAL_SKILL;
        const input=buildProposalInput(source,loop);
        if ('propose' in config) {
          const output=await config.propose(model,instructions,input,signal);
          if(signal.aborted) throw Error('cancelled');
          return json(readPromptProposal(source,output,loop ? [loop.goal,loop.doneWhen] : []));
        }
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
