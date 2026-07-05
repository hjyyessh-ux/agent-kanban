import { afterEach, describe, expect, test } from 'bun:test';
import {
  _testing,
  clearSubagentParent,
  getSubagentParent,
  registerSubagentParent,
} from '../plugin/hooks/subagent-parent-registry';

const { registry, TTL_MS } = _testing;

afterEach(() => {
  registry.clear();
});

describe('subagent-parent-registry', () => {
  test('registers and returns parent mapping for child session', () => {
    registerSubagentParent('child-session', {
      parentCardId: 'card-1',
      rootCardId: 'root-1',
      parentSessionId: 'parent-session',
      agentType: 'explore',
    });

    expect(getSubagentParent('child-session')).toEqual({
      parentCardId: 'card-1',
      rootCardId: 'root-1',
      parentSessionId: 'parent-session',
      agentType: 'explore',
      timestamp: expect.any(Number),
    });
  });

  test('clearSubagentParent removes mapping', () => {
    registerSubagentParent('child-session', {
      parentCardId: 'card-1',
      rootCardId: 'root-1',
      parentSessionId: 'parent-session',
    });

    clearSubagentParent('child-session');
    expect(getSubagentParent('child-session')).toBeUndefined();
  });

  test('expired mappings are cleaned up on read', () => {
    registry.set('expired-session', {
      parentCardId: 'card-1',
      rootCardId: 'root-1',
      parentSessionId: 'parent-session',
      timestamp: Date.now() - TTL_MS - 1000,
    });

    expect(getSubagentParent('expired-session')).toBeUndefined();
  });
});
