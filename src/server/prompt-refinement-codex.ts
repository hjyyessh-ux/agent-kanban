import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { createHash } from 'node:crypto';
import { PROMPT_MODEL_PATTERN, readPromptModels, proposalSchema } from '../core/prompt-proposal';

export const CODEX_REFINEMENT = 'Codex CLI';
export type CodexRefiner = {
  provider: typeof CODEX_REFINEMENT; model: string; models: string[];
  propose(model: string, instructions: string, input: string, signal: AbortSignal): Promise<unknown>;
};
type Options = { executable: string; binarySha256: string; profile: string; sharedHome: string; model: string; models: string[] };
const MAX_OUTPUT = 140_000;
const SHA=/^[a-f0-9]{64}$/;
const safePath = (p:string) => isAbsolute(p) && normalize(p)===p && !/[\u0000-\u001f]/.test(p);
const quote=(s:string)=>JSON.stringify(s);
const HOME_SUFFIX='.agent-kanban/prompt-refinement-codex';

export function configuredCodexRefiner(env: Record<string,string|undefined>): CodexRefiner | undefined {
  if(env.KANBAN_PROMPT_CODEX_ENABLED!=='true' || process.platform!=='darwin') return;
  const executable=env.KANBAN_PROMPT_CODEX_BINARY?.trim(), binarySha256=env.KANBAN_PROMPT_CODEX_BINARY_SHA256?.trim();
  const model=env.KANBAN_PROMPT_CODEX_MODEL?.trim(), sharedHome=env.HOME??homedir();
  if(!executable||!safePath(executable)||!binarySha256||!SHA.test(binarySha256)||!model||
      !PROMPT_MODEL_PATTERN.test(model)||!safePath(sharedHome)) return;
  return createCodexRefiner({executable,binarySha256,model,models:readPromptModels(model,env.KANBAN_PROMPT_CODEX_MODELS),
    sharedHome,profile:join(sharedHome,HOME_SUFFIX)});
}

async function readBounded(stream:ReadableStream<Uint8Array>, cap:number):Promise<string> {
  const chunks:Uint8Array[]=[]; let bytes=0;
  for await(const chunk of stream) {
    bytes+=chunk.byteLength;
    if(bytes>cap) throw Error('codex_refinement_output_limit');
    chunks.push(chunk);
  }
  return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
}

/** Dedicated local Codex login and a fixed executable. Never copies or reads the
 * regular Codex credentials to prepare a refinement. No card/runtime adapter. */
export function createCodexRefiner(o:Options):CodexRefiner {
  const {model,models}=o;
  return {provider:CODEX_REFINEMENT,model,models,async propose(selected,instructions,input,signal) {
    if(!models.includes(selected)||signal.aborted) throw Error('codex_refinement_request_invalid');
    const path=await realpath(o.executable);
    const host=await realpath(o.sharedHome);
    const profile=await realpath(o.profile);
    const profileStat=await lstat(profile);
    const executable=await stat(path);
    if(host!==o.sharedHome||profile!==o.profile||path!==o.executable||!profileStat.isDirectory()||
        (profileStat.mode&0o077)!==0||profileStat.uid!==process.getuid?.()||!executable.isFile()||
        !(executable.mode&0o111)||(executable.mode&0o022)!==0||executable.size>512*1024*1024||
        createHash('sha256').update(await readFile(path)).digest('hex')!==o.binarySha256)
      throw Error('codex_refinement_profile_or_binary_invalid');
    // A dedicated credential home must not be pointed at an ordinary Codex
    // profile. Authentication and global instructions otherwise share CODEX_HOME.
    const auth=join(profile,'auth');
    const authStat=await lstat(auth);
    if((await realpath(auth))!==auth||!authStat.isDirectory()||authStat.uid!==process.getuid?.()||
        (authStat.mode&0o077)!==0) throw Error('codex_refinement_auth_profile_invalid');
    const authFile=await lstat(join(auth,'auth.json'));
    if(!authFile.isFile()||authFile.nlink!==1||authFile.uid!==process.getuid?.()||(authFile.mode&0o077)!==0)
      throw Error('codex_refinement_auth_file_invalid');
    for(const name of ['AGENTS.md','AGENTS.override.md','config.toml','hooks.json','skills','plugins','memories']) {
      try {await lstat(join(auth,name));throw Error('codex_refinement_auth_profile_not_clean');}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;}
    }
    const work=await mkdtemp(join(profile,'request-'));
    try {
      await chmod(work,0o700);
      const schema=join(work,'proposal.json');
      await writeFile(schema,JSON.stringify(proposalSchema),{mode:0o600,flag:'wx'});
      // macOS enforces the main child and its descendants, not just model tool
      // sandbox defaults. Read access under user home and temp roots is explicitly
      // allowed only to the pinned binary, this request and the dedicated auth.
      const policy=`(version 1)
(allow default)
(deny file-read-data (subpath "/Users") (subpath "/private/tmp") (subpath "/private/var/folders") (subpath "/Volumes") (subpath ${quote(host)}))
(allow file-read-data (literal ${quote(path)}) (subpath ${quote(work)}) (subpath ${quote(auth)}))
(deny file-write*)
(allow file-write* (subpath ${quote(work)}) (subpath ${quote(auth)}) (literal "/dev/null"))
(deny network-outbound (remote ip "localhost:*"))
`;
      if(signal.aborted) throw Error('codex_refinement_cancelled');
      const proc=Bun.spawn(['/usr/bin/sandbox-exec','-p',policy,path,
        '--ask-for-approval','never','exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--sandbox','read-only','--skip-git-repo-check',
        '--disable','shell_tool','--disable','shell_snapshot','--disable','hooks','--disable','apps','--disable','plugins',
        '--disable','multi_agent_v2','--disable','memories','--disable','request_permissions_tool',
        '-c','cli_auth_credentials_store="file"','-c','mcp_servers={}','-c','web_search="disabled"','-c','skills.bundled.enabled=false',
        '-c','project_doc_max_bytes=0','-c','history.persistence="none"','-c','log_dir='+quote(work),
        '-m',selected,'--output-schema',schema,'-'],{
        cwd:work, env:{HOME:work,CODEX_HOME:auth,TMPDIR:work,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8'},
        stdin:new Blob([instructions+'\n\n<request-data>\n'+input+'\n</request-data>']),
        stdout:'pipe',stderr:'pipe',detached:true,
      });
      const stop=()=>{try {process.kill(-proc.pid,'SIGKILL');} catch {try {proc.kill('SIGKILL');} catch {/* exited */}}};
      const deadline=AbortSignal.any([signal,AbortSignal.timeout(40000)]);
      deadline.addEventListener('abort',stop,{once:true});
      if(deadline.aborted) stop();
      try {
        const [out,,exit]=await Promise.all([readBounded(proc.stdout,MAX_OUTPUT),readBounded(proc.stderr,48_000),proc.exited]);
        if(exit!==0||deadline.aborted) throw Error('codex_refinement_failed');
        return parseCodexRefinementEvents(out);
      } finally {deadline.removeEventListener('abort',stop);stop();await proc.exited;}
    } finally {await rm(work,{recursive:true,force:true});}
  }};
}

export function parseCodexRefinementEvents(text:string):unknown {
  let answer:string|undefined, done=false;
  for (const line of text.split('\n').filter(Boolean)) {
    const event=JSON.parse(line) as {type?:string;item?:{type?:string;text?:string}};
    if(done) throw Error('codex_refinement_invalid_trailing_event');
    if(event.type==='thread.started'||event.type==='turn.started') continue;
    if(event.type==='turn.completed'){done=true;continue;}
    if(event.type==='item.completed'&&event.item?.type==='reasoning') continue;
    if(event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string'&&answer===undefined){
      answer=event.item.text;
      continue;
    }
    throw Error('codex_refinement_unexpected_event');
  }
  if(!done||!answer) throw Error('codex_refinement_no_answer');
  return JSON.parse(answer);
}
