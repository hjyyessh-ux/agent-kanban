import { describe, test, expect } from 'bun:test';
import { SchedulerStore } from '../core/scheduler-store';
import { withTempDir } from './setup';
import type { CreateSchedulerInput, SchedulerRun } from '../core/types';

function createTestInput(overrides: Partial<CreateSchedulerInput> = {}): CreateSchedulerInput {
  return {
    name: 'Test Job',
    description: 'A test scheduler',
    cron: '*/5 * * * *',
    action: { type: 'shell' as const, command: 'echo hello' },
    ...overrides,
  };
}

function createTestRun(schedulerId: string, overrides: Partial<SchedulerRun> = {}): SchedulerRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 9)}`,
    schedulerId,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    status: 'success' as const,
    exitCode: 0,
    stdout: 'hello\n',
    stderr: '',
    ...overrides,
  };
}

describe('SchedulerStore', () => {
  test('creates schedulers file on first operation', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      await store.createEntry(createTestInput());

      // Verify a new store instance can load the created entry
      const store2 = new SchedulerStore(dir);
      const entries = await store2.getEntries();
      expect(entries).toHaveLength(1);
    });
  });

  test('createEntry creates entry with correct defaults', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      expect(entry.id).toBeTruthy();
      expect(entry.name).toBe('Test Job');
      expect(entry.description).toBe('A test scheduler');
      expect(entry.cron).toBe('*/5 * * * *');
      expect(entry.status).toBe('active');
      expect(entry.history).toEqual([]);
      expect(entry.action).toEqual({ type: 'shell', command: 'echo hello' });
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();
    });
  });

  test('createEntry persists to disk', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      // Fresh store instance reads from disk
      const store2 = new SchedulerStore(dir);
      const loaded = await store2.getEntry(entry.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('Test Job');
      expect(loaded!.id).toBe(entry.id);
    });
  });

  test('updateEntry updates fields', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      // Small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 5));

      const updated = await store.updateEntry(entry.id, {
        name: 'Updated Job',
        cron: '0 * * * *',
      });

      expect(updated.name).toBe('Updated Job');
      expect(updated.cron).toBe('0 * * * *');
      expect(updated.description).toBe('A test scheduler'); // unchanged
      expect(updated.updatedAt).not.toBe(entry.updatedAt);
    });
  });

  test('updateEntry throws for non-existent id', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      await expect(
        store.updateEntry('bad-id', { name: 'Nope' })
      ).rejects.toThrow('Scheduler entry not found: bad-id');
    });
  });

  test('deleteEntry removes entry', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      await store.deleteEntry(entry.id);
      const found = await store.getEntry(entry.id);
      expect(found).toBeNull();
    });
  });

  test('deleteEntry throws for non-existent id', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      await expect(
        store.deleteEntry('bad-id')
      ).rejects.toThrow('Scheduler entry not found: bad-id');
    });
  });

  test('toggleEntry flips active to inactive', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());
      expect(entry.status).toBe('active');

      const toggled = await store.toggleEntry(entry.id);
      expect(toggled.status).toBe('inactive');
    });
  });

  test('toggleEntry flips inactive back to active', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      await store.toggleEntry(entry.id); // active → inactive
      const toggled = await store.toggleEntry(entry.id); // inactive → active
      expect(toggled.status).toBe('active');
    });
  });

  test('getEntry returns null for non-existent id', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const result = await store.getEntry('nonexistent');
      expect(result).toBeNull();
    });
  });

  test('getEntries returns all entries', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      await store.createEntry(createTestInput({ name: 'Job 1' }));
      await store.createEntry(createTestInput({ name: 'Job 2' }));
      await store.createEntry(createTestInput({ name: 'Job 3' }));

      const entries = await store.getEntries();
      expect(entries).toHaveLength(3);
    });
  });

  test('addRun prepends to history', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      const run1 = createTestRun(entry.id, { id: 'run-1', stdout: 'first' });
      const run2 = createTestRun(entry.id, { id: 'run-2', stdout: 'second' });

      await store.addRun(entry.id, run1);
      await store.addRun(entry.id, run2);

      const history = await store.getHistory(entry.id);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('run-2'); // most recent first
      expect(history[1].id).toBe('run-1');
    });
  });

  test('addRun caps history at MAX_HISTORY (20)', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      // Add 25 runs
      for (let i = 0; i < 25; i++) {
        await store.addRun(entry.id, createTestRun(entry.id, { id: `run-${i}` }));
      }

      const history = await store.getHistory(entry.id);
      expect(history).toHaveLength(20);
      // Most recent run (run-24) should be first
      expect(history[0].id).toBe('run-24');
      // Oldest kept run should be run-5 (runs 0-4 dropped)
      expect(history[19].id).toBe('run-5');
    });
  });

  test('addRun caps stdout/stderr at MAX_OUTPUT_BYTES (8192)', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      const longOutput = 'x'.repeat(10000);
      await store.addRun(entry.id, createTestRun(entry.id, {
        stdout: longOutput,
        stderr: longOutput,
      }));

      const history = await store.getHistory(entry.id);
      expect(history).toHaveLength(1);
      // 8192 chars + '\n... (truncated)'
      expect(history[0].stdout!.length).toBe(8192 + '\n... (truncated)'.length);
      expect(history[0].stdout!.endsWith('\n... (truncated)')).toBe(true);
      expect(history[0].stderr!.length).toBe(8192 + '\n... (truncated)'.length);
      expect(history[0].stderr!.endsWith('\n... (truncated)')).toBe(true);
    });
  });

  test('addRun silently skips if entry was deleted', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());
      await store.deleteEntry(entry.id);

      // Should NOT throw
      await store.addRun(entry.id, createTestRun(entry.id));

      // No entries, no crash
      const entries = await store.getEntries();
      expect(entries).toHaveLength(0);
    });
  });

  test('addRun updates lastRunAt and lastRunStatus', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      const run = createTestRun(entry.id, {
        status: 'success',
        startedAt: '2026-01-15T10:00:00.000Z',
      });
      await store.addRun(entry.id, run);

      const loaded = await store.getEntry(entry.id);
      expect(loaded!.lastRunAt).toBe('2026-01-15T10:00:00.000Z');
      expect(loaded!.lastRunStatus).toBe('success');
    });
  });

  test('updateNextRunAt sets next run time', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      const nextRun = '2026-03-01T12:00:00.000Z';
      await store.updateNextRunAt(entry.id, nextRun);

      const loaded = await store.getEntry(entry.id);
      expect(loaded!.nextRunAt).toBe(nextRun);

      // Can also clear it
      await store.updateNextRunAt(entry.id, undefined);
      const cleared = await store.getEntry(entry.id);
      expect(cleared!.nextRunAt).toBeUndefined();
    });
  });

  test('getHistory returns history for entry', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const entry = await store.createEntry(createTestInput());

      await store.addRun(entry.id, createTestRun(entry.id, { id: 'run-a' }));
      await store.addRun(entry.id, createTestRun(entry.id, { id: 'run-b' }));

      const history = await store.getHistory(entry.id);
      expect(history).toHaveLength(2);
      expect(history[0].id).toBe('run-b');
      expect(history[1].id).toBe('run-a');
    });
  });

  test('getHistory returns empty array for non-existent entry', async () => {
    await withTempDir(async (dir) => {
      const store = new SchedulerStore(dir);
      const history = await store.getHistory('nonexistent');
      expect(history).toEqual([]);
    });
  });
});
