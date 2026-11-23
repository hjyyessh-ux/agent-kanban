import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';
import { DELEGATION_ENABLED_KEY } from '../plugin/runtimes/external-delegation-service';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

interface Capture {
  argv: string[];
  prompt: string;
  cwd: string;
  cardId: string;
  runId: string;
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the fake runtime lifecycle');
}

async function fakeCodex(dir: string, options: { gated?: boolean; failure?: boolean; noThread?: boolean } = {}) {
  const script = join(dir, 'fake-codex.ts');
  const capturePath = join(dir, 'codex-capture.jsonl');
  const releasePath = join(dir, 'codex-release');
  await Bun.write(script, `
import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  argv, prompt, cwd: process.cwd(),
  cardId: process.env.AGENT_KANBAN_DISPATCH_CARD_ID,
  runId: process.env.AGENT_KANBAN_DISPATCH_RUN_ID,
}) + '\\n');
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\\n');
if (${Boolean(options.noThread)}) {
  await Bun.sleep(2_000);
  process.exit(1);
}
emit({type:'thread.started', thread_id:'delegated-codex-thread'});
emit({type:'item.completed', item:{type:'agent_message', text:'review findings'}});
if (${Boolean(options.gated)}) {
  for (let i = 0; i < 1500 && !existsSync(${JSON.stringify(releasePath)}); i++) await Bun.sleep(10);
}
if (${Boolean(options.failure)}) {
  process.stderr.write('injected Codex failure');
  process.exit(7);
}
emit({type:'item.completed', item:{type:'agent_message', text:'final review'}});
const outputIndex = argv.indexOf('-o');
if (outputIndex >= 0) writeFileSync(argv[outputIndex + 1], 'final review');
emit({type:'turn.completed'});
`);
  return {
    command: [process.execPath, script],
    release: () => Bun.write(releasePath, 'release'),
    captures: async (): Promise<Capture[]> => existsSync(capturePath)
      ? (await Bun.file(capturePath).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Capture)
      : [],
  };
}

async function fixture(dir: string, options: Parameters<typeof fakeCodex>[1] & { spawnFailure?: boolean } = {}) {
  const fake = await fakeCodex(dir, options);
  const claudeScript = join(dir, 'fake-claude.ts');
  const parentReleasePath = join(dir, 'claude-release');
  await Bun.write(claudeScript, `
import { existsSync, watch } from 'node:fs';
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\\n');
emit({type:'system', subtype:'init', session_id:'live-claude-parent'});
for (let i = 0; i < 1500 && !existsSync(${JSON.stringify(parentReleasePath)}); i++) await Bun.sleep(10);
if (prompt.includes('[parent-failure]')) { process.stderr.write('parent failed'); process.exit(8); }
emit({type:'assistant', message:{content:[{type:'text', text:'parent final'}]}});
emit({type:'result', result:'parent final', session_id:'live-claude-parent'});
`);
  const store = new KanbanStore(dir);
  const settingsStore = new SettingsStore(dir);
  const host = await createStandaloneRuntimeHost({
    store, settingsStore, dataDir: dir,
    codexCommandOverride: options.spawnFailure ? [join(dir, 'missing-codex')] : fake.command,
    claudeCommandOverride: [process.execPath, claudeScript],
    codexThreadIdTimeoutMs: options.noThread ? 100 : 1_000,
  });
  const parent = await store.createCard({
    title: 'Claude parent review', description: 'Review the pull request',
    agentRuntime: 'claude', projectDir: dir,
  });
  await store.updateCard(parent.id, { status: 'in_progress', sessionId: 'parent-claude-session' });
  const parentRun = await host.runStore.createRun({ cardId: parent.id, runtime: 'claude', cwd: dir });
  await host.runStore.updateRun(parentRun.runId, { status: 'running', sessionId: 'parent-claude-session' });
  const request = {
    parentCardId: parent.id, parentRunId: parentRun.runId,
    requestId: 'review-request-1', prompt: 'Review this change independently',
  };
  const enable = () => settingsStore.upsertByKey(DELEGATION_ENABLED_KEY, 'true');
  const terminal = (runId: string) => eventually(
    () => host.delegations.get(runId),
    result => ['completed', 'failed', 'aborted'].includes(result.status),
  );
  return {
    fake, store, settingsStore, host, parent, parentRun, request, enable, terminal,
    releaseParent: () => Bun.write(parentReleasePath, 'release'),
  };
}

describe('managed external delegation', () => {
  test('is off by default and cannot spawn or create a child', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      await expect(f.host.delegations.start(f.request)).rejects.toThrow();
      expect(await f.fake.captures()).toHaveLength(0);
      expect((await f.store.getCards()).filter(card => card.parentCardId === f.parent.id)).toHaveLength(0);
    });
  });

  test('same request races reserve one child and execute one Codex run with safe options', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      await f.enable();
      await f.settingsStore.upsertByKey('agent.codex.bypass_approvals_and_sandbox', 'true');
      const [first, replay] = await Promise.all([
        f.host.delegations.start(f.request), f.host.delegations.start(f.request),
      ]);
      expect(replay.runId).toBe(first.runId);
      expect(replay.cardId).toBe(first.cardId);
      const result = await f.terminal(first.runId);
      expect(result.status).toBe('completed');
      expect(result.result).toBe('review findings\n\nfinal review');
      expect(result.finalResult).toBe('final review');
      expect(result.sessionId).toBe('delegated-codex-thread');
      const captures = await f.fake.captures();
      expect(captures).toHaveLength(1);
      const capture = captures[0]!;
      expect(capture.argv[capture.argv.indexOf('-s') + 1]).toBe('read-only');
      expect(capture.argv[capture.argv.indexOf('-m') + 1]).toBe('gpt-6-astra');
      expect(capture.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
      expect(realpathSync(capture.cwd)).toBe(realpathSync(dir));
      expect(capture.prompt).toBe(f.request.prompt);
      expect(capture.cardId).toBe(first.cardId);
      expect(capture.runId).toBe(first.runId);
      const child = await f.store.getCard(first.cardId);
      expect(child?.parentCardId).toBe(f.parent.id);
      expect(child?.linkKind).toBe('subagent');
      expect(child?.agentRuntime).toBe('codex');
      expect(child?.managedDelegation).toEqual({ runId: first.runId, parentRunId: f.parentRun.runId });
      const run = await f.host.runStore.getRun(first.runId);
      expect(await Bun.file(run!.promptPath).text()).toBe(f.request.prompt);
      expect(await Bun.file(run!.lastMessagePath).text()).toBe(result.result!);
    });
  });

  test('rejects reused keys with different payloads and completed replay never spawns again', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      await f.terminal(first.runId);
      await expect(f.host.delegations.start({ ...f.request, prompt: 'A different review' })).rejects.toThrow();
      expect((await f.host.delegations.start(f.request)).runId).toBe(first.runId);
      expect(await f.fake.captures()).toHaveLength(1);
    });
  });

  test('partial-output failure is terminal and only a fresh request creates a sibling', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { failure: true });
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      const failed = await f.terminal(first.runId);
      expect(failed.status).toBe('failed');
      expect(failed.result).toContain('review findings');
      const child = await f.store.getCard(first.cardId);
      expect(child?.status).toBe('complete');
      expect(child?.resolution).toBe('failed');
      await expect(f.host.dispatchCard(first.cardId)).rejects.toThrow();
      const second = await f.host.delegations.start({ ...f.request, requestId: 'review-request-2' });
      await f.terminal(second.runId);
      expect(second.runId).not.toBe(first.runId);
      expect(second.cardId).not.toBe(first.cardId);
      expect((await f.store.getCard(second.cardId))?.parentCardId).toBe(f.parent.id);
      expect(await f.fake.captures()).toHaveLength(2);
    });
  });

  test('off rejects new work while an accepted run can complete and remain readable', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { gated: true });
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      try {
        await eventually(f.fake.captures, captures => captures.length === 1);
        await f.settingsStore.upsertByKey(DELEGATION_ENABLED_KEY, 'false');
        await expect(f.host.delegations.start({ ...f.request, requestId: 'new-while-off' })).rejects.toThrow();
      } finally {
        await f.fake.release();
      }
      expect((await f.terminal(first.runId)).status).toBe('completed');
      expect(await f.fake.captures()).toHaveLength(1);
    });
  });

  test('archive blocks the active managed subtree and succeeds after terminal output is stored', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { gated: true });
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      try {
        await eventually(f.fake.captures, captures => captures.length === 1);
        await expect(f.store.archiveCards([f.parent.id])).rejects.toThrow();
        expect(await f.store.getCard(f.parent.id)).not.toBeNull();
      } finally {
        await f.fake.release();
        await f.terminal(first.runId);
      }
      await f.terminal(first.runId);
      await f.store.updateCard(f.parent.id, { status: 'done' });
      await f.store.archiveCards([f.parent.id]);
      expect(await f.store.getCard(first.cardId)).toBeNull();
      expect((await f.store.getCard(first.cardId, { includeArchived: true }))?.result).toContain('final review');
      expect((await f.host.delegations.start(f.request)).runId).toBe(first.runId);
      expect(await f.fake.captures()).toHaveLength(1);
    });
  });

  test('deletion and purge preserve run reads and durable replay without resurrecting a child', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { gated: true });
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      try {
        await eventually(f.fake.captures, captures => captures.length === 1);
        await f.store.deleteCard(first.cardId);
        await f.store.purgeDeletedCards();
      } finally {
        await f.fake.release();
      }
      expect((await f.terminal(first.runId)).result).toContain('final review');
      expect(await f.store.getCard(first.cardId, { includeDeleted: true })).toBeNull();
      expect((await f.host.delegations.start(f.request)).runId).toBe(first.runId);
      expect(await f.fake.captures()).toHaveLength(1);
    });
  });

  test('a favorite active managed child blocks parent archive, then remains pinned after completion', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { gated: true });
      await f.enable();
      const child = await f.host.delegations.start(f.request);
      try {
        await eventually(f.fake.captures, captures => captures.length === 1);
        await f.store.updateCard(child.cardId, { favorite: true });
        await f.store.updateCard(f.parent.id, { status: 'done' });
        await expect(f.store.archiveCards([f.parent.id])).rejects.toThrow();
        expect(await f.store.getCard(f.parent.id)).not.toBeNull();
      } finally {
        await f.fake.release();
        await f.terminal(child.runId);
      }
      expect((await f.terminal(child.runId)).status).toBe('completed');
      expect((await f.store.archiveCards([f.parent.id])).archivedCount).toBe(1);
      expect(await f.store.getCard(f.parent.id)).toBeNull();
      const pinned = await f.store.getCard(child.cardId);
      expect(pinned?.favorite).toBe(true);
      expect(pinned?.status).toBe('complete');
      expect(pinned?.result).toContain('final review');
    });
  });

  test('closed parent admission rejects new requests but retains terminal replay', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      await f.terminal(first.runId);
      await f.host.runStore.closeDelegationAdmission(f.parentRun.runId);
      await expect(f.host.delegations.start({ ...f.request, requestId: 'too-late' })).rejects.toThrow();
      expect((await f.host.delegations.start(f.request)).runId).toBe(first.runId);
      expect(await f.fake.captures()).toHaveLength(1);
    });
  });

  test('thread timeout records a terminal failed child without a placeholder session', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { noThread: true });
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      expect((await f.terminal(first.runId)).status).toBe('failed');
      const child = await f.store.getCard(first.cardId);
      expect(child?.status).toBe('complete');
      expect(child?.resolution).toBe('failed');
      expect(child?.sessionId).toBeUndefined();
    });
  });

  test('spawn failure terminates the reservation and never leaves a retryable todo child', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { spawnFailure: true });
      await f.enable();
      const accepted = await f.host.delegations.start(f.request);
      const failed = await f.terminal(accepted.runId);
      expect(failed.status).toBe('failed');
      expect(failed.error).toBeTruthy();
      const child = await f.store.getCard(accepted.cardId);
      expect(child?.status).toBe('complete');
      expect(child?.resolution).toBe('failed');
      expect((await f.host.delegations.start(f.request)).runId).toBe(accepted.runId);
      expect(await f.fake.captures()).toHaveLength(0);
    });
  });

  test('delegation start and run reads require the local token, including after card purge', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      await f.enable();
      const args: Parameters<typeof createRouteHandler> = [f.store];
      args[11] = () => 'delegation-test-token';
      args[17] = f.host.runStore;
      args[23] = f.host.delegations;
      const { handleRequest } = createRouteHandler(...args);
      const local = (request: Request) => handleRequest(request, { clientAddress: '127.0.0.1' });
      const remote = await handleRequest(new Request('http://localhost/api/delegations/local-review', {
        headers: { Authorization: 'Bearer delegation-test-token' },
      }), { clientAddress: '192.0.2.1' });
      expect(remote.status).toBe(403);
      const unauthenticated = await local(new Request('http://localhost/api/delegations', {
        method: 'POST', body: JSON.stringify(f.request),
      }));
      expect(unauthenticated.status).toBe(401);
      const accepted = await local(new Request('http://localhost/api/delegations', {
        method: 'POST',
        headers: { Authorization: 'Bearer delegation-test-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(f.request),
      }));
      expect(accepted.ok).toBe(true);
      const record = await accepted.json() as { runId: string; cardId: string };
      await f.terminal(record.runId);
      await f.store.deleteCard(record.cardId);
      await f.store.purgeDeletedCards();
      const url = `http://localhost/api/delegations/${record.runId}`;
      expect((await local(new Request(url))).status).toBe(401);
      const read = await local(new Request(url, {
        headers: { Authorization: 'Bearer delegation-test-token' },
      }));
      expect(read.status).toBe(200);
      expect((await read.json() as { result: string }).result).toContain('final review');
      expect(await f.fake.captures()).toHaveLength(1);
    });
  });

  test('public create and patch cannot forge or detach managed provenance', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      await f.enable();
      const first = await f.host.delegations.start(f.request);
      await f.terminal(first.runId);
      const { handleRequest } = createRouteHandler(f.store);
      const forged = await handleRequest(new Request('http://localhost/api/cards', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'forged child', description: 'forged',
          managedDelegation: { runId: first.runId, parentRunId: f.parentRun.runId } }),
      }));
      if (forged.ok) {
        const card = await forged.json() as { managedDelegation?: unknown };
        expect(card.managedDelegation).toBeUndefined();
      } else {
        expect(forged.status).toBe(400);
      }
      await handleRequest(new Request(`http://localhost/api/cards/${first.cardId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ managedDelegation: null, parentCardId: null, childRunId: null,
          linkKind: 'worker', status: 'todo', resumeSessionId: 'unauthorized-resume',
          queuedAfterCardId: f.parent.id }),
      }));
      const child = await f.store.getCard(first.cardId);
      expect(child?.managedDelegation).toEqual({ runId: first.runId, parentRunId: f.parentRun.runId });
      expect(child?.parentCardId).toBe(f.parent.id);
      expect(child?.linkKind).toBe('subagent');
      expect(child?.status).toBe('complete');
      expect(child?.resumeSessionId).toBeFalsy();
      expect(child?.queuedAfterCardId).toBeFalsy();
    });
  });

  test('normal Claude exit closes admission and drains only its accepted delegated run', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { gated: true });
      await f.enable();
      const parent = await f.store.createCard({ title: 'live parent', description: 'normal parent',
        agentRuntime: 'claude', projectDir: dir });
      const parentDispatch = await f.host.dispatchCard(parent.id);
      const request = { ...f.request, parentCardId: parent.id, parentRunId: parentDispatch.runId! };
      const child = await f.host.delegations.start(request);
      try {
        await f.releaseParent();
        const draining = await eventually(() => f.host.runStore.getRun(parentDispatch.runId!),
          run => run?.admissionClosed === true);
        expect(draining?.status).toBe('running');
        expect((await f.store.getCard(parent.id))?.status).toBe('in_progress');
        await expect(f.host.delegations.start({ ...request, requestId: 'after-normal-exit' })).rejects.toThrow();
      } finally {
        await f.releaseParent();
        await f.fake.release();
      }
      await f.terminal(child.runId);
      const completed = await eventually(() => f.store.getCard(parent.id), card => card?.status === 'complete');
      expect(completed?.result).toBe('parent final');
      expect((await f.store.getCard(child.cardId))?.result).toContain('final review');
    });
  });

  test('Claude parent failure cannot supersede or overwrite an independently running Codex child', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { gated: true });
      await f.enable();
      const parent = await f.store.createCard({ title: 'failing parent', description: '[parent-failure]',
        agentRuntime: 'claude', projectDir: dir });
      const parentDispatch = await f.host.dispatchCard(parent.id);
      const child = await f.host.delegations.start({ ...f.request,
        parentCardId: parent.id, parentRunId: parentDispatch.runId! });
      try {
        await eventually(f.fake.captures, captures => captures.length === 1);
        await f.releaseParent();
        await eventually(() => f.store.getCard(parent.id), card => card?.status === 'todo');
        const running = await f.store.getCard(child.cardId);
        expect(running?.status).toBe('in_progress');
        expect(running?.resolution).not.toBe('superseded');
        expect(running?.result ?? '').not.toContain('[parent run failed]');
      } finally {
        await f.releaseParent();
        await f.fake.release();
      }
      expect((await f.terminal(child.runId)).status).toBe('completed');
      expect((await f.store.getCard(child.cardId))?.result).toBe('review findings\n\nfinal review');
    });
  });

  for (const cardExists of [false, true]) {
    test(`restart fails an unspawned reservation with cardExists=${cardExists} without launching a CLI`, async () => {
      await withTempDir(async dir => {
        const f = await fixture(dir);
        await f.enable();
        const { run } = await f.host.runStore.reserveDelegation({
          parentCardId: f.parent.id, parentRunId: f.parentRun.runId,
          requestId: 'interrupted-before-spawn', requestHash: 'persisted-request-hash', model: 'gpt-6-astra',
        }, async reserved => {
          if (!cardExists) return;
          await f.store.createDelegationCard({ id: reserved.cardId, runId: reserved.runId,
            parentCardId: f.parent.id, parentRunId: f.parentRun.runId,
            prompt: 'queued review', model: 'gpt-6-astra', cwd: dir, reasoningEffort: 'high' });
          await Bun.write(reserved.eventsPath, JSON.stringify({ type: 'item.completed',
            item: { type: 'agent_message', text: 'persisted partial findings' } }) + '\n');
        });
        const restarted = await createStandaloneRuntimeHost({ store: f.store, settingsStore: f.settingsStore,
          dataDir: dir, codexCommandOverride: f.fake.command });
        await restarted.runStore.reconcileStale(f.store);
        const failed = await restarted.delegations.get(run.runId);
        expect(failed.status).toBe('failed');
        expect(failed.error).toBeTruthy();
        expect(await f.fake.captures()).toHaveLength(0);
        const child = await f.store.getCard(run.cardId);
        if (cardExists) {
          expect(child?.status).toBe('complete');
          expect(child?.resolution).toBe('failed');
          expect(child?.result).toBe('persisted partial findings');
          expect(failed.result).toBe('persisted partial findings');
        } else {
          expect(child).toBeNull();
        }
      });
    });
  }

  for (const archived of [false, true]) {
    test(`restart preserves committed success after the card write, archived=${archived}`, async () => {
      await withTempDir(async dir => {
        const f = await fixture(dir);
        const { run } = await f.host.runStore.reserveDelegation({
          parentCardId: f.parent.id, parentRunId: f.parentRun.runId,
          requestId: 'crash-after-card-result', requestHash: 'committed-result-hash', model: 'gpt-6-astra',
        }, async reserved => {
          await f.store.createDelegationCard({ id: reserved.cardId, runId: reserved.runId,
            parentCardId: f.parent.id, parentRunId: f.parentRun.runId,
            prompt: 'completed review', model: 'gpt-6-astra', cwd: dir, reasoningEffort: 'high' });
        });
        await f.store.updateCard(run.cardId, { status: 'complete', resolution: 'completed',
          result: 'durable successful review', finalResult: 'durable successful review' }, run.runId);
        await Bun.write(run.lastMessagePath, 'durable successful review');
        if (archived) {
          await f.store.updateCard(f.parent.id, { status: 'done' });
          await f.store.archiveCards([f.parent.id]);
        }
        const restarted = await createStandaloneRuntimeHost({ store: f.store, settingsStore: f.settingsStore,
          dataDir: dir, codexCommandOverride: f.fake.command });
        await restarted.runStore.reconcileStale(f.store);
        const restored = await restarted.delegations.get(run.runId);
        expect(restored.status).toBe('completed');
        expect(restored.result).toBe('durable successful review');
        expect((await f.store.getCard(run.cardId, { includeArchived: true }))?.resolution).toBe('completed');
        expect(await f.fake.captures()).toHaveLength(0);
      });
    });
  }
});
