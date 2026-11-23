import { expect, test } from 'bun:test';
import {
  applyPromptPreview, extractConstraintQuotes, normalizeRounds, previewLoopPrompt, previewPrompt, undoPromptApplication,
} from './prompt-refinement';
import { findUnsupportedEscalation } from '../../../src/core/prompt-proposal';
import { parseMentionTokens } from '../../../src/core/mention-reference';

const empty = { goal: '', doneWhen: '', maxRounds: 3 };
const all = (p: { sections: { id: string }[] }) => p.sections.map(s => s.id);

test('checkbox OFF keeps the existing template exactly; no loop wording is added', () => {
  const off = previewPrompt('버튼 색을 바꾼다.');
  expect(all(off)).toEqual(['goal', 'context', 'plan', 'verify']);
  const text = applyPromptPreview(off, off.source, all(off));
  for (const word of ['반복', '중단 조건', '다시 검증']) expect(text).not.toContain(word);
});

test('checkbox ON builds goal, done criteria, verification, verify→fix→re-verify and stop conditions', () => {
  const on = previewLoopPrompt('버튼 색을 바꾼다.', empty);
  expect(all(on)).toEqual(['loop-goal', 'loop-done', 'loop-scope', 'loop-verify', 'loop-cycle', 'loop-stop']);
  const text = applyPromptPreview(on, on.source, all(on));
  expect(text.startsWith('버튼 색을 바꾼다.\n\n')).toBe(true);
  expect(text).toContain('검증→수정·보완→다시 검증');
  expect(text).toContain('최대 3회까지만 반복');
  for (const stop of ['완료 조건을 모두 충족', '반복 한도(3회)에 도달', '권한·승인이 필요한 작업', '같은 실패가 2회 연속'])
    expect(text).toContain(stop);
});

test('missing goal/criteria are marked 확인 필요, never invented; user input is used verbatim', () => {
  const none = previewLoopPrompt('요청', empty);
  expect(none.sections[0].title).toContain('확인 필요');
  expect(none.sections[1].title).toContain('확인 필요');
  const given = previewLoopPrompt('요청', { goal: '  로그인 오류 0건  ', doneWhen: '- e2e 통과\n\n* 회귀 없음', maxRounds: 5 });
  expect(given.sections[0]).toMatchObject({ title: '목표 (사용자 입력)', body: '로그인 오류 0건' });
  expect(given.sections[1].body).toBe('- e2e 통과\n- 회귀 없음');
  expect(given.sections.find(s => s.id === 'loop-cycle')?.body).toContain('최대 5회');
});

test('round limit is always bounded (no infinite loop wording)', () => {
  expect(normalizeRounds(0)).toBe(1);
  expect(normalizeRounds(99)).toBe(10);
  expect(normalizeRounds(Number.NaN)).toBe(3);
  expect(previewLoopPrompt('요청', { ...empty, maxRounds: 1000 }).sections.find(s => s.id === 'loop-stop')?.body).toContain('10회');
});

test('prohibitions are quoted exactly from the source; conditions ("않으면") are not', () => {
  const source = '설정 화면만 수정한다. 배포 금지. 체크하지않으면 일반 방식으로 동작.\n원래 저장소는 건드리지 않는다.';
  const quotes = extractConstraintQuotes(source);
  expect(quotes).toEqual(['설정 화면만 수정한다.', '배포 금지.', '원래 저장소는 건드리지 않는다.']);
  for (const q of quotes) expect(source.includes(q)).toBe(true);
  expect(previewLoopPrompt(source, empty).sections.find(s => s.id === 'loop-scope')?.body).toContain('- 배포 금지.');
});

test('templates never synthesise permission escalation or ops changes', () => {
  for (const p of [previewPrompt('요청'), previewLoopPrompt('요청', empty)])
    for (const s of p.sections) expect(findUnsupportedEscalation(s.title + '\n' + s.body, [])).toBeUndefined();
});

test('legacy #43 slash command, $skill, @mentions and placeholders survive apply and undo byte-for-byte', () => {
  for (const source of ['/review\n@session:kx9f2a1b {{project}}\n배포 금지\n  ', '$deep-interview @work:wTg4hN2 로그인 고치기', '  /plan  앞 공백 유지']) {
    for (const preview of [previewPrompt(source), previewLoopPrompt(source, empty)]) {
      const applied = applyPromptPreview(preview, source, all(preview));
      expect(applied.startsWith(source + '\n\n')).toBe(true);
      expect(applied.split('\n')[0]).toBe(source.split('\n')[0]);
      expect(parseMentionTokens(applied).map(t => t.raw)).toEqual(parseMentionTokens(source).map(t => t.raw));
      expect(undoPromptApplication(applied, applied, source)).toBe(source);
    }
  }
});
