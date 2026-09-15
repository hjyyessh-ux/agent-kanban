import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveClaudeTranscriptPath } from '../plugin/wiki/wiki-transcript';
import { KanbanStore } from '../core/store';
import { WorkStore } from '../core/work-store';
import { SettingsStore } from '../core/settings-store';
import { WikiWorker } from '../plugin/wiki/wiki-worker';
import { WIKI_SETTING_KEYS } from '../plugin/wiki/wiki-config';
import { createRouteHandler } from '../server/routes';
import { renderReferenceBlock } from '../core/mention-reference';
import type { MentionResolveResponse } from '../core/mention-reference';
import type { MentionSearchResponse } from '../core/mention-search';
import { withTempDir } from './setup';
import type { KanbanCard } from '../core/types';

/**
 * The two read-only mention routes.
 *
 * Everything here is board-only by construction — the archive guard itself
 * lives in `mention-no-archive.test.ts`, which is the test that keeps a future
 * refactor from quietly reintroducing a 71MB scan on every keystroke.
 */

/** createRouteHandler with only wikiWorker (arg 14) and workStore (arg 22) wired. */
function handlerWith(
  store: KanbanStore,
  opts: { workStore?: WorkStore; wikiWorker?: WikiWorker } = {},
) {
  return createRouteHandler(
    store,
    undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined,
    opts.wikiWorker,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    opts.workStore,
  );
}

async function seedCard(
  store: KanbanStore,
  input: Partial<KanbanCard> & { title: string; description: string },
): Promise<KanbanCard> {
  const { title, description, ...rest } = input;
  const card = await store.createCard({ title, description });
  return store.updateCard(card.id, rest);
}

async function wikiWorkerWithVault(dir: string, vaultDir: string): Promise<WikiWorker> {
  const settingsStore = new SettingsStore(dir);
  await settingsStore.upsertByKey(WIKI_SETTING_KEYS.vaultDir, vaultDir);
  return new WikiWorker(new KanbanStore(dir), settingsStore, { llmRunner: async () => '' });
}

function seedVault(root: string, relPaths: string[]): string {
  const vaultDir = join(root, 'vault');
  for (const rel of relPaths) {
    const abs = join(vaultDir, rel);
    mkdirSync(abs.slice(0, abs.lastIndexOf('/')), { recursive: true });
    writeFileSync(abs, `# ${rel}\n`);
  }
  return vaultDir;
}

async function searchMentions(
  handleRequest: (req: Request) => Promise<Response>,
  query: string,
): Promise<MentionSearchResponse> {
  const res = await handleRequest(new Request(`http://localhost/api/mentions${query}`));
  expect(res.status).toBe(200);
  return await res.json() as MentionSearchResponse;
}

async function resolveMentions(
  handleRequest: (req: Request) => Promise<Response>,
  tokens: string[],
): Promise<MentionResolveResponse> {
  const query = tokens.map((t) => `token=${encodeURIComponent(t)}`).join('&');
  const res = await handleRequest(new Request(`http://localhost/api/mentions/resolve?${query}`));
  expect(res.status).toBe(200);
  return await res.json() as MentionResolveResponse;
}

describe('GET /api/mentions', () => {
  test('answers with grouped candidates and pre-limit totals', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, { workStore });

      await seedCard(store, { title: 'test', description: '텔레그램 폴러 중복 카드', sessionId: 'aaaa1111-1111' });
      await seedCard(store, { title: 'test', description: '위키 백필', sessionId: 'bbbb2222-2222' });
      await workStore.createWork({ title: '텔레그램 연동 안정화' });

      const body = await searchMentions(handleRequest, '?q=텔레그램');

      expect(body.q).toBe('텔레그램');
      expect(Object.keys(body.groups).sort()).toEqual(['docs', 'sessions', 'works']);
      expect(body.groups.sessions.map((c) => c.id)).toEqual(['aaaa1111']);
      expect(body.groups.sessions[0].snippet).toEqual({ field: 'description', text: '텔레그램 폴러 중복 카드' });
      expect(body.groups.works.map((c) => c.label)).toEqual(['텔레그램 연동 안정화']);
      expect(body.totals).toEqual({ sessions: 1, works: 1, docs: 0 });
    });
  });

  test('an empty query lists the board sessions', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);

      await seedCard(store, { title: 'a', description: 'a', sessionId: 'aaaa1111' });
      await seedCard(store, { title: 'b', description: 'b', sessionId: 'bbbb2222' });
      await seedCard(store, { title: 'no session', description: 'todo only' });

      const body = await searchMentions(handleRequest, '');
      expect(body.groups.sessions.length).toBe(2);
      expect(body.totals.sessions).toBe(2);
    });
  });

  test('limit slices the group while totals keep the real count', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);
      for (let i = 0; i < 5; i++) {
        await seedCard(store, { title: `t${i}`, description: '텔레그램', sessionId: `sess${i}aaa` });
      }

      const body = await searchMentions(handleRequest, '?q=텔레그램&limit=2');
      expect(body.groups.sessions.length).toBe(2);
      expect(body.totals.sessions).toBe(5);
    });
  });

  test('kind narrows to one group, and an unknown kind is a 400', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const workStore = new WorkStore(dir);
      const { handleRequest } = handlerWith(store, { workStore });

      await seedCard(store, { title: 'test', description: '텔레그램', sessionId: 'aaaa1111' });
      await workStore.createWork({ title: '텔레그램 연동' });

      const body = await searchMentions(handleRequest, '?q=텔레그램&kind=work');
      expect(body.groups.sessions).toEqual([]);
      expect(body.groups.works.length).toBe(1);
      expect(body.totals).toEqual({ sessions: 0, works: 1, docs: 0 });

      const bad = await handleRequest(new Request('http://localhost/api/mentions?kind=card'));
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'kind must be one of: all, session, work, doc' });
    });
  });

  test('excludeSession flags the current session instead of hiding the tab', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);

      await seedCard(store, { title: 'mine', description: '텔레그램', sessionId: 'aaaa1111' });
      await seedCard(store, { title: 'other', description: '텔레그램', sessionId: 'bbbb2222' });

      const body = await searchMentions(handleRequest, '?q=텔레그램&excludeSession=aaaa1111');
      const self = body.groups.sessions.find((c) => c.id === 'aaaa1111');
      expect(self?.disabledReason).toBe('self');
      expect(body.groups.sessions[0].id).toBe('bbbb2222');
    });
  });

  describe('docs pool', () => {
    test('no wikiWorker means docs: [] — never a 503', async () => {
      await withTempDir(async (dir) => {
        const { handleRequest } = handlerWith(new KanbanStore(dir));
        const body = await searchMentions(handleRequest, '?q=telegram');

        expect(body.groups.docs).toEqual([]);
        expect(body.totals.docs).toBe(0);
      });
    });

    test('an unset vaultDir means docs: [] while the other tabs still answer', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const settingsStore = new SettingsStore(dir);
        const wikiWorker = new WikiWorker(store, settingsStore, { llmRunner: async () => '' });
        const { handleRequest } = handlerWith(store, { wikiWorker });

        await seedCard(store, { title: 'test', description: '텔레그램', sessionId: 'aaaa1111' });

        const body = await searchMentions(handleRequest, '?q=텔레그램');
        expect(body.groups.docs).toEqual([]);
        expect(body.groups.sessions.length).toBe(1);
      });
    });

    test('candidates come from a direct vault scan, nested files included', async () => {
      await withTempDir(async (dir) => {
        const vaultDir = seedVault(dir, [
          'troubleshooting/telegram-poller-dup.md',
          'howto/wiki-backfill.md',
          'index.md',
          'attachments/not-markdown.png',
        ]);
        const store = new KanbanStore(dir);
        const { handleRequest } = handlerWith(store, { wikiWorker: await wikiWorkerWithVault(dir, vaultDir) });

        const all = await searchMentions(handleRequest, '');
        expect(all.totals.docs).toBe(3);
        expect(all.groups.docs.some((c) => c.id === 'attachments/not-markdown.png')).toBe(false);

        const filtered = await searchMentions(handleRequest, '?q=telegram-poller');
        expect(filtered.groups.docs.map((c) => c.id)).toEqual(['troubleshooting/telegram-poller-dup.md']);
        expect(filtered.groups.docs[0].snippet?.field).toBe('path');
      });
    });
  });
});

describe('GET /api/mentions/resolve', () => {
  test('resolves a session prefix into card metadata and a transcript verdict', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);

      await seedCard(store, {
        title: 'test',
        description: '텔레그램 폴러 중복 카드를 고쳐줘',
        sessionId: 'kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552',
        status: 'complete',
        agentRuntime: 'claude',
        model: 'claude-opus-5',
        projectDir: '/Users/nobody/workspace/agent-kanban',
        startedAt: '2026-09-12T05:20:00.000Z',
        completedAt: '2026-09-12T06:58:00.000Z',
        result: '폴러 dedup 키를 messageId 기준으로 변경',
      });

      const { references } = await resolveMentions(handleRequest, ['@session:kx9f2a1b']);
      expect(references.length).toBe(1);
      const [ref] = references;

      expect(ref.kind).toBe('session');
      expect(ref.unresolved).toBeUndefined();
      expect(ref.sessionId).toBe('kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552');
      expect(ref.title).toBe('텔레그램 폴러 중복 카드를 고쳐줘');
      expect(ref.cardStatus).toBe('complete');
      expect(ref.agentRuntime).toBe('claude');
      expect(ref.model).toBe('claude-opus-5');
      expect(ref.projectDir).toBe('/Users/nobody/workspace/agent-kanban');
      expect(ref.resultExcerpt).toBe('폴러 dedup 키를 messageId 기준으로 변경');
      // 그 경로에 파일이 없으므로 참조는 살리고 메타데이터만 전달한다.
      expect(ref.transcriptPath).toBeUndefined();
      expect(ref.transcriptMissing).toBe('file_missing');

      // 렌더까지 통과해야 라우트 출력이 실제로 블록이 된다.
      expect(renderReferenceBlock(references)).toContain('- transcript: 없음 (파일 없음)');
    });
  });

  test('a claude session with no projectDir cannot have a transcript path', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);
      await seedCard(store, {
        title: 'test',
        description: 'x',
        sessionId: 'aaaa1111-2222',
        agentRuntime: 'claude',
      });

      const { references } = await resolveMentions(handleRequest, ['@session:aaaa1111']);
      expect(references[0].transcriptMissing).toBe('no_project_dir');
    });
  });

  // codex rollout은 `~/.codex/sessions/**/rollout-*-<sessionId>.jsonl`이라 경로에
  // projectDir이 들어가지 않는다. 그래서 projectDir이 없다는 사실이 codex 세션의
  // 실패 이유가 되면 안 된다 — 파일이 없으면 그냥 없는 것이다.
  test('a codex session without projectDir reports file_missing, not no_project_dir', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);
      await seedCard(store, {
        title: 'test',
        description: 'x',
        sessionId: 'cccc3333-4444',
        agentRuntime: 'codex',
      });

      const { references } = await resolveMentions(handleRequest, ['@session:cccc3333']);
      expect(references[0].transcriptMissing).toBe('file_missing');
    });
  });

  // opencode는 로컬 transcript를 아예 남기지 않는다. projectDir 유무보다 이쪽이
  // 먼저다 — projectDir을 채워 준다고 파일이 생기지 않기 때문이다.
  test('an opencode session is runtime_unsupported whatever its projectDir says', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);
      await seedCard(store, {
        title: 'test',
        description: 'x',
        sessionId: 'dddd5555-6666',
        projectDir: '/tmp/p',
        agentRuntime: 'opencode',
      });

      const { references } = await resolveMentions(handleRequest, ['@session:dddd5555']);
      expect(references[0].transcriptMissing).toBe('runtime_unsupported');
    });
  });

  test('an existing transcript carries its byte size', async () => {
    await withTempDir(async (dir) => {
      // `resolveClaudeTranscriptPath` reads `homedir()` and Bun resolves that
      // once per process, so there is no seam to point it at a temp home. The
      // fixture therefore lands at the real path the route will look at — under
      // a project directory munged from this run's temp dir, so it can collide
      // with nothing — and is removed again below.
      const projectDir = join(dir, 'project');
      const sessionId = 'kx9f2a1b-7c3e-4d21-9a08-11b4f6e0c552';
      const transcriptPath = resolveClaudeTranscriptPath(projectDir, sessionId);
      mkdirSync(dirname(transcriptPath), { recursive: true });
      writeFileSync(transcriptPath, 'x'.repeat(2048));

      try {
        const store = new KanbanStore(dir);
        const { handleRequest } = handlerWith(store);
        await seedCard(store, {
          title: 'test',
          description: 'x',
          sessionId,
          projectDir,
          agentRuntime: 'claude',
        });

        const { references } = await resolveMentions(handleRequest, ['@session:kx9f2a1b']);
        expect(references[0].transcriptPath).toBe(transcriptPath);
        expect(references[0].transcriptSize).toBe(2048);
        expect(references[0].transcriptMissing).toBeUndefined();
        expect(renderReferenceBlock(references)).toContain('(2.0KB — Read 가능)');
      } finally {
        rmSync(dirname(transcriptPath), { recursive: true, force: true });
      }
    });
  });

  test('a prefix matching two sessions is ambiguous, not a guess', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);

      await seedCard(store, { title: 'a', description: 'a', sessionId: 'kx9f2a1b-aaaa' });
      await seedCard(store, { title: 'b', description: 'b', sessionId: 'kx9f2a1b-bbbb' });

      const short = await resolveMentions(handleRequest, ['@session:kx9f2a1b']);
      expect(short.references[0].unresolved).toBe('ambiguous');
      expect(short.references[0].sessionId).toBeUndefined();

      // 더 긴 접두사를 쓰면 해석된다 — 칩이 요구하는 그 동작.
      const longer = await resolveMentions(handleRequest, ['@session:kx9f2a1b-aaaa']);
      expect(longer.references[0].unresolved).toBeUndefined();
      expect(longer.references[0].sessionId).toBe('kx9f2a1b-aaaa');
    });
  });

  test('a session that is no longer on the board is not_found', async () => {
    await withTempDir(async (dir) => {
      const { handleRequest } = handlerWith(new KanbanStore(dir));
      const { references } = await resolveMentions(handleRequest, ['@session:gone1234']);

      expect(references[0]).toMatchObject({ kind: 'session', id: 'gone1234', unresolved: 'not_found' });
    });
  });

  test('at most 8 tokens are processed, the rest are ignored', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const { handleRequest } = handlerWith(store);
      const tokens = Array.from({ length: 11 }, (_, i) => `@session:sess${i}aaa`);

      const { references } = await resolveMentions(handleRequest, tokens);
      expect(references.length).toBe(8);
      expect(references.map((r) => r.id)).toEqual(tokens.slice(0, 8).map((t) => t.slice('@session:'.length)));
    });
  });

  test('duplicate and malformed tokens are dropped', async () => {
    await withTempDir(async (dir) => {
      const { handleRequest } = handlerWith(new KanbanStore(dir));
      const { references } = await resolveMentions(handleRequest, [
        '@session:aaaa1111',
        '@session:aaaa1111',
        'not-a-token',
        '@card:k5mR0pBn',
      ]);

      expect(references.map((r) => r.raw)).toEqual(['@session:aaaa1111']);
    });
  });

  test('no token at all is an empty reference list, not an error', async () => {
    await withTempDir(async (dir) => {
      const { handleRequest } = handlerWith(new KanbanStore(dir));
      const res = await handleRequest(new Request('http://localhost/api/mentions/resolve'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ references: [] });
    });
  });

  describe('work tokens', () => {
    test('carry counts, summary lines and per-session transcript verdicts', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const workStore = new WorkStore(dir);
        const { handleRequest } = handlerWith(store, { workStore });

        await seedCard(store, { title: 'a', description: 'a', sessionId: 'aaaa1111', projectDir: '/tmp/p', agentRuntime: 'codex' });
        await seedCard(store, { title: 'b', description: 'b', sessionId: 'aaaa1111', projectDir: '/tmp/p', agentRuntime: 'codex' });

        const created = await workStore.createWork({ title: 'Telegram 연동 안정화' });
        await workStore.addSession(created.id, { sessionId: 'aaaa1111', projectDir: '/tmp/p' });
        // 아카이브된 세션 — 보드에 카드가 없어도 링크의 projectDir로 판정한다.
        await workStore.addSession(created.id, { sessionId: 'bbbb2222', projectDir: '/tmp/p' });
        await workStore.updateWork(created.id, {
          summary: { lines: ['한 줄', '두 줄'], generatedAt: '2026-09-12T00:00:00.000Z', model: 'claude-opus-5' },
        });

        const { references } = await resolveMentions(handleRequest, [`@work:${created.id}`]);
        const [ref] = references;

        expect(ref.kind).toBe('work');
        expect(ref.title).toBe('Telegram 연동 안정화');
        expect(ref.workStatus).toBe('active');
        expect(ref.sessionCount).toBe(2);
        expect(ref.cardCount).toBe(2);
        expect(ref.summaryLines).toEqual(['한 줄', '두 줄']);
        expect(ref.workSessions?.map((s) => s.sessionId)).toEqual(['aaaa1111', 'bbbb2222']);
        // 둘 다 파일이 없다. codex 세션이라고 `runtime_unsupported`로 접히지
        // 않는 것이 요점 — rollout을 찾아본 뒤 없어서 `file_missing`이다.
        expect(ref.workSessions?.map((s) => s.transcriptMissing))
          .toEqual(['file_missing', 'file_missing']);
        expect(ref.workSessions?.every((s) => s.transcriptFormat === undefined)).toBe(true);
      });
    });

    test('an unknown work id, or no work store at all, resolves to not_found', async () => {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const withoutStore = handlerWith(store);
        const withStore = handlerWith(store, { workStore: new WorkStore(dir) });

        const a = await resolveMentions(withoutStore.handleRequest, ['@work:wTg4hN2']);
        expect(a.references[0].unresolved).toBe('not_found');

        const b = await resolveMentions(withStore.handleRequest, ['@work:wTg4hN2']);
        expect(b.references[0].unresolved).toBe('not_found');
      });
    });
  });

  describe('doc tokens', () => {
    test('resolve to an absolute vault path', async () => {
      await withTempDir(async (dir) => {
        const vaultDir = seedVault(dir, ['troubleshooting/telegram-poller-dup.md']);
        const store = new KanbanStore(dir);
        const { handleRequest } = handlerWith(store, { wikiWorker: await wikiWorkerWithVault(dir, vaultDir) });

        const { references } = await resolveMentions(handleRequest, ['@doc:troubleshooting/telegram-poller-dup.md']);
        const [ref] = references;

        expect(ref.unresolved).toBeUndefined();
        expect(ref.docPath).toBe('troubleshooting/telegram-poller-dup.md');
        expect(ref.docAbsPath).toBe(join(vaultDir, 'troubleshooting/telegram-poller-dup.md'));
        expect(ref.title).toBe('telegram-poller-dup');
      });
    });

    test('a percent-encoded path round-trips', async () => {
      await withTempDir(async (dir) => {
        const vaultDir = seedVault(dir, ['AI_GENERATED/멘션 설계.md']);
        const store = new KanbanStore(dir);
        const { handleRequest } = handlerWith(store, { wikiWorker: await wikiWorkerWithVault(dir, vaultDir) });

        const token = `@doc:AI_GENERATED/${encodeURIComponent('멘션 설계.md')}`;
        const { references } = await resolveMentions(handleRequest, [token]);

        expect(references[0].docPath).toBe('AI_GENERATED/멘션 설계.md');
        expect(references[0].docAbsPath).toBe(join(vaultDir, 'AI_GENERATED/멘션 설계.md'));
      });
    });

    test('a missing file and a traversal attempt are both not_found', async () => {
      await withTempDir(async (dir) => {
        const vaultDir = seedVault(dir, ['index.md']);
        const store = new KanbanStore(dir);
        const { handleRequest } = handlerWith(store, { wikiWorker: await wikiWorkerWithVault(dir, vaultDir) });

        const { references } = await resolveMentions(handleRequest, [
          '@doc:howto/never-written.md',
          '@doc:../../etc/passwd',
        ]);

        expect(references[0].unresolved).toBe('not_found');
        expect(references[1].unresolved).toBe('not_found');
        expect(references[1].docAbsPath).toBeUndefined();
      });
    });

    test('without a vault the path is kept relative rather than rejected', async () => {
      await withTempDir(async (dir) => {
        const { handleRequest } = handlerWith(new KanbanStore(dir));
        const { references } = await resolveMentions(handleRequest, ['@doc:howto/wiki-backfill.md']);

        expect(references[0].unresolved).toBeUndefined();
        expect(references[0].docPath).toBe('howto/wiki-backfill.md');
        expect(references[0].docAbsPath).toBeUndefined();
      });
    });
  });
});
