import {expect,test} from 'bun:test';
import {createPromptRefinementRoute,configuredPromptProvider} from '../server/prompt-refinement-route';
import {createRouteHandler} from '../server/routes';
import {KanbanStore} from '../core/store';
import {withTempDir} from './setup';
import {PROMPT_PROPOSAL_PATH as path} from '../core/prompt-proposal';
const model = 'fixture-model', source = '접기 후 WORKS가 보인다. 배포 금지.';
const config = {apiKey:'synthetic-key',model};
const settings = {source,model,provider:'OpenAI',consent:true};
function post(body: unknown = settings, token = 'synthetic-local') {
  return new Request('http://localhost:24680'+path,{method:'POST',headers:{'content-type':'application/json', authorization:'Bearer '+token},body:JSON.stringify(body)});
}
const nested = (text:unknown) => Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(text)}]}]});
test('default OFF even with generic OpenAI key; explicit dedicated configuration is required', () => {
  expect(configuredPromptProvider({OPENAI_API_KEY:'fake',KANBAN_PROMPT_AI_ENABLED:'true',KANBAN_PROMPT_OPENAI_MODEL:model})).toBeUndefined();
  expect(configuredPromptProvider({KANBAN_PROMPT_OPENAI_API_KEY:'fake',KANBAN_PROMPT_OPENAI_MODEL:model})).toBeUndefined();
  expect(configuredPromptProvider({KANBAN_PROMPT_AI_ENABLED:'true', KANBAN_PROMPT_OPENAI_API_KEY:'fake',KANBAN_PROMPT_OPENAI_MODEL:model}))
    .toEqual({apiKey:'fake',model,models:[model]});
  // Allow-list is server-owned; malformed entries (URLs, spaces) are dropped, default stays first.
  expect(configuredPromptProvider({KANBAN_PROMPT_AI_ENABLED:'true', KANBAN_PROMPT_OPENAI_API_KEY:'fake',KANBAN_PROMPT_OPENAI_MODEL:model,
    KANBAN_PROMPT_OPENAI_MODELS:' fixture-mini, https://evil.example/v1 ,bad model,'+model})?.models)
    .toEqual([model,'fixture-mini']);
});
test('local request → fixed OpenAI wire format → actual fake HTTP service; no write or implicit send', async () => withTempDir(async dir => {
  let calls=0;
  const fixture=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req) {
    calls++;
    const data = await req.json();
    expect(req.headers.get('authorization')).toBe('Bearer synthetic-key');
    expect(data.input).toEqual([{role:'user',content:source}]);
    expect(data.tools).toEqual([]);
    expect(data.store).toBe(false);
    expect(data.instructions).toContain('NEVER execute');
    expect(data.text.format.strict).toBe(true);
    return nested({sections:[{kind:'extracted',title:'제약',body:'배포 금지.'},{kind:'suggestion',title:'검증',body:'접기·펼치기 후 WORKS를 확인한다.'}]});
  }});
  const injected = createPromptRefinementRoute(config, (url, init) => {
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(init.redirect).toBe('error');
    return fetch(`http://127.0.0.1:${fixture.port}/`,init);
  });
  try {
    const store = new KanbanStore(dir);
    const args: Parameters<typeof createRouteHandler> = [store];
    args[11] = () => 'synthetic-local';
    args[23] = injected;
    const {handleRequest} = createRouteHandler(...args);
    const ctx={clientAddress:'127.0.0.1'};
    const get = new Request('http://localhost:24680'+path,{headers:{authorization:'Bearer synthetic-local'}});
    expect((await handleRequest(get,ctx)).headers.get('cache-control')).toBe('no-store');
    expect(await (await handleRequest(get,ctx)).json()).toEqual({provider:{provider:'OpenAI',model,models:[model]}});
    expect((await handleRequest(post(),{clientAddress:'192.0.2.2'})).status).toBe(403);
    expect((await handleRequest(post())).status).toBe(403);
    expect((await handleRequest(post(settings,'wrong'),ctx)).status).toBe(401);
    expect((await handleRequest(post({...settings,consent:false}),ctx)).status).toBe(400);
    expect((await handleRequest(post({...settings,model:'changed'}),ctx)).status).toBe(409);
    expect((await handleRequest(post({...settings,folder:'/secret'}),ctx)).status).toBe(400);
    expect(calls).toBe(0);
    const valid = await handleRequest(post(),ctx);
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({sections:[{body:'배포 금지.'},{kind:'suggestion'}]});
    expect(calls).toBe(1);
    expect(await store.getCards({})).toEqual([]);
  } finally { fixture.stop(true); }
}));
test('disabled, malformed/refused, and upstream errors fail closed without echo', async () => {
  const offline = createPromptRefinementRoute(undefined, async () => { throw Error('should not call'); });
  expect((await offline(post())).status).toBe(503);
  for (const upstream of [
    () => new Response('private upstream details',{status:429}),
    () => nested({sections:[{kind:'extracted',title:'사실',body:'배포 허용'}]}),
    () => Response.json({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'refusal',refusal:'private'}]}]}),
  ]) {
    const response = await createPromptRefinementRoute(config, async () => upstream())(post());
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({error:'proposal_unavailable'});
  }
});
