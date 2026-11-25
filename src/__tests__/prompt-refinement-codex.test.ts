import {expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import {chmodSync,lstatSync,mkdirSync,readFileSync,realpathSync,readdirSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {configuredCodexRefiner,createCodexRefiner,parseCodexRefinementEvents,CODEX_REFINEMENT} from '../server/prompt-refinement-codex';
import {configuredPromptTransports,createPromptRefinementRoute} from '../server/prompt-refinement-route';
import {PROMPT_PROPOSAL_PATH} from '../core/prompt-proposal';
import {withTempDir} from './setup';

const source='작업 카드를 수정하지 않음.';
const result={sections:[{title:'제약',body:source,kind:'extracted'}]};
const events=(...value:unknown[])=>value.map(x=>JSON.stringify(x)).join('\n');
const completed={type:'turn.completed'};
const answer={type:'item.completed',item:{type:'agent_message',text:JSON.stringify(result)}};
test('Codex preview accepts a final structured answer, never tool, refusal or partial events',()=>{
  expect(configuredCodexRefiner({})).toBeUndefined();
  expect(parseCodexRefinementEvents(events({type:'thread.started'},{type:'turn.started'},answer,completed))).toEqual(result);
  for(const fail of [events(answer),events(answer,answer,completed),events(completed,answer),
    events({type:'item.started',item:{type:'command_execution'}},answer,completed),
    events({type:'item.completed',item:{type:'mcp_tool_call'}},answer,completed),events(answer,{type:'turn.failed'})])
    expect(()=>parseCodexRefinementEvents(fail)).toThrow();
});

test('provider selection fails closed and does not switch an opted-in CLI request to a valid API config',()=>{
  const api={KANBAN_PROMPT_AI_ENABLED:'true',KANBAN_PROMPT_OPENAI_API_KEY:'fixture-only',KANBAN_PROMPT_OPENAI_MODEL:'api-fixture',KANBAN_PROMPT_CLAUDE_ENABLED:'false'};
  const models=(env:Record<string,string>)=>configuredPromptTransports(env).map(t=>t.model);
  expect(models(api)).toEqual(['api-fixture']);
  expect(models({...api,KANBAN_PROMPT_CODEX_ENABLED:'false'})).toEqual(['api-fixture']);
  for (const value of ['true','yes',''])
    expect(models({...api,KANBAN_PROMPT_CODEX_ENABLED:value})).toEqual([]);
  const configured=models({...api,KANBAN_PROMPT_CODEX_ENABLED:'true',
    KANBAN_PROMPT_CODEX_BINARY:'/absolute/fixture',KANBAN_PROMPT_CODEX_BINARY_SHA256:'0'.repeat(64),KANBAN_PROMPT_CODEX_MODEL:'cli-fixture'});
  expect(configured).toEqual(process.platform==='darwin'?['cli-fixture','api-fixture']:[]);
});

test('explicit Codex selection shares proposal validation and never falls back to the API',async()=>{
  let calls=0, fetches=0, fail=false;
  const route=createPromptRefinementRoute({provider:CODEX_REFINEMENT,model:'safe-model',models:['safe-model'],
    probe:async()=>[{key:'auth',label:'전용 로그인',ok:true,detail:'fixture'}],
    async propose(model,instructions,input){calls++;expect(model).toBe('safe-model');
      expect(instructions).toContain('NEVER execute');expect(input).toBe(source);if(fail) throw Error('fixture failure');return result;
    }},async()=>{fetches++;throw Error('unexpected fetch');});
  const url='http://127.0.0.1'+PROMPT_PROPOSAL_PATH;
  expect(await (await route(new Request(url))).json()).toMatchObject({provider:{provider:CODEX_REFINEMENT,model:'safe-model',models:['safe-model']}});
  const post=(provider:string,model='safe-model',consent=true)=>route(new Request(url,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify({provider,source,model,consent})}));
  expect((await post('OpenAI')).status).toBe(409);
  expect((await post(CODEX_REFINEMENT,'other')).status).toBe(409);
  expect((await post(CODEX_REFINEMENT,'safe-model',false)).status).toBe(400);
  expect(calls).toBe(0);
  expect(await (await post(CODEX_REFINEMENT)).json()).toEqual(result);
  expect(calls).toBe(1);
  fail=true;
  expect((await post(CODEX_REFINEMENT)).status).toBe(502);
  expect(fetches).toBe(0);
});

// Exercise a real restricted child only where macOS allows a nested OS policy.
// Production has no unconfined fallback if sandbox-exec cannot start.
test.skipIf(process.platform!=='darwin'||process.env.AK_VERIFY_MAC_SANDBOX!=='1')(
  'real text runner blocks unrelated reads and writes, supplies no inherited auth, cleans up and rejects ordinary profile config',
  ()=>withTempDir(async temp=>{
    const dir=realpathSync(temp),profile=join(dir,'profile'), binary=join(dir,'trusted-fixture');
    const secret=join(dir,'unrelated-private.txt');
    mkdirSync(profile,{mode:0o700});
    const auth=join(profile,'auth');
    const authFile=join(auth,'auth.json');
    mkdirSync(auth,{mode:0o700});
    writeFileSync(authFile,'{}',{mode:0o600});
    writeFileSync(secret,'fixture not to be read',{mode:0o600});
    const script=`#!/bin/sh
test -z "$OPENAI_API_KEY$ANTHROPIC_API_KEY$AGENT_KANBAN_DISPATCH_CARD_ID" || exit 2
if /bin/cat '${secret}' >/dev/null 2>&1; then exit 3; fi
if ( /bin/echo do-not-write > '${dir}/outside' ) 2>/dev/null; then exit 4; fi
case " $* " in *' cli_auth_credentials_store="file" '*) ;; *) exit 7;; esac
case " $* " in *" --ephemeral "*) ;; *) exit 5;; esac
case " $* " in *" --ignore-user-config "*) ;; *) exit 5;; esac
case " $* " in *" --sandbox read-only "*) ;; *) exit 5;; esac
case " $* " in *" --disable hooks "*) ;; *) exit 5;; esac
while IFS= read -r line; do :; done
/bin/echo '${JSON.stringify(answer)}'
/bin/echo '${JSON.stringify(completed)}'
`;
    writeFileSync(binary,script,{mode:0o700});
    chmodSync(binary,0o700);
    const refiner=createCodexRefiner({executable:binary,binarySha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),
      profile,sharedHome:dir,model:'safe-model',models:['safe-model']});
    expect(await refiner.propose('safe-model','Synthetic instruction',source,new AbortController().signal)).toEqual(result);
    expect(readdirSync(profile)).toEqual(['auth']);
    const wrongBinary=createCodexRefiner({executable:binary,binarySha256:'0'.repeat(64),
      profile,sharedHome:dir,model:'safe-model',models:['safe-model']});
    await expect(wrongBinary.propose('safe-model','Synthetic instruction',source,new AbortController().signal))
      .rejects.toThrow('profile_or_binary_invalid');
    unlinkSync(authFile);
    symlinkSync(secret,authFile);
    await expect(refiner.propose('safe-model','Synthetic instruction',source,new AbortController().signal))
      .rejects.toThrow('auth_file_invalid');
    unlinkSync(authFile);
    writeFileSync(authFile,'{}',{mode:0o600});
    expect(()=>lstatSync(join(dir,'outside'))).toThrow();
    writeFileSync(join(profile,'auth','AGENTS.md'),'not allowed');
    await expect(refiner.propose('safe-model','Synthetic instruction',source,new AbortController().signal))
      .rejects.toThrow('profile_not_clean');
  }));
