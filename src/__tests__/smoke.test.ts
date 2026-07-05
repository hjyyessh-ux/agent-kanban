import { describe, test, expect } from 'bun:test';
import { createTestCard, createTestBoard, withTempDir } from './setup';

describe('bun test infrastructure', () => {
  test('bun test runner works', () => {
    expect(1 + 1).toBe(2);
  });

  test('test utilities are importable and functional', async () => {
    const card = createTestCard({ title: 'My Test Card' });
    expect(card.title).toBe('My Test Card');
    expect(card.status).toBe('todo');
    expect(card.id).toBeTruthy();

    const board = createTestBoard([card]);
    expect(board.version).toBe(1);
    expect(board.cards).toHaveLength(1);

    const result = await withTempDir(async (dir) => {
      expect(dir).toBeTruthy();
      expect(dir).toContain('kanban-test-');
      return 'success';
    });
    expect(result).toBe('success');
  });
});
