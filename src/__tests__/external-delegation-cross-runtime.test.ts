// Synthetic (no-op CLI) coverage for managed Claude → Codex and Codex → Claude
// delegation. No real model runs: both CLIs are fake Bun scripts.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { DEFAULT_CLAUDE_MODEL } from '../core/runtime-config';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';
import { DELEGATION_ENABLED_KEY } from '../plugin/runtimes/external-delegation-service';
import { withTempDir } from './setup';

interface Capture { cli: 'claude' | 'codex'; argv: string[]; prompt: string; cardId: string; runId: string; apiUrl: string }
interface FakeOptions {
  childGated?: boolean; childFailure?: boolean; childNoSession?: boolean; claudeSpawnFailure?: boolean;
}

async function eventually<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for the fake runtime lifecycle');
}

/** Parent prompts contain PARENT; anything else is a delegated child prompt. */
async function fixture(dir: string, options: FakeOptions = {}) {
  const capturePath = join(dir, 'captures.jsonl');
  const header = `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
let prompt = '';
for await (const chunk of Bun.stdin.stream()) prompt += new TextDecoder().decode(chunk);
const cardId = process.env.AGENT_KANBAN_DISPATCH_CARD_ID ?? '';
const runId = process.env.AGENT_KANBAN_DISPATCH_RUN_ID ?? '';
const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\\n');
const parent = prompt.includes('PARENT');
const waitFor = async (path: string) => { for (let i = 0; i < 3000 && !existsSync(path); i++) await Bun.sleep(5); };
const dir = ${JSON.stringify(dir)};
`;
  const capture = (cli: string) => `appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
  cli: '${cli}', argv, prompt, cardId, runId, apiUrl: process.env.KANBAN_API_URL ?? '' }) + '\\n');`;
  const codexScript = join(dir, 'fake-codex.ts');
  await Bun.write(codexScript, `${header}${capture('codex')}
if (parent) {
  emit({type:'thread.started', thread_id:'codex-parent-' + cardId});
  await waitFor(dir + '/release-' + cardId);
  if (prompt.includes('[parent-failure]')) { process.stderr.write('codex parent failed'); process.exit(8); }
  emit({type:'item.completed', item:{type:'agent_message', text:'codex parent final'}});
  emit({type:'turn.completed'});
} else {
  emit({type:'thread.started', thread_id:'codex-child-' + runId});
  emit({type:'item.completed', item:{type:'agent_message', text:'codex review'}});
  if (${Boolean(options.childGated)}) await waitFor(dir + '/release-child');
  emit({type:'turn.completed'});
}
`);
  const claudeScript = join(dir, 'fake-claude.ts');
  await Bun.write(claudeScript, `${header}${capture('claude')}
if (parent) {
  emit({type:'system', subtype:'init', session_id:'claude-parent-' + cardId});
  await waitFor(dir + '/release-' + cardId);
  emit({type:'assistant', message:{content:[{type:'text', text:'claude parent final'}]}});
  emit({type:'result', subtype:'success', is_error:false, result:'claude parent final', session_id:'claude-parent-' + cardId});
} else {
  if (${Boolean(options.childNoSession)}) { await Bun.sleep(1500); process.exit(1); }
  emit({type:'system', subtype:'init', session_id:'claude-child-' + runId});
  emit({type:'assistant', message:{content:[{type:'text', text:'claude findings'}]}});
  if (${Boolean(options.childGated)}) await waitFor(dir + '/release-child');
  if (${Boolean(options.childFailure)}) { process.stderr.write('injected Claude failure'); process.exit(7); }
  emit({type:'assistant', message:{content:[{type:'text', text:'claude final'}]}});
  emit({type:'result', subtype:'success', is_error:false, result:'claude final', session_id:'claude-child-' + runId});
}
`);
  const store = new KanbanStore(dir);
  const settingsStore = new SettingsStore(dir);
  const makeHost = () => createStandaloneRuntimeHost({
    store, settingsStore, dataDir: dir,
    codexCommandOverride: [process.execPath, codexScript],
    claudeCommandOverride: options.claudeSpawnFailure ? [join(dir, 'missing-claude')] : [process.execPath, claudeScript],
    codexThreadIdTimeoutMs: 2_000,
    claudeSessionIdTimeoutMs: options.childNoSession ? 150 : 2_000,
  });
  const host = await makeHost();
  host.setApiUrl('http://127.0.0.1:39993');
  await settingsStore.upsertByKey(DELEGATION_ENABLED_KEY, 'true');

  const dispatchParent = async (runtime: 'claude' | 'codex', description = 'PARENT task') => {
    const card = await store.createCard({ title: `${runtime} parent`, description, agentRuntime: runtime, projectDir: dir });
    const dispatched = await host.dispatchCard(card.id);
    return { card, runId: dispatched.runId!, sessionId: dispatched.sessionId };
  };
  const request = (parent: { card: { id: string }; runId: string }, requestId = 'review-1', prompt = 'Review this') => ({
    parentCardId: parent.card.id, parentRunId: parent.runId, requestId, prompt,
  });
  const terminal = (runId: string) => eventually(() => host.delegations.get(runId),
    view => ['completed', 'failed', 'aborted'].includes(view.status));
  const captures = async (): Promise<Capture[]> => existsSync(capturePath)
    ? (await Bun.file(capturePath).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Capture)
    : [];
  const childCaptures = async () => (await captures()).filter(c => !c.prompt.includes('PARENT'));
  return {
    store, settingsStore, host, makeHost, dispatchParent, request, terminal, captures, childCaptures,
    release: (cardId: string) => Bun.write(join(dir, `release-${cardId}`), 'go'),
    releaseChild: () => Bun.write(join(dir, 'release-child'), 'go'),
  };
}

describe('managed cross-runtime delegation (synthetic CLIs)', () => {
  test('Codex parent → Claude child: persisted run, real child session id, read-only options, parent drains child', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { childGated: true });
      await f.settingsStore.upsertByKey('agent.claude.dangerously_skip_permissions', 'true');
      const parent = await f.dispatchParent('codex');
      expect(parent.sessionId).toBe(`codex-parent-${parent.card.id}`);
      const parentCapture = (await f.captures()).find(c => c.cardId === parent.card.id)!;
      expect(parentCapture.prompt).toBe('PARENT task');
      expect(parentCapture.apiUrl).toBe('http://127.0.0.1:39993');

      const accepted = await f.host.delegations.start(f.request(parent));
      expect(accepted.runtime).toBe('claude');
      // Unique delegation run id + child card exist before the CLI produced anything.
      const reserved = await f.host.runStore.getRun(accepted.runId);
      expect(reserved?.delegation?.parentRunId).toBe(parent.runId);
      expect(await Bun.file(reserved!.promptPath).text()).toBe('Review this');
      try {
        await eventually(f.childCaptures, list => list.length === 1);
        await f.release(parent.card.id);
        const draining = await eventually(() => f.host.runStore.getRun(parent.runId), run => run?.admissionClosed === true);
        expect(draining?.status).toBe('running');
        expect((await f.store.getCard(parent.card.id))?.status).toBe('in_progress');
        await expect(f.host.delegations.start(f.request(parent, 'after-exit'))).rejects.toThrow();
      } finally {
        await f.release(parent.card.id);
        await f.releaseChild();
      }
      const view = await f.terminal(accepted.runId);
      expect(view.status).toBe('completed');
      expect(view.sessionId).toBe(`claude-child-${accepted.runId}`);
      expect(view.result).toBe('claude findings\n\nclaude final');
      expect(view.finalResult).toBe('claude final');

      const child = await f.store.getCard(accepted.cardId);
      expect(child?.agentRuntime).toBe('claude');
      expect(child?.parentCardId).toBe(parent.card.id);
      expect(child?.childRunId).toBe(parent.runId);
      expect(child?.linkKind).toBe('subagent');
      expect(child?.title).toBe('Claude#1');
      expect(child?.sessionId).toBe(`claude-child-${accepted.runId}`);
      expect(child?.managedDelegation).toEqual({ runId: accepted.runId, parentRunId: parent.runId });
      expect(child?.status).toBe('complete');
      expect(child?.resolution).toBe('completed');

      const [childCapture] = await f.childCaptures();
      expect(childCapture!.cli).toBe('claude');
      expect(childCapture!.cardId).toBe(accepted.cardId);
      expect(childCapture!.runId).toBe(accepted.runId);
      expect(childCapture!.argv[childCapture!.argv.indexOf('--permission-mode') + 1]).toBe('plan');
      expect(childCapture!.argv[childCapture!.argv.indexOf('--model') + 1]).toBe(DEFAULT_CLAUDE_MODEL);
      expect(childCapture!.argv).not.toContain('--dangerously-skip-permissions');
      expect(childCapture!.argv).not.toContain('--resume');

      const done = await eventually(() => f.store.getCard(parent.card.id), card => card?.status === 'complete');
      expect(done?.sessionId).toBe(`codex-parent-${parent.card.id}`);
      expect(done?.result).toBe('codex parent final');
    });
  });

  test('Claude parent → Codex child still links the Codex thread id as the child session', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      const parent = await f.dispatchParent('claude');
      const accepted = await f.host.delegations.start(f.request(parent));
      expect(accepted.runtime).toBe('codex');
      const view = await f.terminal(accepted.runId);
      expect(view.status).toBe('completed');
      const child = await f.store.getCard(accepted.cardId);
      expect(child?.agentRuntime).toBe('codex');
      expect(child?.sessionId).toBe(`codex-child-${accepted.runId}`);
      expect(child?.parentCardId).toBe(parent.card.id);
      expect(child?.codexOptions?.sandbox).toBe('read-only');
      await f.release(parent.card.id);
      expect((await eventually(() => f.store.getCard(parent.card.id), c => c?.status === 'complete'))?.sessionId)
        .toBe(`claude-parent-${parent.card.id}`);
    });
  });

  test('two live parents in the same folder with the same request id get separate, correctly linked children', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      const a = await f.dispatchParent('codex');
      const b = await f.dispatchParent('codex');
      const c = await f.dispatchParent('claude');
      try {
        const [ra, rb, rc] = await Promise.all([
          f.host.delegations.start(f.request(a, 'same-id')),
          f.host.delegations.start(f.request(b, 'same-id')),
          f.host.delegations.start(f.request(c, 'same-id')),
        ]);
        expect(new Set([ra.runId, rb.runId, rc.runId]).size).toBe(3);
        for (const [parent, view] of [[a, ra], [b, rb], [c, rc]] as const) {
          await f.terminal(view.runId);
          const child = await f.store.getCard(view.cardId);
          expect(child?.parentCardId).toBe(parent.card.id);
          expect(child?.childRunId).toBe(parent.runId);
          expect(child?.sessionId).toBe(`${child?.agentRuntime}-child-${view.runId}`);
        }
        // A parent card id paired with another parent's run is never admitted.
        await expect(f.host.delegations.start({ ...f.request(a, 'cross'), parentRunId: b.runId })).rejects.toThrow();
        const sessions = await Promise.all([a, b, c].map(p => f.store.getCard(p.card.id)));
        expect(sessions.map(s => s?.sessionId)).toEqual([a.sessionId, b.sessionId, c.sessionId]);
      } finally {
        for (const p of [a, b, c]) await f.release(p.card.id);
      }
    });
  });

  test('duplicate requests spawn once; a reused id with different input is rejected', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      const parent = await f.dispatchParent('codex');
      try {
        const [first, replay] = await Promise.all([
          f.host.delegations.start(f.request(parent)), f.host.delegations.start(f.request(parent)),
        ]);
        expect(replay.runId).toBe(first.runId);
        expect(replay.cardId).toBe(first.cardId);
        await f.terminal(first.runId);
        await expect(f.host.delegations.start(f.request(parent, 'review-1', 'different'))).rejects.toThrow();
        expect((await f.host.delegations.start(f.request(parent))).runId).toBe(first.runId);
        expect(await f.childCaptures()).toHaveLength(1);
        expect((await f.store.getCards()).filter(card => card.parentCardId === parent.card.id)).toHaveLength(1);
        // Codex reasoning effort and non-catalog models are rejected for Claude children.
        await expect(f.host.delegations.start({ ...f.request(parent, 'r2'), reasoningEffort: 'high' })).rejects.toThrow();
        await expect(f.host.delegations.start({ ...f.request(parent, 'r3'), model: 'gpt-6-astra' })).rejects.toThrow();
      } finally {
        await f.release(parent.card.id);
      }
    });
  });

  test('Claude child failure is terminal with partial output; only a new request id creates a sibling', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { childFailure: true });
      const parent = await f.dispatchParent('codex');
      try {
        const first = await f.host.delegations.start(f.request(parent));
        const failed = await f.terminal(first.runId);
        expect(failed.status).toBe('failed');
        expect(failed.result).toContain('claude findings');
        const child = await f.store.getCard(first.cardId);
        expect(child?.status).toBe('complete');
        expect(child?.resolution).toBe('failed');
        expect(child?.sessionId).toBe(`claude-child-${first.runId}`);
        await expect(f.host.dispatchCard(first.cardId)).rejects.toThrow();
        const second = await f.host.delegations.start(f.request(parent, 'review-2'));
        await f.terminal(second.runId);
        expect(second.cardId).not.toBe(first.cardId);
        expect((await f.store.getCard(second.cardId))?.title).toBe('Claude#2');
      } finally {
        await f.release(parent.card.id);
      }
    });
  });

  test('no Claude session id: terminal failure without placeholder session, never todo', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { childNoSession: true });
      const parent = await f.dispatchParent('codex');
      try {
        const accepted = await f.host.delegations.start(f.request(parent));
        const view = await f.terminal(accepted.runId);
        expect(view.status).toBe('failed');
        expect(view.sessionId).toBeUndefined();
        const child = await f.store.getCard(accepted.cardId);
        expect(child?.status).toBe('complete');
        expect(child?.resolution).toBe('failed');
        expect(child?.sessionId).toBeUndefined();
      } finally {
        await f.release(parent.card.id);
      }
    });
  });

  test('Claude spawn failure terminates the reservation and replays without respawn', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { claudeSpawnFailure: true });
      const parent = await f.dispatchParent('codex');
      try {
        const accepted = await f.host.delegations.start(f.request(parent));
        const view = await f.terminal(accepted.runId);
        expect(view.status).toBe('failed');
        expect(view.error).toBeTruthy();
        expect((await f.store.getCard(accepted.cardId))?.resolution).toBe('failed');
        expect((await f.host.delegations.start(f.request(parent))).runId).toBe(accepted.runId);
        expect(await f.childCaptures()).toHaveLength(0);
      } finally {
        await f.release(parent.card.id);
      }
    });
  });

  test('managed children cannot delegate again and non-Claude/Codex parents are refused', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { childGated: true });
      const parent = await f.dispatchParent('codex');
      try {
        const accepted = await f.host.delegations.start(f.request(parent));
        await eventually(() => f.host.runStore.getRun(accepted.runId), run => run?.status === 'running');
        await expect(f.host.delegations.start({ parentCardId: accepted.cardId, parentRunId: accepted.runId,
          requestId: 'nested', prompt: 'ping-pong' })).rejects.toThrow();
        const opencode = await f.store.createCard({ title: 'oc', description: 'x', agentRuntime: 'opencode', projectDir: dir });
        const ocRun = await f.host.runStore.createRun({ cardId: opencode.id, runtime: 'opencode', cwd: dir });
        await f.host.runStore.updateRun(ocRun.runId, { status: 'running' });
        await expect(f.host.delegations.start({ parentCardId: opencode.id, parentRunId: ocRun.runId,
          requestId: 'oc', prompt: 'x' })).rejects.toThrow();
      } finally {
        await f.releaseChild();
        await f.release(parent.card.id);
      }
    });
  });

  test('#48: Codex parent failure keeps the managed Claude child running but closes native children', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir, { childGated: true });
      const parent = await f.dispatchParent('codex', 'PARENT [parent-failure]');
      const native = await f.store.createCard({ title: 'native', description: 'native codex child',
        agentRuntime: 'codex', parentCardId: parent.card.id, linkKind: 'subagent', childRunId: parent.runId });
      await f.store.updateCard(native.id, { status: 'in_progress' });
      const accepted = await f.host.delegations.start(f.request(parent));
      try {
        await eventually(f.childCaptures, list => list.length === 1);
        await f.release(parent.card.id);
        await eventually(() => f.store.getCard(parent.card.id), card => card?.status === 'todo');
        expect((await f.store.getCard(native.id))?.resolution).toBe('superseded');
        const running = await f.store.getCard(accepted.cardId);
        expect(running?.status).toBe('in_progress');
        expect(running?.resolution).toBeUndefined();
      } finally {
        await f.release(parent.card.id);
        await f.releaseChild();
      }
      expect((await f.terminal(accepted.runId)).status).toBe('completed');
      expect((await f.store.getCard(accepted.cardId))?.result).toBe('claude findings\n\nclaude final');
    });
  });

  test('unmanaged Claude session in the same folder stays independent (no path/time/keyword linking)', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      const parent = await f.dispatchParent('codex');
      // e.g. `claude -p` run by hand or from a shell: hook-created, its own session.
      const shell = await f.store.createCard({ title: 'Review this', description: 'Review this',
        agentRuntime: 'claude', projectDir: dir, sourceContext: 'claude-code', sessionId: 'manual-shell-session' });
      await f.store.updateCard(shell.id, { status: 'in_progress' });
      try {
        const accepted = await f.host.delegations.start(f.request(parent));
        await f.terminal(accepted.runId);
        const after = await f.store.getCard(shell.id);
        expect(after?.parentCardId).toBeUndefined();
        expect(after?.sessionId).toBe('manual-shell-session');
        expect(after?.status).toBe('in_progress');
        expect((await f.store.getCard(accepted.cardId))?.sessionId).toBe(`claude-child-${accepted.runId}`);
      } finally {
        await f.release(parent.card.id);
      }
    });
  });

  test('restart recovery: unfinished Claude child fails with its partial output; committed success is kept', async () => {
    await withTempDir(async dir => {
      const f = await fixture(dir);
      const parentCard = await f.store.createCard({ title: 'codex parent', description: 'PARENT',
        agentRuntime: 'codex', projectDir: dir });
      await f.store.updateCard(parentCard.id, { status: 'in_progress', sessionId: 'codex-parent-session' });
      const parentRun = await f.host.runStore.createRun({ cardId: parentCard.id, runtime: 'codex', cwd: dir });
      await f.host.runStore.updateRun(parentRun.runId, { status: 'running', sessionId: 'codex-parent-session' });
      const reserve = (requestId: string) => f.host.runStore.reserveDelegation({
        parentCardId: parentCard.id, parentRunId: parentRun.runId, requestId, requestHash: requestId,
        model: DEFAULT_CLAUDE_MODEL, childRuntime: 'claude',
      }, async reserved => {
        await f.store.createDelegationCard({ id: reserved.cardId, runId: reserved.runId, runtime: 'claude',
          parentCardId: parentCard.id, parentRunId: parentRun.runId, prompt: requestId, model: DEFAULT_CLAUDE_MODEL, cwd: dir });
      });
      const { run: interrupted } = await reserve('interrupted');
      await f.host.runStore.updateRun(interrupted.runId, { status: 'running', sessionId: 'claude-child-x' });
      await Bun.write(interrupted.eventsPath, [
        { type: 'system', subtype: 'init', session_id: 'claude-child-x' },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'persisted partial claude' }] } },
      ].map(e => JSON.stringify(e)).join('\n') + '\n');
      const { run: committed } = await reserve('committed');
      expect(interrupted.runtime).toBe('claude');
      await f.store.updateCard(committed.cardId, { status: 'complete', resolution: 'completed',
        result: 'durable claude review', sessionId: 'claude-child-y' }, committed.runId);

      const restarted = await f.makeHost();
      await restarted.runStore.reconcileStale(f.store);
      const failed = await restarted.delegations.get(interrupted.runId);
      expect(failed.status).toBe('failed');
      expect(failed.result).toBe('persisted partial claude');
      const failedCard = await f.store.getCard(interrupted.cardId);
      expect(failedCard?.status).toBe('complete');
      expect(failedCard?.resolution).toBe('failed');
      expect(failedCard?.result).toBe('persisted partial claude');
      expect(failedCard?.parentCardId).toBe(parentCard.id);
      expect((await restarted.delegations.get(committed.runId)).status).toBe('completed');
      expect((await f.store.getCard(committed.cardId))?.sessionId).toBe('claude-child-y');
      // The parent run is interrupted (unknown outcome); restart never re-spawns a child.
      expect((await restarted.runStore.getRun(parentRun.runId))?.status).toBe('interrupted');
      expect(await f.childCaptures()).toHaveLength(0);
      await expect(restarted.delegations.start({ parentCardId: parentCard.id, parentRunId: parentRun.runId,
        requestId: 'after-restart', prompt: 'x' })).rejects.toThrow();
    });
  });
});
