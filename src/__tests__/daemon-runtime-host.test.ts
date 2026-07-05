import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';
import { RuntimeDispatchError } from '../plugin/runtimes/types';
import { withTempDir } from './setup';

async function createFakeCodexBinary(dir: string): Promise<string> {
  const path = join(dir, 'fake-codex.js');
  await Bun.write(path, `#!/usr/bin/env bun
const fs = require('node:fs');
const args = process.argv.slice(2);
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
const outputPath = args[args.indexOf('-o') + 1] || args[args.indexOf('--output-last-message') + 1];
const output = 'daemon codex result:' + prompt.trim();
if (outputPath) fs.writeFileSync(outputPath, output);
process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'daemon-codex-thread' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'item.completed', item: { role: 'assistant', content: [{ type: 'text', text: output }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\\n');
`);
  chmodSync(path, 0o755);
  return path;
}

async function createFakeClaudeBinary(dir: string): Promise<string> {
  const path = join(dir, 'fake-claude.js');
  await Bun.write(path, `#!/usr/bin/env bun
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
const output = 'daemon claude result:' + prompt.trim();
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'daemon-claude-session' }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'msg-1', content: [{ type: 'text', text: output }] } }) + '\\n');
process.stdout.write(JSON.stringify({ type: 'result', result: output, session_id: 'daemon-claude-session', total_cost_usd: 0.001 }) + '\\n');
`);
  chmodSync(path, 0o755);
  return path;
}

async function waitForCardStatus(store: KanbanStore, cardId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const card = await store.getCard(cardId);
    if (card?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const card = await store.getCard(cardId);
  throw new Error(`Timed out waiting for ${status}; got ${card?.status ?? 'missing'}`);
}

describe('standalone daemon runtime host', () => {
  test('reports Codex and Claude available while opencode is unavailable', async () => {
    await withTempDir(async (dir) => {
      const host = await createStandaloneRuntimeHost({
        store: new KanbanStore(dir),
        settingsStore: new SettingsStore(dir),
        dataDir: dir,
      });

      const availability = host.getRuntimeAvailability();
      expect(availability.find((entry) => entry.runtime === 'codex')?.available).toBe(true);
      expect(availability.find((entry) => entry.runtime === 'claude')?.available).toBe(true);
      expect(availability.find((entry) => entry.runtime === 'opencode')?.available).toBe(false);

      const catalog = host.getRuntimeCatalog();
      const opencode = catalog.find((entry) => entry.runtime === 'opencode');
      const codex = catalog.find((entry) => entry.runtime === 'codex');
      expect(opencode?.disabled).toBe(true);
      expect(opencode?.unavailableReason).toContain('standalone daemon');
      expect(codex?.models?.length).toBeGreaterThan(0);
    });
  });

  test('rejects opencode dispatch without saving a placeholder session', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const host = await createStandaloneRuntimeHost({
        store,
        settingsStore: new SettingsStore(dir),
        dataDir: dir,
      });
      const card = await store.createCard({
        title: 'opencode task',
        description: 'Do it',
        agentRuntime: 'opencode',
      });

      try {
        await host.dispatchCard(card.id);
        throw new Error('Expected dispatch to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimeDispatchError);
        expect((error as RuntimeDispatchError).statusCode).toBe(409);
      }

      const updated = await store.getCard(card.id);
      expect(updated?.status).toBe('todo');
      expect(updated?.sessionId).toBeUndefined();
      expect(updated?.progressSummary).toContain('opencode runtime is unavailable');
    });
  });

  test('dispatches Codex cards through the daemon host', async () => {
    await withTempDir(async (dir) => {
      const fakeCodex = await createFakeCodexBinary(dir);
      const store = new KanbanStore(dir);
      const host = await createStandaloneRuntimeHost({
        store,
        settingsStore: new SettingsStore(dir),
        dataDir: dir,
        codexCommandOverride: [fakeCodex],
        codexThreadIdTimeoutMs: 1000,
      });
      const card = await store.createCard({
        title: 'Codex task',
        description: 'Do it',
        agentRuntime: 'codex',
        projectDir: dir,
      });

      const result = await host.dispatchCard(card.id);
      expect(result.sessionId).toBe('daemon-codex-thread');
      expect(result.runId).toStartWith('codex-');
      expect(result.startedAt).toBeString();

      await waitForCardStatus(store, card.id, 'complete');
      const updated = await store.getCard(card.id);
      expect(updated?.result).toBe('daemon codex result:Do it');
    });
  });

  test('dispatches Claude cards through the daemon host', async () => {
    await withTempDir(async (dir) => {
      const fakeClaude = await createFakeClaudeBinary(dir);
      const store = new KanbanStore(dir);
      const host = await createStandaloneRuntimeHost({
        store,
        settingsStore: new SettingsStore(dir),
        dataDir: dir,
        claudeCommandOverride: [fakeClaude],
        claudeSessionIdTimeoutMs: 1000,
      });
      const card = await store.createCard({
        title: 'Claude task',
        description: 'Do it',
        agentRuntime: 'claude',
        projectDir: dir,
      });

      const result = await host.dispatchCard(card.id);
      expect(result.sessionId).toBe('daemon-claude-session');
      expect(result.runId).toStartWith('claude-');
      expect(result.startedAt).toBeString();

      await waitForCardStatus(store, card.id, 'complete');
      const updated = await store.getCard(card.id);
      expect(updated?.result).toBe('daemon claude result:Do it');
    });
  });

  test('daemon host includes screenshot context in runtime prompt', async () => {
    await withTempDir(async (dir) => {
      const fakeClaude = await createFakeClaudeBinary(dir);
      const store = new KanbanStore(dir);
      const host = await createStandaloneRuntimeHost({
        store,
        settingsStore: new SettingsStore(dir),
        dataDir: dir,
        claudeCommandOverride: [fakeClaude],
        claudeSessionIdTimeoutMs: 1000,
      });
      const card = await store.createCard({
        title: 'Claude screenshot task',
        description: 'Describe the image',
        agentRuntime: 'claude',
        projectDir: dir,
      });
      await store.saveScreenshot(
        card.id,
        new Uint8Array([1, 2, 3]).buffer,
        'sample.png',
        'image/png',
      );

      await host.dispatchCard(card.id);
      await waitForCardStatus(store, card.id, 'complete');

      const updated = await store.getCard(card.id);
      expect(updated?.result).toContain('Attached screenshots:');
      expect(updated?.result).toContain('sample.png');
      expect(updated?.result).toContain(`path: ${join(dir, 'screenshots')}`);
      expect(updated?.result).toContain('size: 3 bytes');
    });
  });
});
