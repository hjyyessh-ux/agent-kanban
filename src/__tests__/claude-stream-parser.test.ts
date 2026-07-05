import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { parseClaudeStreamLine } from '../plugin/runtimes/claude-stream-parser';

describe('parseClaudeStreamLine', () => {
  // ── existing paths (regression) ────────────────────────────────────────────

  test('extracts session_id from system init', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-1',
    }));

    expect(event).toEqual({
      type: 'system',
      subtype: 'init',
      sessionId: 'claude-session-1',
    });
  });

  test('extracts assistant text and result text', () => {
    const assistant = parseClaudeStreamLine(JSON.stringify({
      type: 'assistant',
      message: { id: 'msg-1', content: [{ type: 'text', text: 'hello' }] },
    }));
    const result = parseClaudeStreamLine(JSON.stringify({
      type: 'result',
      result: 'final',
      session_id: 'claude-session-1',
      total_cost_usd: 0.1,
    }));

    expect(assistant).toEqual({
      type: 'assistant',
      text: 'hello',
      messageId: 'msg-1',
    });
    expect(result).toEqual({
      type: 'result',
      result: 'final',
      sessionId: 'claude-session-1',
      totalCostUsd: 0.1,
    });
  });

  test('invalid JSON returns null', () => {
    expect(parseClaudeStreamLine('not-json')).toBeNull();
  });

  test('unknown system subtype returns unknown', () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'hook_started' }))).toEqual({ type: 'unknown' });
    expect(parseClaudeStreamLine(JSON.stringify({ type: 'system', subtype: 'thinking_tokens' }))).toEqual({ type: 'unknown' });
  });

  // ── subagent events ─────────────────────────────────────────────────────────

  test('task_started → subagent_started', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'system',
      subtype: 'task_started',
      task_id: 'task-abc',
      tool_use_id: 'toolu-xyz',
      subagent_type: 'general-purpose',
      description: 'do work',
      prompt: 'do it now',
      session_id: 'sess-1',
    }));

    expect(event).toEqual({
      type: 'subagent_started',
      taskId: 'task-abc',
      toolUseId: 'toolu-xyz',
      agentType: 'general-purpose',
      description: 'do work',
      prompt: 'do it now',
      sessionId: 'sess-1',
    });
  });

  test('task_updated → subagent_updated', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'task-abc',
      patch: { status: 'completed', end_time: 1782615238346 },
      session_id: 'sess-1',
    }));

    expect(event).toEqual({
      type: 'subagent_updated',
      taskId: 'task-abc',
      status: 'completed',
      endTime: 1782615238346,
      sessionId: 'sess-1',
    });
  });

  test('task_notification → subagent_completed', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-abc',
      tool_use_id: 'toolu-xyz',
      status: 'completed',
      output_file: '',
      summary: 'done',
      usage: { total_tokens: 100, tool_uses: 0, duration_ms: 500 },
      session_id: 'sess-1',
    }));

    expect(event).toEqual({
      type: 'subagent_completed',
      taskId: 'task-abc',
      toolUseId: 'toolu-xyz',
      summary: 'done',
      outputFile: '',
      usage: { totalTokens: 100, durationMs: 500 },
      sessionId: 'sess-1',
    });
  });

  test('task_notification without usage → usage undefined', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'task-abc',
      status: 'completed',
    }));

    expect(event).toMatchObject({ type: 'subagent_completed', taskId: 'task-abc' });
    expect((event as { usage?: unknown }).usage).toBeUndefined();
  });

  // ── regression: user messages never become subagent events ─────────────────

  test('user message with parent_tool_use_id → unknown (not subagent_message)', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'PONG' }] },
      parent_tool_use_id: 'toolu-xyz',
      session_id: 'sess-1',
    }));

    expect(event).toEqual({ type: 'unknown' });
  });

  test('user tool_result message → unknown', () => {
    const event = parseClaudeStreamLine(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ tool_use_id: 'toolu-xyz', type: 'tool_result', content: [{ type: 'text', text: 'PONG' }] }] },
      session_id: 'sess-1',
    }));

    expect(event).toEqual({ type: 'unknown' });
  });

  // ── fixture-based table test (claude 2.1.195 smoke capture) ────────────────

  test('fixture: key lines parsed correctly', () => {
    const fixturePath = resolve(import.meta.dir, './fixtures/claude-task-stream-2.1.195.jsonl');
    const lines = readFileSync(fixturePath, 'utf-8').trim().split('\n');

    // line 42 (index 41) — task_started
    expect(parseClaudeStreamLine(lines[41])).toMatchObject({
      type: 'subagent_started',
      taskId: 'a6419ba278a83071e',
      toolUseId: 'toolu_018VN1vbznurtuvitS7XiuHP',
      agentType: 'general-purpose',
      sessionId: 'aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4',
    });

    // line 43 (index 42) — user message with parent_tool_use_id → must stay unknown
    expect(parseClaudeStreamLine(lines[42])).toEqual({ type: 'unknown' });

    // line 44 (index 43) — task_updated
    expect(parseClaudeStreamLine(lines[43])).toMatchObject({
      type: 'subagent_updated',
      taskId: 'a6419ba278a83071e',
      status: 'completed',
      endTime: 1782615238346,
      sessionId: 'aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4',
    });

    // line 45 (index 44) — task_notification
    expect(parseClaudeStreamLine(lines[44])).toMatchObject({
      type: 'subagent_completed',
      taskId: 'a6419ba278a83071e',
      toolUseId: 'toolu_018VN1vbznurtuvitS7XiuHP',
      summary: 'Reply with exactly PONG',
      usage: { totalTokens: 19881, durationMs: 1306 },
      sessionId: 'aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4',
    });

    // line 11 (index 10) — system init
    expect(parseClaudeStreamLine(lines[10])).toMatchObject({
      type: 'system',
      subtype: 'init',
      sessionId: 'aa0b8f03-fe7a-40cb-b1b9-47091e10cfb4',
    });

    // no line in fixture crashes the parser
    for (const line of lines) {
      expect(() => parseClaudeStreamLine(line)).not.toThrow();
    }
  });
});
