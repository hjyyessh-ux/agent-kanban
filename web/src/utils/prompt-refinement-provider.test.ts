import {expect,test} from 'bun:test';
import {parsePromptProposal,PROMPT_PROPOSAL_SKILL} from './prompt-refinement-provider';
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
