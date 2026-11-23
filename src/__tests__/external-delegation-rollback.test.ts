import { join, resolve } from 'node:path';
import { readdirSync, symlinkSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { DELEGATION_ENABLED_KEY } from '../plugin/runtimes/external-delegation-service';
import { withTempDir } from './setup';

const BASE_REVISION = 'ca4d1f9d53f1277db473234fc24bd442b98fa10c';

async function oldModule(dir: string, relative: string): Promise<string> {
  const target = join(dir, 'old-source', relative);
  const sourceDir = resolve('src', relative, '..');
  const parent = resolve(target, '..');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(parent, { recursive: true });
  for (const file of readdirSync(sourceDir)) {
    if (!file.endsWith('.ts') || file === relative.split('/').at(-1)) continue;
    symlinkSync(join(sourceDir, file), join(parent, file));
  }
  const git = Bun.spawn(['git', 'show', `${BASE_REVISION}:src/${relative}`], {
    stdout: 'pipe', stderr: 'pipe',
  });
  const [source, stderr, exit] = await Promise.all([
    new Response(git.stdout).text(), new Response(git.stderr).text(), git.exited,
  ]);
  if (exit !== 0) throw new Error(`Cannot load rollback baseline: ${stderr}`);
  await Bun.write(target, source);
  return target;
}

describe('external delegation rollback compatibility', () => {
  test('drained records survive old code reading and writing while unrelated new cards remain', async () => {
    await withTempDir(async dir => {
      const data = join(dir, 'data');
      const store = new KanbanStore(data);
      const settingsStore = new SettingsStore(data);
      const fake = join(dir, 'codex.ts');
      await Bun.write(fake, `
for await (const _ of Bun.stdin.stream()) {}
console.log(JSON.stringify({type:'thread.started',thread_id:'rollback-review'}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'preserved review'}}));
console.log(JSON.stringify({type:'turn.completed'}));
`);
      const host = await createStandaloneRuntimeHost({
        store, settingsStore, dataDir: data, codexCommandOverride: [process.execPath, fake],
      });
      const parent = await store.createCard({
        title: 'Existing A', description: 'A', agentRuntime: 'claude', projectDir: dir,
      });
      await store.updateCard(parent.id, { status: 'in_progress' });
      const parentRun = await host.runStore.createRun({ cardId: parent.id, runtime: 'claude', cwd: dir });
      await host.runStore.updateRun(parentRun.runId, { status: 'running', sessionId: 'rollback-parent' });
      await settingsStore.upsertByKey(DELEGATION_ENABLED_KEY, 'true');
      const request = { parentCardId: parent.id, parentRunId: parentRun.runId,
        requestId: 'rollback-request', prompt: 'Review without modifying files' };
      const accepted = await host.delegations.start(request);
      await host.runStore.closeDelegationAdmission(parentRun.runId);
      await host.runStore.waitForDelegations(parentRun.runId);
      const review = await host.delegations.get(accepted.runId);
      expect(review.status).toBe('completed');
      expect(review.result).toBe('preserved review');
      await settingsStore.upsertByKey(DELEGATION_ENABLED_KEY, 'false');
      const before = await store.getCard(accepted.cardId);
      const unrelated = await store.createCard({ title: 'New unrelated B', description: 'Preserve B' });
      await host.runStore.finishRun(parentRun.runId, { status: 'completed' });
      expect((await host.runStore.listRuns()).filter(r => ['starting', 'running'].includes(r.status))).toHaveLength(0);

      // Execute actual baseline persistence code, rather than emulating old JSON writes.
      const oldStorePath = await oldModule(dir, 'core/store.ts');
      const oldRunPath = await oldModule(dir, 'plugin/runtimes/runtime-run-store.ts');
      symlinkSync(resolve('node_modules'), join(dir, 'old-source', 'node_modules'));
      const oldStoreModule = await import(oldStorePath) as { KanbanStore: typeof KanbanStore };
      const oldRunModule = await import(oldRunPath) as { RuntimeRunStore: typeof RuntimeRunStore };
      const legacyStore = new oldStoreModule.KanbanStore(data);
      const legacyRuns = new oldRunModule.RuntimeRunStore(data);
      await legacyStore.updateCard(parent.id, { title: 'A edited with old code' });
      await legacyRuns.updateRun(parentRun.runId, { error: 'harmless legacy write' });
      expect(await legacyRuns.reconcileStale(legacyStore)).toHaveLength(0);

      const current = new KanbanStore(data);
      expect((await current.getCard(parent.id))?.title).toBe('A edited with old code');
      expect(await current.getCard(unrelated.id)).not.toBeNull();
      expect((await current.getCard(accepted.cardId))?.managedDelegation).toEqual(before?.managedDelegation);
      expect((await current.getCard(accepted.cardId))?.result).toBe(before?.result);
      const persisted = await new RuntimeRunStore(data).getRun(accepted.runId);
      expect(persisted?.delegation?.requestId).toBe(request.requestId);
      expect(persisted?.status).toBe(review.status);
      expect((await host.delegations.get(accepted.runId)).result).toBe(review.result);
      await expect(host.delegations.start({ ...request, requestId: 'disabled' })).rejects.toThrow();
    });
  });
});
