import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [dir,runtime,...args]=process.argv.slice(2);
const prompt=(await new Response(Bun.stdin.stream()).text()).trim();
const mode=runtime==='codex'?'resume':'--resume';
const at=args.indexOf(mode);
const resumed=at<0?null:args[at+1];
const sessionId=resumed??runtime+'-fresh-fixture';
appendFileSync(join(dir,'stub-runs.jsonl'),JSON.stringify({runtime,prompt,resumed})+'\n');
const emit=(payload:unknown)=>process.stdout.write(JSON.stringify(payload)+'\n');
if(runtime==='codex')emit({type:'thread.started',thread_id:sessionId});
else emit({type:'system',subtype:'init',session_id:sessionId});
if(prompt.includes('queue predecessor')) {
  for(let i=0;!existsSync(join(dir,'allow-'+runtime))&&i<125;i++)await Bun.sleep(40);
  if(!existsSync(join(dir,'allow-'+runtime)))throw Error('queue gate did not open');
}
const result='native stub: '+prompt;
if(runtime==='codex'){
  const output=args[args.indexOf('-o')+1];
  await Bun.write(output,result);
  emit({type:'item.completed',item:{role:'assistant',content:[{type:'text',text:result}]}});
  emit({type:'turn.completed'});
}else {
  emit({type:'assistant',message:{id:'msg-fixture',content:[{type:'text',text:result}]}});
  emit({type:'result',result,session_id:sessionId});
}
