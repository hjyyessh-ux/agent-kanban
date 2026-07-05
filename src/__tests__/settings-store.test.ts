import { describe, test, expect } from 'bun:test';
import { SettingsStore } from '../core/settings-store';
import { withTempDir } from './setup';

describe('SettingsStore', () => {
  test('creates settings file on first operation', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry = await store.createEntry({
        key: 'API_KEY',
        value: 'sk-test-123',
        description: 'OpenAI API Key',
        category: 'api',
      });
      expect(entry.id).toBeTruthy();

      // Verify loads back from disk
      const loaded = await store.getEntry(entry.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.key).toBe('API_KEY');
    });
  });

  test('createEntry creates entry with all fields', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry = await store.createEntry({
        key: 'API_KEY',
        value: 'sk-test-123',
        description: 'OpenAI API Key',
        category: 'api',
        masked: false,
      });

      expect(entry.id).toBeTruthy();
      expect(entry.key).toBe('API_KEY');
      expect(entry.value).toBe('sk-test-123');
      expect(entry.description).toBe('OpenAI API Key');
      expect(entry.category).toBe('api');
      expect(entry.masked).toBe(false);
      expect(entry.createdAt).toBeTruthy();
      expect(entry.updatedAt).toBeTruthy();
    });
  });

  test('createEntry defaults masked to true', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry = await store.createEntry({
        key: 'SECRET',
        value: 'hidden-value',
        description: 'A secret',
      });

      expect(entry.masked).toBe(true);
    });
  });

  test('createEntry persists to disk', async () => {
    await withTempDir(async (dir) => {
      const store1 = new SettingsStore(dir);
      const entry = await store1.createEntry({
        key: 'API_KEY',
        value: 'sk-test-123',
        description: 'OpenAI API Key',
        category: 'api',
      });

      // Create a new store pointing to same dir — verify persistence
      const store2 = new SettingsStore(dir);
      const loaded = await store2.getEntry(entry.id);
      expect(loaded).not.toBeNull();
      expect(loaded!.key).toBe('API_KEY');
      expect(loaded!.value).toBe('sk-test-123');
    });
  });

  test('createEntry with masked=false', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry = await store.createEntry({
        key: 'PUBLIC_KEY',
        value: 'pk-visible',
        description: 'Public key',
        masked: false,
      });

      expect(entry.masked).toBe(false);

      // Verify persisted
      const loaded = await store.getEntry(entry.id);
      expect(loaded!.masked).toBe(false);
    });
  });

  test('updateEntry updates fields', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry = await store.createEntry({
        key: 'API_KEY',
        value: 'sk-test-123',
        description: 'OpenAI API Key',
        category: 'api',
      });

      const updated = await store.updateEntry(entry.id, {
        value: 'sk-new-456',
        description: 'Updated OpenAI Key',
      });

      expect(updated.value).toBe('sk-new-456');
      expect(updated.description).toBe('Updated OpenAI Key');
      expect(updated.key).toBe('API_KEY'); // unchanged
      expect(typeof updated.updatedAt).toBe('string');
    });
  });

  test('updateEntry throws for non-existent id', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      expect(
        store.updateEntry('bad-id', { value: 'nope' })
      ).rejects.toThrow('Settings entry not found: bad-id');
    });
  });

  test('deleteEntry removes entry', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry = await store.createEntry({
        key: 'API_KEY',
        value: 'sk-test-123',
        description: 'OpenAI API Key',
      });

      await store.deleteEntry(entry.id);
      const found = await store.getEntry(entry.id);
      expect(found).toBeNull();
    });
  });

  test('deleteEntry throws for non-existent id', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      expect(
        store.deleteEntry('bad-id')
      ).rejects.toThrow('Settings entry not found: bad-id');
    });
  });

  test('getEntry returns null for non-existent id', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const result = await store.getEntry('nonexistent-id');
      expect(result).toBeNull();
    });
  });

  test('getEntries returns all entries', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      await store.createEntry({ key: 'KEY_1', value: 'v1', description: 'First' });
      await store.createEntry({ key: 'KEY_2', value: 'v2', description: 'Second' });
      await store.createEntry({ key: 'KEY_3', value: 'v3', description: 'Third' });

      const entries = await store.getEntries();
      expect(entries).toHaveLength(3);
    });
  });

  test('multiple entries persist independently', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);
      const entry1 = await store.createEntry({ key: 'KEY_A', value: 'a', description: 'A' });
      const entry2 = await store.createEntry({ key: 'KEY_B', value: 'b', description: 'B' });

      // Delete first, second should survive
      await store.deleteEntry(entry1.id);

      const remaining = await store.getEntries();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(entry2.id);
      expect(remaining[0].key).toBe('KEY_B');

      // Confirm deleted entry is gone
      const deleted = await store.getEntry(entry1.id);
      expect(deleted).toBeNull();
    });
  });
});
