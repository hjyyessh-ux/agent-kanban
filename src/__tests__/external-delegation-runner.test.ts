import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { withTempDir } from './setup';
import { KanbanStore } from '../core/store';
import { SettingsStore } from '../core/settings-store';
import { createStandaloneRuntimeHost } from '../plugin/runtimes/runtime-host';

describe('tracked delegation CLI runner', () => {
  test('dispatched Claude inherits the actual listening API URL instead of a guessed default port', async () => {
    await withTempDir(async dir => {
      const fake = join(dir, 'claude.ts');
      const capture = join(dir, 'api-url');
      await Bun.write(fake, `
for await (const _ of Bun.stdin.stream()) {}
await Bun.write(${JSON.stringify(capture)}, process.env.KANBAN_API_URL ?? 'missing');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:'api-url-parent'}));
console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'done'}]}}));
`);
      const store = new KanbanStore(dir);
      const host = await createStandaloneRuntimeHost({ store, settingsStore: new SettingsStore(dir),
        dataDir: dir, claudeCommandOverride: [process.execPath, fake] });
      host.setApiUrl('http://127.0.0.1:39991');
      const card = await store.createCard({ title: 'URL parent', description: 'parent',
        agentRuntime: 'claude', projectDir: dir });
      const dispatched = await host.dispatchCard(card.id);
      expect(await Bun.file(capture).text()).toBe('http://127.0.0.1:39991');
      const deadline = Date.now() + 4_000;
      while (['starting', 'running'].includes((await host.runStore.getRun(dispatched.runId!))!.status)
        && Date.now() < deadline) await Bun.sleep(10);
      expect((await host.runStore.getRun(dispatched.runId!))?.status).toBe('completed');
    });
  });
  test('sends stdin and inherited parent identity with auth, then prints the complete review', async () => {
    await withTempDir(async dir => {
      const operator = 'B'.repeat(43);
      const requests: { method: string; authorization: string | null; body?: unknown }[] = [];
      let reads = 0;
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
        requests.push({ method: req.method, authorization: req.headers.get('authorization'),
          body: req.method === 'POST' ? await req.json() : undefined });
        const identity = { runId: 'stable-run', cardId: 'child', parentRunId: 'parent-run' };
        return Response.json(req.method === 'POST' || reads++ === 0
          ? { ...identity, status: 'running' }
          : { ...identity, status: 'completed', result: '중간 의견\n\n최종 리뷰' });
      } });
      try {
        const proc = Bun.spawn([process.execPath, resolve('scripts/delegate-review.ts'),
          '--request-id', 'stable-request', '--model', 'gpt-6-astra', '--parent-card', 'parent-card', '--parent-run', 'parent-run'], {
          env: { ...process.env, KANBAN_DATA_DIR: dir, KANBAN_DELEGATION_OPERATOR_TOKEN: operator,
            KANBAN_API_URL: `http://127.0.0.1:${server.port}`,
            AGENT_KANBAN_DISPATCH_CARD_ID: 'parent-card', AGENT_KANBAN_DISPATCH_RUN_ID: 'parent-run' },
          stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
        });
        proc.stdin.write('리뷰 요청 전문');
        proc.stdin.end();
        const [exit, stdout, stderr] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        expect(exit).toBe(0);
        expect(stdout.trim()).toBe('중간 의견\n\n최종 리뷰');
        expect(stderr).toContain('stable-run');
        expect(requests.filter(r => r.method === 'POST')).toHaveLength(1);
        expect(requests[0]?.body).toEqual({ parentCardId: 'parent-card', parentRunId: 'parent-run',
          requestId: 'stable-request', model: 'gpt-6-astra', prompt: '리뷰 요청 전문' });
        expect(requests.every(r => r.authorization === `Bearer ${operator}`)).toBe(true);
      } finally { server.stop(true); }
    });
  });

  test('run-id resumes reads without creating another review and returns failure with preserved output', async () => {
    await withTempDir(async dir => {
      const operator = 'C'.repeat(43);
      const methods: string[] = [];
      const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(req) {
        methods.push(req.method);
        return Response.json({ runId: 'interrupted', cardId: 'deleted-child', parentRunId: 'parent',
          status: 'failed', result: 'partial findings', error: 'injected interruption' });
      } });
      try {
        const proc = Bun.spawn([process.execPath, resolve('scripts/delegate-review.ts'), '--run-id', 'interrupted'], {
          env: { ...process.env, KANBAN_DATA_DIR: dir, KANBAN_DELEGATION_OPERATOR_TOKEN: operator,
            KANBAN_API_URL: `http://127.0.0.1:${server.port}`,
            AGENT_KANBAN_DISPATCH_CARD_ID: '', AGENT_KANBAN_DISPATCH_RUN_ID: '' },
          stdout: 'pipe', stderr: 'pipe',
        });
        const [exit, stdout, stderr] = await Promise.all([
          proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
        ]);
        expect(exit).toBe(1);
        expect(stdout).toContain('partial findings');
        expect(stderr).toContain('injected interruption');
        expect(methods).toEqual(['GET']);
      } finally { server.stop(true); }
    });
  });
});
