import { describe, test, expect } from 'bun:test';
import type { KanbanCard, KanbanBoard, KanbanStatus, CreateCardInput, UpdateCardInput } from '../core/types';

describe('KanbanCard type', () => {
  test('has correct shape with required fields', () => {
    const card: KanbanCard = {
      id: 'test-id',
      title: 'Test task',
      description: 'Test description',
      status: 'todo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    expect(card.id).toBe('test-id');
    expect(card.title).toBe('Test task');
    expect(card.status).toBe('todo');
  });

  test('accepts all optional fields', () => {
    const card: KanbanCard = {
      id: 'test-id-2',
      title: 'Full card',
      description: 'Full description',
      status: 'in_progress',
      sessionId: 'session-123',
      projectDir: '/tmp/project',
      model: 'claude-3',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progressSummary: 'Working on it',
      result: 'Done result',
      queueSessionMode: 'continue_queued_after_session',
      resolution: 'completed',
      supersededByCardId: 'card-newest',
      supersededAt: new Date().toISOString(),
    };
    expect(card.sessionId).toBe('session-123');
    expect(card.progressSummary).toBe('Working on it');
    expect(card.queueSessionMode).toBe('continue_queued_after_session');
    expect(card.resolution).toBe('completed');
    expect(card.supersededByCardId).toBe('card-newest');
  });
});

describe('KanbanStatus type', () => {
  test('all valid statuses work', () => {
    const statuses: KanbanStatus[] = ['todo', 'in_progress', 'complete', 'done'];
    expect(statuses).toHaveLength(4);
    expect(statuses).toContain('todo');
    expect(statuses).toContain('in_progress');
    expect(statuses).toContain('complete');
    expect(statuses).toContain('done');
  });
});

describe('KanbanBoard type', () => {
  test('has version 1 and cards array', () => {
    const board: KanbanBoard = {
      version: 1,
      cards: [],
      lastModified: new Date().toISOString(),
    };
    expect(board.version).toBe(1);
    expect(board.cards).toHaveLength(0);
  });
});

describe('CreateCardInput type', () => {
  test('requires title and description only', () => {
    const input: CreateCardInput = {
      title: 'New task',
      description: 'Task description',
      queueSessionMode: 'new_session',
    };
    expect(input.title).toBe('New task');
    expect(input.projectDir).toBeUndefined();
    expect(input.queueSessionMode).toBe('new_session');
  });
});

describe('UpdateCardInput type', () => {
  test('all fields are optional', () => {
    const input: UpdateCardInput = {
      command: null,
      arguments: null,
      resolution: null,
      supersededByCardId: null,
      supersededAt: null,
    };
    expect(input.status).toBeUndefined();
    expect(input.title).toBeUndefined();
    expect(input.queueSessionMode).toBeUndefined();
    expect(input.command).toBeNull();
    expect(input.arguments).toBeNull();
    expect(input.resolution).toBeNull();
    expect(input.supersededByCardId).toBeNull();
    expect(input.supersededAt).toBeNull();
  });
});
