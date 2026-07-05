import { describe, test, expect } from 'bun:test';
import { aggregateUsage, aggregateCodexUsage } from '../plugin/runtimes/usage-aggregator';

// Build an assistant event line carrying tool_use parts.
function assistant(...parts: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: parts },
  });
}

const toolUse = (name: string, input?: Record<string, unknown>) => ({
  type: 'tool_use',
  id: `toolu_${name}`,
  name,
  ...(input ? { input } : {}),
});

const taskStarted = (subagentType: string) =>
  JSON.stringify({ type: 'system', subtype: 'task_started', subagent_type: subagentType });

describe('aggregateUsage', () => {
  test('counts plain tool_use names', () => {
    const lines = [
      assistant(toolUse('Read'), toolUse('Edit')),
      assistant(toolUse('Read')),
    ];
    const stats = aggregateUsage(lines);
    expect(stats.tools).toEqual({ Read: 2, Edit: 1 });
    expect(stats.mcpServers).toBeUndefined();
    expect(stats.skillsUsed).toBeUndefined();
    expect(typeof stats.updatedAt).toBe('string');
  });

  test('decomposes MCP tool names into servers and per-tool counts', () => {
    const lines = [
      assistant(toolUse('mcp__grafana__query_loki_logs')),
      assistant(toolUse('mcp__grafana__query_loki_logs')),
      assistant(toolUse('mcp__OSS__get_pull_request')),
    ];
    const stats = aggregateUsage(lines);
    expect(stats.mcpServers).toEqual(['OSS', 'grafana']); // sorted
    expect(stats.mcpTools).toEqual({
      grafana__query_loki_logs: 2,
      OSS__get_pull_request: 1,
    });
    expect(stats.tools).toBeUndefined(); // MCP calls don't fall into plain tools
  });

  test('handles MCP tool names whose tool segment contains __', () => {
    const stats = aggregateUsage([
      assistant(toolUse('mcp__plugin_oh-my-claudecode_t__ast_grep_search')),
    ]);
    expect(stats.mcpServers).toEqual(['plugin_oh-my-claudecode_t']);
    expect(stats.mcpTools).toEqual({ 'plugin_oh-my-claudecode_t__ast_grep_search': 1 });
  });

  test('records the invoked skill name from Skill tool input, not the Skill tool', () => {
    const stats = aggregateUsage([
      assistant(toolUse('Skill', { skill: 'pr-review' })),
      assistant(toolUse('Skill', { skill: 'kanban-create' })),
    ]);
    expect(stats.skillsUsed).toEqual(['kanban-create', 'pr-review']); // sorted
    expect(stats.tools).toBeUndefined();
  });

  test('treats a Skill call with no/invalid skill key as a plain tool', () => {
    const stats = aggregateUsage([
      assistant(toolUse('Skill', {})),
      assistant(toolUse('Skill', { skill: 42 })),
    ]);
    expect(stats.skillsUsed).toBeUndefined();
    expect(stats.tools).toEqual({ Skill: 2 });
  });

  test('collects distinct subagent types from task_started events', () => {
    const stats = aggregateUsage([
      taskStarted('general-purpose'),
      taskStarted('Explore'),
      taskStarted('general-purpose'),
    ]);
    expect(stats.subagents).toEqual(['Explore', 'general-purpose']); // sorted, distinct
  });

  test('aggregates a mixed transcript (tool/mcp/skill/subagent)', () => {
    const lines = [
      assistant(toolUse('Read')),
      taskStarted('Explore'),
      assistant(toolUse('mcp__jira-naver__jira_get_issue'), toolUse('Skill', { skill: 'jira' })),
      assistant(toolUse('Bash', { command: 'bun test src/__tests__/usage-aggregator.test.ts' })),
    ];
    const stats = aggregateUsage(lines);
    expect(stats.tools).toEqual({ Read: 1, Bash: 1 });
    expect(stats.mcpServers).toEqual(['jira-naver']);
    expect(stats.mcpTools).toEqual({ 'jira-naver__jira_get_issue': 1 });
    expect(stats.commands).toEqual(['bun test src/__tests__/usage-aggregator.test.ts']);
    expect(stats.skillsUsed).toEqual(['jira']);
    expect(stats.subagents).toEqual(['Explore']);
  });

  test('skips malformed JSON, blank lines, and non-tool content', () => {
    const lines = [
      '',
      '   ',
      'not json at all',
      JSON.stringify({ type: 'system', subtype: 'init' }),
      assistant({ type: 'text', text: 'just prose, no tool' }),
      assistant(toolUse('Read')),
    ];
    const stats = aggregateUsage(lines);
    expect(stats.tools).toEqual({ Read: 1 });
  });

  test('returns only updatedAt when there is no usage', () => {
    const stats = aggregateUsage([]);
    expect(Object.keys(stats)).toEqual(['updatedAt']);
  });
});

// Codex stream uses item.started/item.completed wrapping an `item`.
const codexCompleted = (item: Record<string, unknown>) =>
  JSON.stringify({ type: 'item.completed', item });
const codexStarted = (item: Record<string, unknown>) =>
  JSON.stringify({ type: 'item.started', item });

describe('aggregateCodexUsage', () => {
  test('counts command_execution as Shell and file_change as Edit', () => {
    const lines = [
      codexCompleted({ type: 'command_execution', command: 'ls' }),
      codexCompleted({ type: 'command_execution', command: 'git status' }),
      codexCompleted({ type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }] }),
    ];
    const stats = aggregateCodexUsage(lines);
    expect(stats.tools).toEqual({ Shell: 2, Edit: 1 });
    expect(stats.commands).toEqual(['ls', 'git status']);
    expect(stats.skillsUsed).toBeUndefined();
    expect(stats.subagents).toBeUndefined();
    expect(typeof stats.updatedAt).toBe('string');
  });

  test('counts each item once via item.completed, ignoring item.started', () => {
    const lines = [
      codexStarted({ type: 'command_execution', command: 'ls' }),
      codexCompleted({ type: 'command_execution', command: 'ls' }),
      codexStarted({ type: 'file_change', changes: [] }),
    ];
    const stats = aggregateCodexUsage(lines);
    expect(stats.tools).toEqual({ Shell: 1 }); // started-only file_change not counted
    expect(stats.commands).toEqual(['ls']);
  });

  test('maps mcp_tool_call to mcpServers and per-tool counts', () => {
    const lines = [
      codexCompleted({ type: 'mcp_tool_call', server: 'node_repl', tool: 'js' }),
      codexCompleted({ type: 'mcp_tool_call', server: 'node_repl', tool: 'js' }),
      codexCompleted({ type: 'mcp_tool_call', server: 'grafana', tool: 'query' }),
    ];
    const stats = aggregateCodexUsage(lines);
    expect(stats.mcpServers).toEqual(['grafana', 'node_repl']); // sorted
    expect(stats.mcpTools).toEqual({ node_repl__js: 2, grafana__query: 1 });
    expect(stats.tools).toBeUndefined();
  });

  test('ignores agent_message and unknown item types', () => {
    const lines = [
      codexCompleted({ type: 'agent_message', text: 'hello' }),
      codexCompleted({ type: 'reasoning', text: 'thinking' }),
      codexCompleted({ type: 'command_execution', command: 'pwd' }),
    ];
    const stats = aggregateCodexUsage(lines);
    expect(stats.tools).toEqual({ Shell: 1 });
  });

  test('skips malformed JSON and blank lines', () => {
    const lines = [
      '',
      'not json',
      codexCompleted({ type: 'command_execution', command: 'ls' }),
    ];
    expect(aggregateCodexUsage(lines).tools).toEqual({ Shell: 1 });
  });

  test('returns only updatedAt when there is no usage', () => {
    expect(Object.keys(aggregateCodexUsage([]))).toEqual(['updatedAt']);
  });
});
