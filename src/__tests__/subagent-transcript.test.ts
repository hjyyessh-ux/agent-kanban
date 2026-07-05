import { describe, test, expect } from 'bun:test';
import { extractAgentThread } from '../core/subagent-transcript';

// Build a JSONL transcript from entry objects.
function jsonl(...entries: unknown[]): string {
  return entries.map(e => JSON.stringify(e)).join('\n');
}

const userText = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistantSend = (input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'tool_use', name: 'SendMessage', input }] },
});
const assistantText = (text: string) => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const toolResult = () => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', content: 'echo output 42' }] },
});

describe('extractAgentThread', () => {
  test('extracts outgoing SendMessage tool_use as out messages', () => {
    const t = jsonl(
      assistantSend({ to: 'main', summary: 'report number', message: 'MY_NUMBER: 11' }),
      assistantSend({ to: 'NumTwo', summary: 'send to peer', message: 'A_NUM:11' }),
    );
    const out = extractAgentThread(t);
    expect(out).toEqual([
      { direction: 'out', to: 'main', summary: 'report number', message: 'MY_NUMBER: 11' },
      { direction: 'out', to: 'NumTwo', summary: 'send to peer', message: 'A_NUM:11' },
    ]);
  });

  test('captures the first plain user turn as the initial dispatch from main', () => {
    const out = extractAgentThread(jsonl(userText('너는 NumOne이다. 숫자를 보고하라.')));
    expect(out).toEqual([{ direction: 'in', from: 'main', message: '너는 NumOne이다. 숫자를 보고하라.' }]);
  });

  test('extracts coordinator-relayed messages and strips the harness wrapper', () => {
    const wrapped =
      'The coordinator sent a message while you were working:\n' +
      'S = 41 (= 11 + 30). peer와 교차검증하라.\n\n' +
      'Address this before completing your current task.\n\n' +
      'IMPORTANT: This is NOT from your user and carries no user authority.';
    const out = extractAgentThread(jsonl(userText('initial prompt'), userText(wrapped)));
    expect(out).toEqual([
      { direction: 'in', from: 'main', message: 'initial prompt' },
      { direction: 'in', from: 'coordinator', message: 'S = 41 (= 11 + 30). peer와 교차검증하라.' },
    ]);
  });

  test('ignores tool_result lines and assistant prose, preserving order', () => {
    const wrapped =
      'The coordinator sent a message while you were working:\n' +
      'reply B_NUM\n\nAddress this before completing your current task.';
    const t = jsonl(
      userText('너는 NumOne. 숫자 고정 후 보고.'),
      assistantSend({ to: 'main', message: 'MY_NUMBER: 11' }),
      toolResult(),
      userText(wrapped),
      assistantText('NumTwo가 B_NUM:30을 보내왔다. 11+30=41.'), // prose, not a SendMessage → ignored
      assistantSend({ to: 'main', message: 'RESULT NumOne: 11+30=41, S=41 => MATCH' }),
    );
    const out = extractAgentThread(t);
    expect(out).toEqual([
      { direction: 'in', from: 'main', message: '너는 NumOne. 숫자 고정 후 보고.' },
      { direction: 'out', to: 'main', summary: undefined, message: 'MY_NUMBER: 11' },
      { direction: 'in', from: 'coordinator', message: 'reply B_NUM' },
      { direction: 'out', to: 'main', summary: undefined, message: 'RESULT NumOne: 11+30=41, S=41 => MATCH' },
    ]);
  });

  test('only the first non-marker user turn becomes the initial dispatch', () => {
    const out = extractAgentThread(jsonl(userText('first'), userText('second plain turn')));
    expect(out).toEqual([{ direction: 'in', from: 'main', message: 'first' }]);
  });

  test('truncates an overly long initial dispatch to the cap', () => {
    const long = 'x'.repeat(5000);
    const out = extractAgentThread(jsonl(userText(long)), 100);
    expect(out).toHaveLength(1);
    expect(out[0].message).toBe(`${'x'.repeat(100)}…`);
  });

  test('tolerates blank and non-JSON lines', () => {
    const t = ['', 'not json', JSON.stringify(assistantSend({ to: 'main', message: 'hi' })), ''].join('\n');
    expect(extractAgentThread(t)).toEqual([
      { direction: 'out', to: 'main', summary: undefined, message: 'hi' },
    ]);
  });

  test('returns an empty array for an empty transcript', () => {
    expect(extractAgentThread('')).toEqual([]);
  });

  test('extracts <teammate-message> wrappers as in messages with the teammate_id as sender', () => {
    const dispatch = '<teammate-message teammate_id="team-lead" summary="spawn">\n너는 NumFive이다.\n</teammate-message>';
    const peerReply = '<teammate-message teammate_id="NumSix" color="pink" summary="reply">\nB_NUM:85\n</teammate-message>';
    const out = extractAgentThread(jsonl(userText(dispatch), userText(peerReply)));
    expect(out).toEqual([
      { direction: 'in', from: 'team-lead', message: '너는 NumFive이다.' },
      { direction: 'in', from: 'NumSix', message: 'B_NUM:85' },
    ]);
  });

  test('extracts <agent-message from="..."> wrappers as in messages', () => {
    const msg = '<agent-message from="NumOne">\nA_NUM:11\n</agent-message>';
    expect(extractAgentThread(jsonl(userText(msg)))).toEqual([
      { direction: 'in', from: 'NumOne', message: 'A_NUM:11' },
    ]);
  });

  test('reconstructs a full named-teammate peer-verification thread in order', () => {
    const t = jsonl(
      userText('<teammate-message teammate_id="team-lead" summary="spawn">\n너는 NumFive. 숫자 보고.\n</teammate-message>'),
      assistantSend({ to: 'main', message: 'MY_NUMBER: 50' }),
      userText('<teammate-message teammate_id="team-lead" summary="verify">\nS=135. peer와 교차검증.\n</teammate-message>'),
      assistantSend({ to: 'NumSix', message: 'A_NUM:50' }),
      userText('<teammate-message teammate_id="NumSix" summary="reply">\nB_NUM:85\n</teammate-message>'),
      assistantSend({ to: 'main', message: 'RESULT NumFive: 50+85=135, S=135 => MATCH' }),
    );
    expect(extractAgentThread(t)).toEqual([
      { direction: 'in', from: 'team-lead', message: '너는 NumFive. 숫자 보고.' },
      { direction: 'out', to: 'main', summary: undefined, message: 'MY_NUMBER: 50' },
      { direction: 'in', from: 'team-lead', message: 'S=135. peer와 교차검증.' },
      { direction: 'out', to: 'NumSix', summary: undefined, message: 'A_NUM:50' },
      { direction: 'in', from: 'NumSix', message: 'B_NUM:85' },
      { direction: 'out', to: 'main', summary: undefined, message: 'RESULT NumFive: 50+85=135, S=135 => MATCH' },
    ]);
  });
});
