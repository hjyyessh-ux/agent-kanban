import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { getCodexCliModels, mergeCodexCliModelsIntoCatalog } from '../plugin/runtimes/codex-model-catalog';
import { RUNTIME_CATALOG } from '../core/runtime-config';
import { withTempDir } from './setup';

async function createFakeCodexBinary(dir: string): Promise<string> {
  const path = join(dir, 'fake-codex-models.js');
  await Bun.write(path, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] !== 'debug' || args[1] !== 'models') process.exit(2);
process.stdout.write(JSON.stringify({
  models: [
    { slug: 'gpt-5.7-sol', display_name: 'GPT-5.7-Sol', visibility: 'list', priority: 1 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 2 },
    { slug: 'gpt-5.7-mini', display_name: 'GPT-5.7-Mini', visibility: 'list', priority: 3 }
  ]
}));
`);
  chmodSync(path, 0o755);
  return path;
}

describe('Codex model catalog', () => {
  test('reads list-visible models from codex debug models', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir);

      const models = await getCodexCliModels({
        commandOverride: [fakeCodex],
        forceRefresh: true,
      });

      expect(models.map((model) => model.id)).toEqual(['gpt-5.7-sol', 'gpt-5.7-mini']);
      expect(models[0]).toEqual({ id: 'gpt-5.7-sol', label: 'GPT-5.7-Sol', tier: 'frontier' });
    });
  });

  test('replaces the Codex runtime catalog with CLI models', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir);

      const catalog = await mergeCodexCliModelsIntoCatalog(RUNTIME_CATALOG, {
        commandOverride: [fakeCodex],
      });

      const codex = catalog.find((entry) => entry.runtime === 'codex');
      expect(codex?.models?.map((model) => model.id)).toEqual(['gpt-5.7-sol', 'gpt-5.7-mini']);
    });
  });
});
