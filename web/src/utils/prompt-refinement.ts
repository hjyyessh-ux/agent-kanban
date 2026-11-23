/** Kanban-owned quick skill, not an installed runtime skill or execution request. */
export const PROMPT_REFINEMENT_VERSION = 'kanban-clarify-v1';
export { MAX_REFINEMENT_INPUT } from '../../../src/core/prompt-proposal';
import { LOOP_ROUNDS, MAX_REFINEMENT_INPUT, type PromptLoopOptions } from '../../../src/core/prompt-proposal';
export interface RefinementSection { id: string; title: string; body: string }
export interface RefinementPreview { source: string; sections: RefinementSection[] }

/** Local baseline deliberately does not claim to infer project facts. Keep the entire
 * input unchanged, including leading slash skills, @references and template variables. */
export function previewPrompt(source: string): RefinementPreview {
  if (!source.trim()) throw new Error('먼저 요청을 작성해 주세요.');
  if (source.length > MAX_REFINEMENT_INPUT) throw new Error('20,000자 이하의 요청에 사용할 수 있습니다.');
  return { source, sections: [
    { id: 'goal', title: '목표 · 완료 조건 (제안)', body: '위 원문의 요구를 충족하는 결과물을 만든다. 원문에 없는 기능이나 범위를 임의로 추가하지 않는다. 완료 여부는 요구사항별로 확인한다.' },
    { id: 'context', title: '맥락 · 확인할 사항 (제안)', body: '먼저 관련 코드·문서·기존 동작을 확인한다. 대상 경로, 제약, 기대 결과가 명시되지 않았다면 확인 필요 사항으로 구분한다. 확인하지 않은 사실은 추정으로 표시하고, 진행을 막는 핵심 정보만 질문한다.' },
    { id: 'plan', title: '실행 계획 (제안)', body: '1. 원문 요구와 현재 동작의 차이를 정리한다.\n2. 기존 구조를 재사용해 필요한 범위만 변경한다.\n3. 관련 없는 작업과 미커밋 변경은 보존한다.\n4. 외부 전송·배포·삭제 등 별도 승인이 필요한 작업은 실행 전에 확인한다.' },
    { id: 'verify', title: '검증 · 결과 보고 (제안)', body: '정상 흐름뿐 아니라 빈 입력, 오류, 취소·재시도와 기존 동작의 회귀를 확인한다. 실행한 테스트와 결과, 실행하지 못한 검증을 구분해 기록한다. 바꾼 것, 검증 결과, 남은 일을 짧게 보고한다.' },
  ] };
}
export { LOOP_ROUNDS };
export type { PromptLoopOptions };

// "않으면" is a condition, not a prohibition, so it is excluded.
const CONSTRAINT_HINT = /금지|하지\s?않(?!으면)|하지\s?말|말\s?것|말아|않는다|않게|없이|만\s?(?:수정|변경|사용)|\bdo not\b|\bdon't\b|\bnever\b|\bwithout\b/i;
/** Exact substrings of the source that state a prohibition/limit. Never paraphrased. */
export function extractConstraintQuotes(source: string): string[] {
  const quotes = source.split(/\n|(?<=[.!?。])\s+/).map(part => part.trim()).filter(part => part && CONSTRAINT_HINT.test(part));
  return [...new Set(quotes)].slice(0, 12);
}
export const normalizeRounds = (n: number) =>
  Number.isInteger(n) ? Math.min(LOOP_ROUNDS.max, Math.max(LOOP_ROUNDS.min, n)) : LOOP_ROUNDS.default;

/** Bounded verify-fix loop, always appended (local and AI) so stop conditions never depend on a model. */
export function loopCycleSections(maxRounds: number): RefinementSection[] {
  const n = normalizeRounds(maxRounds);
  return [
    { id: 'loop-cycle', title: '반복 절차 · 검증→수정·보완→다시 검증 (제안)', body: `회차마다 아래 순서로 진행하고, 최대 ${n}회까지만 반복한다.\n1. 완료 조건을 기준으로 현재 결과를 검증한다.\n2. 실패한 항목의 원인을 찾아 그 부분만 수정·보완한다.\n3. 같은 검증을 다시 실행하고 회차별 결과(통과/실패, 바꾼 것)를 기록한다.` },
    { id: 'loop-stop', title: '중단 조건 · 반복 한도 (제안)', body: `다음 중 하나라도 해당하면 반복을 멈추고 현재 상태를 보고한다.\n- 완료 조건을 모두 충족했다.\n- 반복 한도(${n}회)에 도달했다.\n- 권한·승인이 필요한 작업(외부 전송, 배포, 커밋, 삭제, 권한 변경 등)이 필요하다. 직접 진행하지 않고 확인을 요청한다.\n- 같은 원인의 같은 실패가 2회 연속 반복됐다.\n보고에는 충족한 조건, 남은 실패, 시도한 수정, 다음에 필요한 결정을 포함한다.` },
  ];
}

/** Local, network-free loop template. Missing goal/done criteria stay "확인 필요" — never invented. */
export function previewLoopPrompt(source: string, loop: PromptLoopOptions): RefinementPreview {
  const base = previewPrompt(source);
  const goal = loop.goal.trim();
  const done = loop.doneWhen.split('\n').map(line => line.trim().replace(/^[-*]\s*/, '')).filter(Boolean);
  const quotes = extractConstraintQuotes(source);
  return { source: base.source, sections: [
    goal
      ? { id: 'loop-goal', title: '목표 (사용자 입력)', body: goal }
      : { id: 'loop-goal', title: '목표 · 확인 필요 (제안)', body: '목표가 입력되지 않았습니다. 위 원문 요구를 목표의 근거로 삼되 원문에 없는 목표를 확정하지 않는다. 시작 전에 최종 목표를 한 문장으로 확인한다.' },
    done.length
      ? { id: 'loop-done', title: '완료 조건 (사용자 입력)', body: done.map(line => `- ${line}`).join('\n') }
      : { id: 'loop-done', title: '완료 조건 · 확인 필요 (제안)', body: '구체적인 완료 조건이 입력되지 않았습니다. 아래 공통 조건으로 시작하고, 확정 조건은 사용자에게 확인한다.\n- 원문의 요구가 항목별로 충족되었음을 확인할 수 있다.\n- 원문의 금지·제외 범위를 위반하지 않았다.\n- 아래 검증 방식이 모두 통과했다.' },
    { id: 'loop-scope', title: quotes.length ? '원문 요구·금지 범위 보존 (원문 발췌 포함)' : '원문 요구·금지 범위 보존 (제안)',
      body: (quotes.length ? quotes.map(q => `- ${q}`).join('\n') + '\n' : '') + '원문의 요구와 금지·제외 범위를 그대로 유지한다. 반복 중에도 범위를 넓히거나 제약을 완화하지 않는다.' },
    { id: 'loop-verify', title: '검증 방식 (제안)', body: '- 완료 조건 항목마다 확인 방법(테스트, 실행 결과, 화면 확인 등)을 정하고 실제로 실행한다.\n- 실행하지 못한 검증은 미실행으로 구분해 기록한다.\n- 기존 동작의 회귀도 함께 확인한다.' },
    ...loopCycleSections(loop.maxRounds),
  ] };
}

export function applyPromptPreview(preview: RefinementPreview, current: string, selected: string[]): string {
  if (current !== preview.source) throw new Error('미리보기 후 원문이 바뀌었습니다. 다시 구체화해 주세요.');
  const sections = preview.sections.filter(section => selected.includes(section.id));
  if (!sections.length) throw new Error('적용할 항목을 선택해 주세요.');
  return preview.source + '\n\n' + sections.map(s => `## ${s.title}\n${s.body}`).join('\n\n');
}
export function undoPromptApplication(current: string, applied: string, original: string): string {
  if (current !== applied) throw new Error('적용 후 수정한 내용이 있어 자동으로 되돌리지 않습니다. 원문을 복사해 필요한 부분만 복원하세요.');
  return original;
}
