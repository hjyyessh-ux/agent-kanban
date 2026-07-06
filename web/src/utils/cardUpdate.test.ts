import { describe, test, expect } from 'bun:test';
import { applyCardUpdates } from './cardUpdate';
import type { KanbanCard } from '../../../src/core/types';

function makeCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  return {
    id: 'card-1',
    title: 'Original title',
    description: 'Original description',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    model: 'github-copilot/claude-opus-4.6',
    agentType: 'sisyphus',
    resumeSessionId: 'ses-1',
    command: '/refactor',
    arguments: '--fast',
    ...overrides,
  } as KanbanCard;
}

describe('applyCardUpdates', () => {
  test('undefined fields leave the card untouched', () => {
    const card = makeCard();
    const next = applyCardUpdates(card, {});
    expect(next).toEqual(card);
  });

  test('concrete values replace fields', () => {
    const next = applyCardUpdates(makeCard(), {
      title: 'New title',
      description: 'New description',
      model: 'claude-sonnet-5',
      favorite: true,
    });
    expect(next.title).toBe('New title');
    expect(next.description).toBe('New description');
    expect(next.model).toBe('claude-sonnet-5');
    expect(next.favorite).toBe(true);
  });

  test('null deletes optional fields', () => {
    const next = applyCardUpdates(makeCard(), {
      model: null,
      agentType: null,
      resumeSessionId: null,
      command: null,
      arguments: null,
      queueSessionMode: null,
    });
    expect('model' in next).toBe(false);
    expect('agentType' in next).toBe(false);
    expect('resumeSessionId' in next).toBe(false);
    expect('command' in next).toBe(false);
    expect('arguments' in next).toBe(false);
    expect('queueSessionMode' in next).toBe(false);
  });

  test('does not mutate the input card', () => {
    const card = makeCard();
    applyCardUpdates(card, { title: 'Changed', model: null });
    expect(card.title).toBe('Original title');
    expect(card.model).toBe('github-copilot/claude-opus-4.6');
  });

  test('arguments maps through despite the reserved-word rename', () => {
    const next = applyCardUpdates(makeCard(), { arguments: '--slow' });
    expect(next.arguments).toBe('--slow');
  });
});
