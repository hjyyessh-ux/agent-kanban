import { describe, expect, test } from 'bun:test';
import type { KanbanCard } from '../core/types';
import {
  buildSessionChainMap,
  buildSubagentSessionTree,
  subagentAncestorSessions,
  subagentDescendantSessions,
} from '../core/session-chain';

function card(overrides: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard {
  return {
    title: overrides.id,
    description: '',
    status: 'done',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as KanbanCard;
}

describe('buildSessionChainMap', () => {
  test('links a subagent session to its parent card session, both ways', () => {
    const chains = buildSessionChainMap([
      card({ id: 'parent', sessionId: 'ses-parent' }),
      card({ id: 'sub', sessionId: 'ses-sub', parentCardId: 'parent' }),
    ]);
    expect(chains.get('ses-sub')).toEqual(['ses-parent']);
    // Symmetric: triage asks from whichever side is unassigned.
    expect(chains.get('ses-parent')).toEqual(['ses-sub']);
  });

  test('links a queue chain that opened a new session', () => {
    const chains = buildSessionChainMap([
      card({ id: 'first', sessionId: 'ses-1' }),
      card({ id: 'next', sessionId: 'ses-2', queuedAfterCardId: 'first' }),
    ]);
    expect(chains.get('ses-1')).toEqual(['ses-2']);
  });

  test('drops a queue chain that stayed on one session', () => {
    // `continue_queued_after_session` leaves both cards on the same sessionId —
    // a self-link is not a relation between two sessions.
    const chains = buildSessionChainMap([
      card({ id: 'first', sessionId: 'ses-1' }),
      card({ id: 'next', sessionId: 'ses-1', queuedAfterCardId: 'first' }),
    ]);
    expect(chains.size).toBe(0);
  });

  test('records a resumed session even when its card is gone from the list', () => {
    const chains = buildSessionChainMap([
      card({ id: 'resumer', sessionId: 'ses-new', resumeSessionId: 'ses-old' }),
    ]);
    expect(chains.get('ses-new')).toEqual(['ses-old']);
    expect(chains.get('ses-old')).toEqual(['ses-new']);
  });

  test('ignores cards with no session and unresolvable references', () => {
    const chains = buildSessionChainMap([
      card({ id: 'orphan', parentCardId: 'nope' }),
      card({ id: 'dangling', sessionId: 'ses-1', queuedAfterCardId: 'missing' }),
    ]);
    expect(chains.size).toBe(0);
  });

  test('collects every peer of a session that fans out', () => {
    const chains = buildSessionChainMap([
      card({ id: 'root', sessionId: 'ses-root' }),
      card({ id: 'a', sessionId: 'ses-a', parentCardId: 'root' }),
      card({ id: 'b', sessionId: 'ses-b', queuedAfterCardId: 'root' }),
    ]);
    expect(chains.get('ses-root')).toEqual(['ses-a', 'ses-b']);
  });
});

describe('buildSubagentSessionTree', () => {
  test('points a subagent session at the session its parent card ran on', () => {
    const tree = buildSubagentSessionTree([
      card({ id: 'parent', sessionId: 'ses-parent' }),
      card({ id: 'sub', sessionId: 'ses-sub', parentCardId: 'parent' }),
    ]);
    expect(tree.parentOf.get('ses-sub')).toBe('ses-parent');
    expect(tree.childrenOf.get('ses-parent')).toEqual(['ses-sub']);
  });

  test('ignores a subagent card that stayed on its parent session', () => {
    const tree = buildSubagentSessionTree([
      card({ id: 'parent', sessionId: 'ses-1' }),
      card({ id: 'sub', sessionId: 'ses-1', parentCardId: 'parent' }),
    ]);
    expect(tree.parentOf.size).toBe(0);
  });

  test('excludes queue chains and resumes — only parentCardId has a direction', () => {
    const tree = buildSubagentSessionTree([
      card({ id: 'first', sessionId: 'ses-1' }),
      card({ id: 'queued', sessionId: 'ses-2', queuedAfterCardId: 'first' }),
      card({ id: 'resumed', sessionId: 'ses-3', resumeSessionId: 'ses-1' }),
    ]);
    expect(tree.parentOf.size).toBe(0);
  });

  test('walks ancestors and descendants transitively', () => {
    const tree = buildSubagentSessionTree([
      card({ id: 'root', sessionId: 'ses-root' }),
      card({ id: 'mid', sessionId: 'ses-mid', parentCardId: 'root' }),
      card({ id: 'leaf', sessionId: 'ses-leaf', parentCardId: 'mid' }),
    ]);
    expect(subagentDescendantSessions(tree, 'ses-root')).toEqual(['ses-leaf', 'ses-mid']);
    expect(subagentAncestorSessions(tree, 'ses-leaf')).toEqual(['ses-mid', 'ses-root']);
    expect(subagentAncestorSessions(tree, 'ses-root')).toEqual([]);
  });

  test('terminates on a cycle instead of hanging', () => {
    // Only reachable from corrupted data, but both walks must still return.
    const tree = buildSubagentSessionTree([
      card({ id: 'a', sessionId: 'ses-a', parentCardId: 'b' }),
      card({ id: 'b', sessionId: 'ses-b', parentCardId: 'a' }),
    ]);
    expect(subagentDescendantSessions(tree, 'ses-a')).toEqual(['ses-b']);
    expect(subagentAncestorSessions(tree, 'ses-a')).toEqual(['ses-b']);
  });
});
