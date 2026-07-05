import { describe, expect, test } from 'bun:test';
import { parseCodexJsonlLine } from '../plugin/runtimes/codex-jsonl-parser';

describe('Codex JSONL parser', () => {
  test('extracts thread_id from thread.started event', () => {
    const event = parseCodexJsonlLine(JSON.stringify({
      type: 'thread.started',
      thread_id: 'thread-123',
    }));

    expect(event).toEqual({ type: 'thread_started', threadId: 'thread-123' });
  });

  test('extracts thread_id from thread/started method event', () => {
    const event = parseCodexJsonlLine(JSON.stringify({
      method: 'thread/started',
      params: { thread_id: 'thread-method-123' },
    }));

    expect(event).toEqual({ type: 'thread_started', threadId: 'thread-method-123' });
  });

  test('extracts assistant text as fallback result', () => {
    const event = parseCodexJsonlLine(JSON.stringify({
      type: 'item.completed',
      item: {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
      },
    }));

    expect(event).toEqual({ type: 'agent_message', text: 'final answer' });
  });

  test('ignores malformed JSONL lines', () => {
    expect(parseCodexJsonlLine('{not-json')).toBeNull();
  });
});
