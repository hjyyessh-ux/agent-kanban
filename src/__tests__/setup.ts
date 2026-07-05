import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { KanbanCard, KanbanBoard } from '../core/types';

// Guard: every test run must be isolated from the user's real ~/.agent-kanban
// directory. The data-dir resolver would otherwise create or touch files the
// user is actively using.
if (!process.env.KANBAN_DATA_DIR) {
  const testDataDir = mkdtempSync(join(tmpdir(), 'kanban-suite-'));
  process.env.KANBAN_DATA_DIR = testDataDir;
  if (!process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE) {
    process.env.KANBAN_RUNTIME_DEBUG_LOG_FILE = join(testDataDir, 'runtime-debug.log');
  }
}

/**
 * Factory function returning a valid KanbanCard with defaults.
 */
export function createTestCard(overrides: Partial<KanbanCard> = {}): KanbanCard {
  const now = new Date().toISOString();
  return {
    id: `test-${Math.random().toString(36).slice(2, 9)}`,
    title: 'Test Task',
    description: 'Test Description',
    status: 'todo',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/**
 * Factory function returning a valid KanbanBoard.
 */
export function createTestBoard(cards: KanbanCard[] = []): KanbanBoard {
  return {
    version: 1,
    cards,
    lastModified: new Date().toISOString(),
  };
}

/**
 * Creates a temp directory, runs callback with the path, then cleans up.
 */
export async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'kanban-test-'));
  try {
    return await callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
