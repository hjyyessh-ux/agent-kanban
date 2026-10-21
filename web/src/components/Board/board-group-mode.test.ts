import { describe, expect, test } from 'bun:test';
import { groupsCompleteBySession, parseBoardGroupMode } from './board-group-mode';

describe('parseBoardGroupMode', () => {
  test('migrates the legacy boolean toggle', () => {
    expect(parseBoardGroupMode('true')).toBe('session');
    expect(parseBoardGroupMode('false')).toBe('card');
  });

  test('round-trips every current mode', () => {
    expect(parseBoardGroupMode('card')).toBe('card');
    expect(parseBoardGroupMode('session')).toBe('session');
    expect(parseBoardGroupMode('works')).toBe('works');
  });

  test('falls back to card for missing or unknown values', () => {
    expect(parseBoardGroupMode(null)).toBe('card');
    expect(parseBoardGroupMode(undefined)).toBe('card');
    expect(parseBoardGroupMode('')).toBe('card');
    expect(parseBoardGroupMode('WORKS')).toBe('card');
  });
});

describe('groupsCompleteBySession', () => {
  test('only card mode keeps the complete column flat', () => {
    expect(groupsCompleteBySession('card')).toBe(false);
    expect(groupsCompleteBySession('session')).toBe(true);
    expect(groupsCompleteBySession('works')).toBe(true);
  });
});
