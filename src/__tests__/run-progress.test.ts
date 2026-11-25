import { describe, test, expect } from 'bun:test';
import { buildRunProgress, buildTranscriptProgress, stampCommandStartReceipt } from '../plugin/runtimes/run-progress';
import type { RuntimeRun } from '../plugin/runtimes/runtime-run-store';

function makeRun(overrides: Partial<RuntimeRun> = {}): RuntimeRun {
  return {
    runId: 'claude-123-abc',
    cardId: 'card-1',
    runtime: 'claude',
    status: 'running',
    startedAt: '2026-07-03T00:00:00.000Z',
    cwd: '/tmp',
    promptPath: '/tmp/prompt.md',
    eventsPath: '/tmp/events.jsonl',
    stderrPath: '/tmp/stderr.log',
    lastMessagePath: '/tmp/last-message.md',
    ...overrides,
  };
}

function assistantToolUse(name: string, input: Record<string, unknown> = {}, id?: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
}

describe('buildRunProgress — claude stream', () => {
  test('maps tool_use and task_started events to ordered steps with kinds', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1' }),
      assistantToolUse('Skill', { skill: 'pr-review' }),
      assistantToolUse('mcp__playwright__browser_click', { element: 'x' }),
      assistantToolUse('Bash', { command: 'bun test src/__tests__/foo.test.ts' }),
      assistantToolUse('Read', { file_path: '/Users/u/.claude/projects/p/memory/obsidian-doc-path.md' }),
      assistantToolUse('Read', { file_path: '/repo/src/app.ts' }),
      JSON.stringify({
        type: 'system', subtype: 'task_started', task_id: 't1',
        task_type: 'local_agent', subagent_type: 'Explore', description: 'find stuff',
      }),
      JSON.stringify({ type: 'result', result: 'done' }),
    ];

    const progress = buildRunProgress(makeRun(), lines);

    expect(progress.runId).toBe('claude-123-abc');
    expect(progress.source).toBe('run');
    expect(progress.runtime).toBe('claude');
    expect(progress.runStatus).toBe('running');
    expect(progress.totalSteps).toBe(6);
    expect(progress.steps.map(s => s.kind)).toEqual([
      'skill', 'mcp', 'command', 'memory', 'tool', 'agent',
    ]);
    expect(progress.steps[0].label).toBe('pr-review');
    expect(progress.steps[1].label).toBe('playwright · browser_click');
    expect(progress.steps[2].detail).toBe('bun test src/__tests__/foo.test.ts');
    expect(progress.steps[3].label).toBe('memory/obsidian-doc-path.md');
    expect(progress.steps[4].label).toBe('Read');
    expect(progress.steps[4].detail).toBe('/repo/src/app.ts');
    expect(progress.steps[5].label).toBe('Explore');

    expect(progress.summary.skills).toEqual(['pr-review']);
    expect(progress.summary.mcpServers).toEqual(['playwright']);
    expect(progress.summary.agents).toEqual(['Explore']);
    expect(progress.summary.memory).toEqual(['memory/obsidian-doc-path.md']);
    expect(progress.summary.tools).toEqual(['Bash', 'Read']);
  });

  test('skips local_bash task_started, Task tool_use, text parts, and malformed lines', () => {
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'task_started', task_id: 't2', task_type: 'local_bash' }),
      assistantToolUse('Task', { subagent_type: 'Explore', prompt: 'dup of task_started' }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } }),
      'not json at all',
      '',
    ];

    const progress = buildRunProgress(makeRun(), lines);
    expect(progress.steps).toEqual([]);
    expect(progress.totalSteps).toBe(0);
  });

  test('attaches expandable bodies: edit diff, write content, long commands', () => {
    const longCommand = `echo ${'y'.repeat(300)}`;
    const lines = [
      assistantToolUse('Edit', { file_path: '/repo/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' }),
      assistantToolUse('Write', { file_path: '/repo/b.ts', content: 'export const b = 3;' }),
      assistantToolUse('Bash', { command: 'ls' }),
      assistantToolUse('Bash', { command: longCommand }),
    ];

    const progress = buildRunProgress(makeRun(), lines);

    expect(progress.steps[0].detail).toBe('/repo/a.ts');
    expect(progress.steps[0].body).toBe('- const a = 1;\n+ const a = 2;');
    expect(progress.steps[1].body).toBe('export const b = 3;');
    expect(progress.steps[2].body).toBe('ls');
    expect(progress.steps[3].body).toBe(longCommand);
  });

  test('preserves every step and the full tool detail and body', () => {
    const longCommand = 'x'.repeat(500);
    const longContent = `${'content\n'.repeat(1_000)}WRITE-END`;
    const lines = [
      assistantToolUse('Bash', { command: longCommand }),
      assistantToolUse('Write', { file_path: '/f/full.txt', content: longContent }),
      ...Array.from({ length: 450 }, (_, i) => assistantToolUse('Read', { file_path: `/f/${i}.ts` })),
    ];

    const progress = buildRunProgress(makeRun(), lines);
    expect(progress.totalSteps).toBe(452);
    expect(progress.steps.length).toBe(452);
    expect(progress.steps[0].detail).toBe(longCommand);
    expect(progress.steps[0].body).toBe(longCommand);
    expect(progress.steps[1].body).toBe(longContent);
    expect(progress.steps[progress.steps.length - 1].detail).toBe('/f/449.ts');
  });
});

describe('buildTranscriptProgress — interactive session transcript', () => {
  test('maps Task tool_use to agent steps and stamps transcript metadata', () => {
    const lines = [
      assistantToolUse('Task', { subagent_type: 'Explore', description: 'scan repo', prompt: 'Find all routes' }),
      assistantToolUse('Bash', { command: 'git status' }),
    ];

    const progress = buildTranscriptProgress(
      { sessionId: 'sess-1', status: 'in_progress', startedAt: '2026-07-03T01:00:00.000Z', createdAt: '2026-07-03T00:59:00.000Z' },
      lines,
    );

    expect(progress.runId).toBe('session-sess-1');
    expect(progress.source).toBe('transcript');
    expect(progress.runStatus).toBe('running');
    expect(progress.startedAt).toBe('2026-07-03T01:00:00.000Z');
    expect(progress.steps.map(s => s.kind)).toEqual(['agent', 'command']);
    expect(progress.steps[0].label).toBe('Explore');
    expect(progress.steps[0].detail).toBe('scan repo');
    expect(progress.steps[0].body).toBe('Find all routes');
    expect(progress.summary.agents).toEqual(['Explore']);
  });
});

describe('buildRunProgress — codex stream', () => {
  test('maps item.completed events and ignores item.started', () => {
    const lines = [
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls -la' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'file_change' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'github', tool: 'create_issue' } }),
    ];

    const progress = buildRunProgress(makeRun({ runtime: 'codex', status: 'completed', finishedAt: '2026-07-03T00:05:00.000Z' }), lines);

    expect(progress.finishedAt).toBe('2026-07-03T00:05:00.000Z');
    expect(progress.steps.map(s => s.kind)).toEqual(['command', 'tool', 'mcp']);
    expect(progress.steps[0].detail).toBe('ls -la');
    expect(progress.steps[2].label).toBe('github · create_issue');
    expect(progress.summary.mcpServers).toEqual(['github']);
  });
});

describe('buildTranscriptProgress — codex rollout', () => {
  /**
   * The rollout envelope, not `codex exec --json`. Two different wire formats
   * for the same facts: the board dispatch path writes exec events into the
   * run's events.jsonl, while the interactive CLI leaves this behind under
   * `~/.codex/sessions/`. Item types are PascalCase here, snake_case there.
   */
  function rolloutItem(item: Record<string, unknown>): string {
    return JSON.stringify({
      timestamp: '2026-09-15T00:00:00.000Z',
      type: 'event_msg',
      payload: { type: 'item_completed', item },
    });
  }

  const card = {
    sessionId: '01a0a24a-8199-7c20-b854-daac29961c07',
    status: 'complete' as const,
    startedAt: '2026-09-15T00:00:00.000Z',
    createdAt: '2026-09-15T00:00:00.000Z',
  };

  test('maps rollout items to ordered steps and reports the codex runtime', () => {
    const lines = [
      JSON.stringify({ type: 'session_meta', payload: { session_id: card.sessionId } }),
      rolloutItem({ type: 'UserMessage', content: [{ type: 'text', text: 'PR 리뷰해줘' }] }),
      rolloutItem({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'bun test src/foo.test.ts'] }),
      rolloutItem({ type: 'FileChange', changes: { '/repo/a.kt': { type: 'add' } } }),
      rolloutItem({ type: 'McpToolCall', server: 'cua_repl', tool: 'js' }),
      rolloutItem({ type: 'SubAgentActivity', kind: 'started', agent_path: '/root/context_design' }),
      rolloutItem({ type: 'SubAgentActivity', kind: 'completed', agent_path: '/root/context_design' }),
      rolloutItem({ type: 'Extension', kind: 'web.search', query: 'codex rollout format' }),
      // Reasoning carries no user-visible action — it must not become a step.
      rolloutItem({ type: 'Reasoning', summary_text: [], raw_content: [] }),
      'not json at all',
      '',
    ];

    const progress = buildTranscriptProgress(card, lines, 'codex');

    expect(progress.runtime).toBe('codex');
    expect(progress.source).toBe('transcript');
    expect(progress.runStatus).toBe('completed');
    expect(progress.steps.map((s) => [s.kind, s.label])).toEqual([
      ['command', 'Shell'],
      ['tool', 'Edit'],
      ['mcp', 'cua_repl · js'],
      ['agent', 'root/context_design'],
      ['tool', 'web.search'],
    ]);
    expect(progress.totalSteps).toBe(5);
    expect(progress.steps[0].body).toBe('bun test src/foo.test.ts');
    expect(progress.summary.mcpServers).toEqual(['cua_repl']);
    expect(progress.summary.agents).toEqual(['root/context_design']);
  });

  test('a subagent that started twice is not counted twice per start/stop pair', () => {
    const lines = [
      rolloutItem({ type: 'SubAgentActivity', kind: 'started', agent_path: '/root/a' }),
      rolloutItem({ type: 'SubAgentActivity', kind: 'failed', agent_path: '/root/a' }),
      rolloutItem({ type: 'SubAgentActivity', kind: 'completed', agent_path: '/root/a' }),
    ];

    expect(buildTranscriptProgress(card, lines, 'codex').steps).toHaveLength(1);
  });

  // The regression that makes the two parsers worth keeping apart: exec-format
  // lines through the rollout parser (and vice versa) yield zero steps rather
  // than an error, so a wrong `format` argument fails silently.
  test('exec-format lines yield nothing through the rollout parser', () => {
    const execLine = JSON.stringify({
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls' },
    });

    expect(buildTranscriptProgress(card, [execLine], 'codex').steps).toHaveLength(0);
    expect(buildTranscriptProgress(card, [rolloutItem({ type: 'CommandExecution', command: ['ls'] })]).steps)
      .toHaveLength(0);
  });

  test('defaults to the claude parser when no format is given', () => {
    const progress = buildTranscriptProgress(card, []);
    expect(progress.runtime).toBe('claude');
  });
});

describe('command start observations', () => {
  const first = '2026-07-03T14:59:59.000Z';
  const second = '2026-07-03T15:00:02.000Z';

  test('pairs Claude Bash requests and actual task starts by tool ID in either order', () => {
    const start = stampCommandStartReceipt(JSON.stringify({
      type: 'system', subtype: 'task_started', task_type: 'local_bash', tool_use_id: 'bash-1', is_backgrounded: true,
    }), 'claude', first);
    const command = 'printf a && sleep 30';
    const request = assistantToolUse('Bash', { command, run_in_background: true }, 'bash-1');
    const finish = JSON.stringify({
      type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bash-1', content: 'ok' }] },
    });
    expect(buildRunProgress(makeRun(), [start]).steps).toEqual([
      { kind: 'command', label: 'Bash', commandStartedAt: first },
    ]);
    expect(buildRunProgress(makeRun(), [request]).steps[0].commandStartedAt).toBeUndefined();
    for (const lines of [[start, request, finish], [request, start, finish]]) {
      expect(buildRunProgress(makeRun(), [...lines, request]).steps).toEqual([
        { kind: 'command', label: 'Bash', detail: command, body: command, commandStartedAt: first },
      ]);
    }
  });

  test('uses only a Claude transcript task-start timestamp', () => {
    const card = { status: 'in_progress' as const, createdAt: first };
    const request = assistantToolUse('Bash', { command: 'sleep 30' }, 'bash-1');
    const withTime = (line: string) => JSON.stringify({ ...JSON.parse(line), timestamp: '2026-07-04T00:00:02+09:00' });
    const progress = withTime(JSON.stringify({ type: 'tool_progress', tool_name: 'Bash', tool_use_id: 'bash-1' }));
    expect(buildTranscriptProgress(card, [withTime(request), progress]).steps[0].commandStartedAt).toBeUndefined();
    const task = {
      type: 'system', subtype: 'task_started', task_type: 'local_bash', tool_use_id: 'bash-1',
    };
    const foreground = withTime(JSON.stringify({ ...task, is_backgrounded: false }));
    expect(buildTranscriptProgress(card, [request, foreground]).steps[0].commandStartedAt).toBeUndefined();
    const ambient = withTime(JSON.stringify({ ...task, is_backgrounded: true, ambient: true }));
    expect(buildTranscriptProgress(card, [request, ambient]).steps[0].commandStartedAt).toBeUndefined();
    const start = withTime(JSON.stringify({ ...task, is_backgrounded: true }));
    expect(buildTranscriptProgress(card, [start, request]).steps[0].commandStartedAt).toBe(second);
  });

  test('shows Codex concurrent starts immediately and merges late and duplicate events by ID', () => {
    const run = makeRun({ runtime: 'codex' });
    const event = (phase: string, id: string, command?: string, status?: string) => JSON.stringify({
      type: 'item.' + phase, item: { type: 'command_execution', id, command, status },
    });
    const a = stampCommandStartReceipt(event('started', 'a', 'sleep 30'), 'codex', first);
    const b = stampCommandStartReceipt(event('started', 'b', 'sleep 30'), 'codex', second);
    const doneB = event('completed', 'b', 'sleep 30 && printf completed');
    const doneA = event('completed', 'a');
    const legacy = event('completed', 'legacy', 'printf legacy');
    expect(buildRunProgress(run, [a, b]).steps.map(s => s.commandStartedAt)).toEqual([first, second]);
    const finished = buildRunProgress(run, [a, doneB, b, doneA, doneB, a, legacy]);
    expect(finished.totalSteps).toBe(3);
    expect(finished.steps.map(s => [s.commandStartedAt, s.body])).toEqual([
      [first, 'sleep 30'],
      [second, 'sleep 30 && printf completed'],
      [undefined, 'printf legacy'],
    ]);
    expect(stampCommandStartReceipt(doneB, 'codex', second)).toBe(doneB);
    expect(buildRunProgress(run, [event('started', 'a', 'sleep 30'), doneA]).steps[0].commandStartedAt)
      .toBeUndefined();
    expect(buildRunProgress(run, [b, event('completed', 'b', 'sleep 30', 'declined')]).steps[0].commandStartedAt)
      .toBeUndefined();
  });

  test('pairs Codex rollout item lifecycle within each turn and ignores completion timestamps', () => {
    const card = { status: 'in_progress' as const, createdAt: first };
    const line = (type: string, turn_id: string, timestamp: string, command: string) => JSON.stringify({
      timestamp, type: 'event_msg', payload: {
        type, turn_id, item: { id: 'same-id', type: 'CommandExecution', command: ['/bin/zsh', '-lc', command] },
      },
    });
    const a = line('item_started', 'a', first, 'printf a');
    const b = line('item_started', 'b', second, 'sleep 30');
    expect(buildTranscriptProgress(card, [a, b], 'codex').steps.map(s => s.commandStartedAt))
      .toEqual([first, second]);
    const done = line('item_completed', 'a', second, 'printf a && printf done');
    expect(buildTranscriptProgress(card, [done], 'codex').steps[0].commandStartedAt).toBeUndefined();
    expect(buildTranscriptProgress(card, [done, a, b], 'codex').steps.map(s => [s.commandStartedAt, s.body]))
      .toEqual([[first, 'printf a && printf done'], [second, 'sleep 30']]);
  });

  test('accepts an older Codex rollout launch and merges a canonical completion with the same ID', () => {
    const card = { status: 'in_progress' as const, createdAt: first };
    const wrap = (timestamp: string, payload: object) => JSON.stringify({ timestamp, type: 'event_msg', payload });
    const begin = {
      type: 'exec_command_begin', turn_id: 'turn-a', call_id: 'command-a',
      command: ['printf', '%s', "two words and an apostrophe's"],
    };
    const stdin = { ...begin, call_id: 'stdin', source: 'unified_exec_interaction' };
    const legacyEnd = { ...begin, type: 'exec_command_end', status: 'completed' };
    const complete = {
      type: 'item_completed', turn_id: 'turn-a',
      item: { type: 'CommandExecution', id: 'command-a', command: ['/bin/zsh', '-lc', 'printf done && sleep 30'] },
    };
    const fullCommand = "printf %s 'two words and an apostrophe'\\''s'";
    expect(buildTranscriptProgress(card, [wrap(first, begin), wrap(second, stdin), wrap(second, legacyEnd)], 'codex').steps)
      .toEqual([{ kind: 'command', label: 'Shell', commandStartedAt: first, detail: fullCommand, body: fullCommand }]);
    expect(buildTranscriptProgress(card, [wrap(first, begin), wrap(second, complete)], 'codex').steps)
      .toEqual([{ kind: 'command', label: 'Shell', commandStartedAt: first, detail: 'printf done && sleep 30', body: 'printf done && sleep 30' }]);
  });
});
