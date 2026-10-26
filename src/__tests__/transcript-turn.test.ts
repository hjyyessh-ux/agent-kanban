import { describe, expect, test } from 'bun:test';
import { extractClaudeTurn, extractCodexTurn, extractRunEventsTurn } from '../plugin/runtimes/transcript-turn';

// Fixtures mirror shapes observed in real ~/.claude/projects and ~/.codex/sessions
// files (uuids/text shortened). Every case is a way the turn can be mis-located.

const T0 = Date.parse('2026-10-20T05:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();
const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n');

let uuidSeq = 0;
function claude(type: 'user' | 'assistant', content: unknown, seconds: number, extra: Record<string, unknown> = {}) {
  uuidSeq += 1;
  return {
    type,
    uuid: `u${uuidSeq}`,
    timestamp: at(seconds),
    message: { role: type, content, ...(extra.stop_reason ? { stop_reason: extra.stop_reason } : {}) },
    ...extra,
  };
}
/** Link entries into one parentUuid chain (a linear conversation). */
function chain<T extends { uuid: string; parentUuid?: string | null }>(entries: T[]): T[] {
  entries.forEach((entry, i) => {
    if (entry.parentUuid === undefined) entry.parentUuid = i === 0 ? null : entries[i - 1].uuid;
  });
  return entries;
}
const text = (value: string) => [{ type: 'text', text: value }];

describe('extractClaudeTurn', () => {
  test('keeps every text block of the turn and stops at the next real prompt', () => {
    const raw = lines(chain([
      claude('user', '첫 번째 질문', 0),
      claude('assistant', text('첫 답'), 2, { stop_reason: 'end_turn' }),
      claude('user', '두 번째 질문', 10),
      claude('assistant', [...text('조사합니다'), { type: 'tool_use', id: 't1', name: 'Bash', input: {} }], 12, { stop_reason: 'tool_use' }),
      claude('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], 13),
      claude('assistant', text('최종 결론'), 15, { stop_reason: 'end_turn' }),
      claude('user', '세 번째 질문', 30),
      claude('assistant', text('다른 카드의 답'), 32, { stop_reason: 'end_turn' }),
    ]));

    const extraction = extractClaudeTurn(raw, { prompt: '두 번째 질문', anchorAt: at(10) });
    expect(extraction).toEqual({
      ok: true,
      turn: { result: '조사합니다\n\n최종 결론', finalResult: '최종 결론', completed: true, promptAt: at(10) },
    });
  });

  test('a skill body (isMeta) injected mid-turn does not split the turn', () => {
    const raw = lines(chain([
      claude('user', '스킬 써서 정리해줘', 0),
      claude('assistant', [...text('스킬을 불러옵니다'), { type: 'tool_use', id: 's1', name: 'Skill', input: {} }], 1),
      claude('user', [{ type: 'tool_result', tool_use_id: 's1', content: 'Launching skill' }], 2),
      claude('user', text('Base directory for this skill: /x\n\n# Skill body'), 2, { isMeta: true }),
      claude('assistant', text('정리 결과'), 5, { stop_reason: 'end_turn' }),
    ]));

    const extraction = extractClaudeTurn(raw, { prompt: '스킬 써서 정리해줘', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('스킬을 불러옵니다\n\n정리 결과');
  });

  test('harness-injected teammate traffic is not a turn boundary', () => {
    const raw = lines(chain([
      claude('user', '팀으로 조사해줘', 0),
      claude('assistant', text('teammate 를 띄웁니다'), 1),
      claude('user', 'Another Claude session sent a message:\n<teammate-message>보고</teammate-message>', 20),
      claude('assistant', text('종합 보고'), 25, { stop_reason: 'end_turn' }),
    ]));

    const extraction = extractClaudeTurn(raw, { prompt: '팀으로 조사해줘', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('teammate 를 띄웁니다\n\n종합 보고');
  });

  // Rewind/re-submit leaves both attempts in the file under the same parent.
  // Each submission minted its own card, so each card gets the answer ITS
  // attempt produced — the abandoned one included.
  test('a rewound attempt and its replacement each resolve to their own branch', () => {
    const root = claude('user', '이전 질문', 0, { parentUuid: null });
    const rootAnswer = claude('assistant', text('이전 답'), 1, { parentUuid: root.uuid, stop_reason: 'end_turn' });
    const abandoned = claude('user', '목록 뽑는 방법?', 10, { parentUuid: rootAnswer.uuid });
    const abandonedAnswer = claude('assistant', text('버려진 답'), 11, { parentUuid: abandoned.uuid });
    const live = claude('user', '목록 뽑는 방법?', 14, { parentUuid: rootAnswer.uuid });
    const liveAnswer = claude('assistant', text('살아있는 답'), 16, { parentUuid: live.uuid, stop_reason: 'end_turn' });
    const raw = lines([root, rootAnswer, abandoned, abandonedAnswer, live, liveAnswer]);

    const first = extractClaudeTurn(raw, { prompt: '목록 뽑는 방법?', anchorAt: at(10) });
    expect(first.ok && first.turn.result).toBe('버려진 답');
    const second = extractClaudeTurn(raw, { prompt: '목록 뽑는 방법?', anchorAt: at(14) });
    expect(second.ok && second.turn.result).toBe('살아있는 답');
    // The earlier turn is not polluted by either attempt.
    const earlier = extractClaudeTurn(raw, { prompt: '이전 질문', anchorAt: at(0) });
    expect(earlier.ok && earlier.turn).toMatchObject({ result: '이전 답', completed: true });
  });

  test('a turn rewound away from (later prompts branch off before it) keeps its own answer', () => {
    const root = claude('user', '시작', 0, { parentUuid: null });
    const rootAnswer = claude('assistant', text('시작 답'), 1, { parentUuid: root.uuid, stop_reason: 'end_turn' });
    const rewound = claude('user', '나중에 되돌린 질문', 10, { parentUuid: rootAnswer.uuid });
    const rewoundAnswer = claude('assistant', text('되돌리기 전 받은 답'), 12, { parentUuid: rewound.uuid, stop_reason: 'end_turn' });
    const other = claude('user', '되돌린 뒤 새 질문', 30, { parentUuid: rootAnswer.uuid });
    const otherAnswer = claude('assistant', text('새 답'), 31, { parentUuid: other.uuid, stop_reason: 'end_turn' });
    const raw = lines([root, rootAnswer, rewound, rewoundAnswer, other, otherAnswer]);

    expect(extractClaudeTurn(raw, { prompt: '나중에 되돌린 질문', anchorAt: at(10) })).toEqual({
      ok: true,
      turn: { result: '되돌리기 전 받은 답', finalResult: '되돌리기 전 받은 답', completed: true, promptAt: at(10) },
    });
  });

  test('parallel tool branches are all collected and a parentUuid cycle does not hang', () => {
    const prompt = claude('user', '병렬 작업', 0, { parentUuid: null });
    const a1 = claude('assistant', [...text('두 개 동시에'), { type: 'tool_use', id: 't1', name: 'Read', input: {} }], 1, { parentUuid: prompt.uuid });
    const a2 = claude('assistant', [{ type: 'tool_use', id: 't2', name: 'Read', input: {} }], 1, { parentUuid: a1.uuid });
    const r1 = claude('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }], 2, { parentUuid: a1.uuid });
    const r2 = claude('user', [{ type: 'tool_result', tool_use_id: 't2', content: 'y' }], 2, { parentUuid: a2.uuid });
    const done = claude('assistant', text('합친 결론'), 3, { parentUuid: r2.uuid, stop_reason: 'end_turn' });
    // Observed in a real file: an attachment entry whose parent chain loops back.
    const loopA = { type: 'attachment', uuid: 'loopA', parentUuid: 'loopB', timestamp: at(4) };
    const loopB = { type: 'attachment', uuid: 'loopB', parentUuid: 'loopA', timestamp: at(4) };
    const raw = lines([prompt, a1, a2, r1, r2, done, loopA, { ...loopB, parentUuid: done.uuid }, { ...loopB }]);

    const extraction = extractClaudeTurn(raw, { prompt: '병렬 작업', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('두 개 동시에\n\n합친 결론');
  });

  // Observed: a background task notification delivered twice forked the turn
  // into two continuations under the same parent. Mixing both doubled the text.
  test('alternative continuations keep only the latest, not both', () => {
    const prompt = claude('user', '빌드 돌려줘', 0, { parentUuid: null });
    const started = claude('assistant', text('백그라운드로 빌드합니다'), 1, { parentUuid: prompt.uuid });
    const note1 = claude('user', '<task-notification>\n<task-id>b1</task-id>', 60, { parentUuid: started.uuid });
    const reply1 = claude('assistant', text('빌드가 끝났습니다 (첫 전달)'), 61, { parentUuid: note1.uuid, stop_reason: 'end_turn' });
    const note2 = claude('user', '<task-notification>\n<task-id>b1</task-id>', 1900, { parentUuid: started.uuid });
    const reply2 = claude('assistant', text('빌드가 끝났습니다 (재전달)'), 1901, { parentUuid: note2.uuid, stop_reason: 'end_turn' });
    const raw = lines([prompt, started, note1, reply1, note2, reply2]);

    const extraction = extractClaudeTurn(raw, { prompt: '빌드 돌려줘', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('백그라운드로 빌드합니다\n\n빌드가 끝났습니다 (재전달)');
  });

  // Observed: Claude Code hangs a background-task notification under the node
  // that launched the task, so one arriving after the NEXT prompt still sits in
  // this prompt's subtree. It belongs to the later turn.
  test('a late notification re-attached to an earlier node stays with the later turn', () => {
    const p1 = claude('user', '같은 피드백', 0, { parentUuid: null });
    const launch = claude('assistant', text('빌드를 백그라운드로 시작'), 1, { parentUuid: p1.uuid });
    const note1 = claude('user', '<task-notification>\n<task-id>b1</task-id>', 60, { parentUuid: launch.uuid });
    const p2 = claude('user', '같은 피드백', 61, { parentUuid: note1.uuid });
    const p2Answer = claude('assistant', text('다시 빌드 중'), 62, { parentUuid: p2.uuid });
    const late = claude('user', '<task-notification>\n<task-id>b1</task-id>', 1900, { parentUuid: launch.uuid });
    const lateAnswer = claude('assistant', text('## 빌드 결과: 성공'), 1901, { parentUuid: late.uuid, stop_reason: 'end_turn' });
    const raw = lines([p1, launch, note1, p2, p2Answer, late, lateAnswer]);

    const first = extractClaudeTurn(raw, { prompt: '같은 피드백', anchorAt: at(0) });
    expect(first.ok && first.turn).toMatchObject({ result: '빌드를 백그라운드로 시작', completed: true });
  });

  test('the branch walk crosses a compact boundary via logicalParentUuid', () => {
    const prompt = claude('user', '긴 작업', 0, { parentUuid: null });
    const before = claude('assistant', text('압축 전 답변'), 5, { parentUuid: prompt.uuid });
    const boundary = { type: 'system', subtype: 'compact_boundary', uuid: 'cb', parentUuid: null, logicalParentUuid: before.uuid, timestamp: at(6) };
    const summary = claude('user', 'This session is being continued…', 6, { parentUuid: 'cb', isCompactSummary: true });
    const after = claude('assistant', text('압축 후 답변'), 8, { parentUuid: summary.uuid, stop_reason: 'end_turn' });
    const raw = lines([prompt, before, boundary, summary, after]);

    const extraction = extractClaudeTurn(raw, { prompt: '긴 작업', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('압축 전 답변\n\n압축 후 답변');
  });

  test('picks the copy of a re-sent prompt nearest the anchor', () => {
    const raw = lines(chain([
      claude('user', '같은 프롬프트', 0),
      claude('assistant', text('첫 시도 답'), 1, { stop_reason: 'end_turn' }),
      claude('user', '같은 프롬프트', 600),
      claude('assistant', text('재시도 답'), 601, { stop_reason: 'end_turn' }),
    ]));

    const extraction = extractClaudeTurn(raw, { prompt: '같은 프롬프트', anchorAt: at(598) });
    expect(extraction.ok && extraction.turn.result).toBe('재시도 답');
  });

  // The failed-resume case from the live board: the dispatch never reached the
  // CLI, the user kept talking in the session, and a time-only match would have
  // pasted that unrelated conversation onto the card.
  test('a prompt that never reached the session is not found, even with later activity', () => {
    const raw = lines(chain([
      claude('user', '터미널에서 직접 이어간 질문', 30),
      claude('assistant', text('다른 대화'), 31, { stop_reason: 'end_turn' }),
    ]));

    expect(extractClaudeTurn(raw, { prompt: '[Feedback for: …] 카드 프롬프트', anchorAt: at(0) }))
      .toEqual({ ok: false, reason: 'prompt_not_found' });
  });

  test('a matching prompt far outside the anchor window is rejected', () => {
    const raw = lines(chain([
      claude('user', '반복 프롬프트', 0),
      claude('assistant', text('한 시간 전 답'), 1, { stop_reason: 'end_turn' }),
    ]));

    expect(extractClaudeTurn(raw, { prompt: '반복 프롬프트', anchorAt: at(3600) }))
      .toEqual({ ok: false, reason: 'prompt_not_found' });
  });

  test('a turn cut off mid-way reports completed=false but still returns its text', () => {
    const raw = lines(chain([
      claude('user', '오래 걸리는 작업', 0),
      claude('assistant', [...text('1단계 완료'), { type: 'tool_use', id: 't', name: 'Bash', input: {} }], 3, { stop_reason: 'tool_use' }),
    ]));

    expect(extractClaudeTurn(raw, { prompt: '오래 걸리는 작업', anchorAt: at(0) })).toEqual({
      ok: true,
      turn: { result: '1단계 완료', finalResult: '1단계 완료', completed: false, promptAt: at(0) },
    });
  });

  test('a user interrupt marks the turn incomplete and is not a boundary', () => {
    const raw = lines(chain([
      claude('user', '중단될 작업', 0),
      claude('assistant', text('진행 중'), 2),
      claude('user', text('[Request interrupted by user]'), 4),
    ]));

    const extraction = extractClaudeTurn(raw, { prompt: '중단될 작업', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.completed).toBe(false);
  });

  test('matches with surrounding whitespace trimmed, and reports an empty turn', () => {
    const raw = lines(chain([claude('user', '  답 없는 질문\n', 0)]));
    expect(extractClaudeTurn(raw, { prompt: '답 없는 질문', anchorAt: at(0) }))
      .toEqual({ ok: false, reason: 'empty_turn' });
  });
});

function rollout(type: string, payload: Record<string, unknown>, seconds: number) {
  return { timestamp: at(seconds), type, payload };
}
const userMsg = (value: string, seconds: number) =>
  rollout('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] }, seconds);
const assistantMsg = (value: string, seconds: number) =>
  rollout('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: value }] }, seconds);

describe('extractCodexTurn', () => {
  test('locates the turn between task_started and task_complete', () => {
    const raw = lines([
      rollout('session_meta', { id: 's' }, 0),
      rollout('event_msg', { type: 'task_started' }, 0),
      userMsg('# AGENTS.md instructions for /repo\n<INSTRUCTIONS>…', 1),
      userMsg('<environment_context>\n  <cwd>/repo</cwd>', 1),
      userMsg('첫 질문', 1),
      assistantMsg('첫 답', 3),
      rollout('event_msg', { type: 'task_complete', last_agent_message: '첫 답' }, 4),
      rollout('event_msg', { type: 'task_started' }, 20),
      userMsg('두 번째 질문', 20),
      rollout('event_msg', { type: 'item_completed', item: { type: 'AgentMessage' } }, 22),
      assistantMsg('확인 중입니다', 22),
      assistantMsg('최종 답', 25),
      rollout('event_msg', { type: 'task_complete', last_agent_message: '최종 답' }, 26),
    ]);

    expect(extractCodexTurn(raw, { prompt: '두 번째 질문', anchorAt: at(19) })).toEqual({
      ok: true,
      turn: { result: '확인 중입니다\n\n최종 답', finalResult: '최종 답', completed: true, promptAt: at(20) },
    });
  });

  // Messages typed while a task runs join the SAME task, but each minted its
  // own card — every card gets only the text that answered it.
  test('prompts sent mid-task each get their own slice', () => {
    const raw = lines([
      rollout('event_msg', { type: 'task_started' }, 0),
      userMsg('작업 시작해', 0),
      assistantMsg('작업을 시작합니다', 2),
      userMsg('자꾸 막히는데 왜 막히는거야', 30),
      assistantMsg('권한 문제였습니다', 32),
      userMsg('진행해.', 40),
      assistantMsg('완료했습니다', 50),
      rollout('event_msg', { type: 'task_complete', last_agent_message: '완료했습니다' }, 51),
    ]);

    const first = extractCodexTurn(raw, { prompt: '작업 시작해', anchorAt: at(0) });
    expect(first.ok && first.turn).toMatchObject({ result: '작업을 시작합니다', completed: true });
    const middle = extractCodexTurn(raw, { prompt: '자꾸 막히는데 왜 막히는거야', anchorAt: at(30) });
    expect(middle.ok && middle.turn.result).toBe('권한 문제였습니다');
    const last = extractCodexTurn(raw, { prompt: '진행해.', anchorAt: at(40) });
    expect(last.ok && last.turn).toMatchObject({ result: '완료했습니다', finalResult: '완료했습니다', completed: true });
  });

  test('a skill body injected mid-task is not a prompt boundary', () => {
    const raw = lines([
      rollout('event_msg', { type: 'task_started' }, 0),
      userMsg('스킬로 처리해줘', 0),
      assistantMsg('스킬을 읽습니다', 1),
      userMsg('<skill>\n<name>verify</name>\n…', 2),
      assistantMsg('검증 완료', 5),
      rollout('event_msg', { type: 'task_complete' }, 6),
    ]);
    const extraction = extractCodexTurn(raw, { prompt: '스킬로 처리해줘', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('스킬을 읽습니다\n\n검증 완료');
  });

  test('a turn with task_started but no task_complete is incomplete', () => {
    const raw = lines([
      rollout('event_msg', { type: 'task_started' }, 0),
      userMsg('끊긴 질문', 1),
      assistantMsg('중간 답', 3),
    ]);

    const extraction = extractCodexTurn(raw, { prompt: '끊긴 질문', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn).toEqual({ result: '중간 답', finalResult: '중간 답', completed: false, promptAt: at(1) });
  });

  test('without task events, a turn starts at the first user message after a reply', () => {
    const raw = lines([
      userMsg('# AGENTS.md instructions for /repo', 0),
      userMsg('첫 질문', 0),
      assistantMsg('첫 답', 2),
      userMsg('두 번째 질문', 10),
      assistantMsg('두 번째 답', 12),
    ]);

    const first = extractCodexTurn(raw, { prompt: '첫 질문', anchorAt: at(0) });
    expect(first.ok && first.turn).toEqual({ result: '첫 답', finalResult: '첫 답', completed: true, promptAt: at(0) });
    const second = extractCodexTurn(raw, { prompt: '두 번째 질문', anchorAt: at(10) });
    expect(second.ok && second.turn.completed).toBe(false);
  });

  test('falls back to task_complete.last_agent_message when no assistant message was recorded', () => {
    const raw = lines([
      rollout('event_msg', { type: 'task_started' }, 0),
      userMsg('질문', 0),
      rollout('event_msg', { type: 'task_complete', last_agent_message: '마지막 답' }, 3),
    ]);
    const extraction = extractCodexTurn(raw, { prompt: '질문', anchorAt: at(0) });
    expect(extraction.ok && extraction.turn.result).toBe('마지막 답');
  });

  test('the turn whose prompt never arrived (task_started only) is not found', () => {
    const raw = lines([
      rollout('event_msg', { type: 'task_started' }, 0),
      userMsg('이전 질문', 0),
      assistantMsg('이전 답', 2),
      rollout('event_msg', { type: 'task_complete' }, 3),
      rollout('event_msg', { type: 'task_started' }, 60),
    ]);
    expect(extractCodexTurn(raw, { prompt: '[Feedback for: …] 새 질문', anchorAt: at(60) }))
      .toEqual({ ok: false, reason: 'prompt_not_found' });
  });
});

describe('extractRunEventsTurn', () => {
  test('re-accumulates a claude stream-json run', () => {
    const raw = lines([
      { type: 'system', subtype: 'init', session_id: 's' },
      { type: 'assistant', message: { content: text('중간 답') } },
      { type: 'assistant', message: { content: text('최종 답') } },
      { type: 'result', result: '최종 답' },
    ]);
    expect(extractRunEventsTurn(raw, 'claude')).toEqual({
      ok: true,
      turn: { result: '중간 답\n\n최종 답', finalResult: '최종 답', completed: true, promptAt: undefined },
    });
  });

  test('re-accumulates a codex exec --json run cut off before turn.completed', () => {
    const raw = lines([
      { type: 'thread.started', thread_id: 't' },
      { type: 'item.completed', item: { type: 'agent_message', text: '부분 답' } },
    ]);
    const extraction = extractRunEventsTurn(raw, 'codex');
    expect(extraction.ok && extraction.turn).toEqual({ result: '부분 답', finalResult: '부분 답', completed: false, promptAt: undefined });
  });
});
