import { describe, expect, test } from 'bun:test';
import { SettingsStore } from '../core/settings-store';
import { withTempDir } from './setup';

describe('SettingsStore.upsertByKey', () => {
  test('parallel upserts for the same key keep a single entry', async () => {
    await withTempDir(async (dir) => {
      const store = new SettingsStore(dir);

      await Promise.all(
        Array.from({ length: 20 }, (_, index) =>
          store.upsertByKey('agent.defaults.codex.model', `model-${index}`, {
            description: 'Codex default',
            category: 'agent.defaults',
            masked: false,
          })
        )
      );

      const entries = await store.getEntries();
      const matching = entries.filter(entry => entry.key === 'agent.defaults.codex.model');
      expect(matching).toHaveLength(1);
      expect(matching[0].value).toMatch(/^model-/);
      expect(matching[0].masked).toBe(false);
    });
  });
});
