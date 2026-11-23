import { expect, test } from 'bun:test';
import { previewPrompt, applyPromptPreview, undoPromptApplication, MAX_REFINEMENT_INPUT } from './prompt-refinement';
test('keeps exact source first, including skill launch, references, placeholders and constraints', () => {
 const source = '/review\n@session:abc {{project}}\n배포 금지\n  ';
 const p = previewPrompt(source); const result = applyPromptPreview(p, source, p.sections.map(s => s.id));
 expect(result.startsWith(source + '\n\n')).toBe(true);
 expect(p.sections.every(s => s.title.includes('제안'))).toBe(true);
 expect(result.match(/@session:abc/g)?.length).toBe(1);
});
test('selection adds only selected edited text; undo restores byte-for-byte', () => {
 const p = previewPrompt('  원문\n'); p.sections[0].body = '직접 수정한 목표';
 const next = applyPromptPreview(p, p.source, ['goal']);
 expect(next).toContain('직접 수정한 목표'); expect(next).not.toContain('실행 계획');
 expect(undoPromptApplication(next, next, p.source)).toBe('  원문\n');
});
test('stale source and manual edits cannot be silently overwritten', () => {
 const p = previewPrompt('원문');
 expect(() => applyPromptPreview(p, '더 최근 원문', ['goal'])).toThrow('원문이 바뀌었습니다');
 expect(() => undoPromptApplication('사용자 수정', '적용 결과', '원문')).toThrow('수정한 내용');
});
test('empty, bounded input and empty selection are rejected', () => {
 expect(() => previewPrompt(' \n')).toThrow();
 expect(() => previewPrompt('x'.repeat(MAX_REFINEMENT_INPUT + 1))).toThrow();
 expect(previewPrompt('x'.repeat(MAX_REFINEMENT_INPUT)).source.length).toBe(MAX_REFINEMENT_INPUT);
 const p = previewPrompt('요청'); expect(() => applyPromptPreview(p, p.source, [])).toThrow();
});
