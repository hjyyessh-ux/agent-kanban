import { describe, expect, test } from 'bun:test';
import { createRuntimeRegistry } from '../plugin/runtimes/runtime-registry';
import type { AgentAdapter } from '../plugin/runtimes/types';

function adapter(runtime: AgentAdapter['runtime']): AgentAdapter {
  return {
    runtime,
    start: async () => ({
      sessionId: `${runtime}-session`,
      runId: `${runtime}-run`,
      startedAt: new Date().toISOString(),
      abort: () => {},
      done: Promise.resolve({ outcome: 'completed', result: '', durationMs: 0 }),
    }),
  };
}

describe('runtime registry', () => {
  test('routes by runtime', () => {
    const opencode = adapter('opencode');
    const codex = adapter('codex');
    const claude = adapter('claude');
    const registry = createRuntimeRegistry([opencode, codex, claude]);

    expect(registry.pickAdapter('opencode')).toBe(opencode);
    expect(registry.pickAdapter('codex')).toBe(codex);
    expect(registry.pickAdapter('claude')).toBe(claude);
  });

  test('rejects runtime without adapter', () => {
    const registry = createRuntimeRegistry([adapter('opencode')]);
    expect(() => registry.pickAdapter('claude')).toThrow('Dispatch not available for claude yet');
  });
});
