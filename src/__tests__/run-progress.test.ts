import { describe, test, expect } from 'bun:test';
import { buildRunProgress, buildTranscriptProgress } from '../plugin/runtimes/run-progress';
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

function assistantToolUse(name: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input }] },
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
