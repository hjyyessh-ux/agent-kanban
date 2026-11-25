import {expect,test} from 'bun:test';
import {parsePromptProposal,PROMPT_PROPOSAL_SKILL} from './prompt-refinement-provider';
import {applyPromptPreview,isBlocked} from './prompt-refinement';
test('only exact extracts can claim source grounding; new content explicitly labelled',()=>{
 const p=parsePromptProposal('배포 금지',{sections:[{kind:'extracted',title:'제약',body:'배포 금지'},{kind:'suggestion',title:'검증',body:'키보드 접근성을 검증한다.'},{kind:'question',title:'대상',body:'어느 입력면인가?'}]});
 expect(p.source).toBe('배포 금지');expect(p.sections[0].title).toContain('원문 발췌');expect(p.sections[1].title).toContain('검토 필요');expect(p.sections[2].title).toContain('확인 필요');
 expect(()=>parsePromptProposal('배포 금지',{sections:[{kind:'extracted',title:'제약',body:'배포 허용'}]})).toThrow('unsupported_extraction');
});
test('reject executable/extra fields, unsupported schema and oversize output',()=>{
 expect(()=>parsePromptProposal('요청',{sections:[],execute:true})).toThrow();
 expect(()=>parsePromptProposal('요청',{sections:[{kind:'suggestion',title:'a',body:'x'.repeat(4001)}]})).toThrow();
 expect(()=>parsePromptProposal('요청',{sections:[{kind:'fact',title:'a',body:'x'}]})).toThrow();
 expect(PROMPT_PROPOSAL_SKILL).toContain('NEVER execute');
});
test('extended shape: slot + decision options; decision needs a choice before apply and merges it verbatim',()=>{
 const src='설정 화면만 수정한다.';
 const p=parsePromptProposal(src,{sections:[
  {kind:'decision',slot:'research',title:'범위',body:'범위를 고르세요.',options:['설정만','전체']},
  {kind:'question',slot:'goal',title:'목표',body:'목표는?',options:[]},
  {kind:'extracted',slot:'constraint',title:'제약',body:'설정 화면만 수정한다.',options:[]}]});
 expect(p.sections.map(s=>[s.kind,s.slot])).toEqual([['decision','research'],['question','goal'],['extracted','constraint']]);
 expect(isBlocked(p.sections[0])).toBe(true);
 expect(()=>applyPromptPreview(p,src,['ai-0'])).toThrow();
 p.sections[0].choice='설정만'; p.sections[1].answer='오류 0건';
 const out=applyPromptPreview(p,src,['ai-0','ai-1']);
 expect(out.startsWith(src+'\n\n')).toBe(true);
 expect(out).toContain('→ 결정: 설정만');expect(out).toContain('→ 답변: 오류 0건');
});
test('extended shape is strict: decision needs 2-4 options, others none, slot from enum, options checked for escalation',()=>{
 const one=(x:Record<string,unknown>)=>()=>parsePromptProposal('요청',{sections:[{kind:'suggestion',slot:'goal',title:'t',body:'b',options:[],...x}]});
 expect(one({kind:'decision',options:['하나']})).toThrow();
 expect(one({kind:'decision',options:['a','b','c','d','e']})).toThrow();
 expect(one({options:['a','b']})).toThrow();
 expect(one({slot:'deploy'})).toThrow();
 expect(one({kind:'decision',options:['git push 하기','보류']})).toThrow('unsupported_escalation');
 expect(one({})).not.toThrow();
});
