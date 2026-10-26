import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KanbanStore } from '../core/store';
import type { CardResultResyncResponse } from '../core/types';
import { RuntimeRunStore } from '../plugin/runtimes/runtime-run-store';
import { CardResultResyncError, resyncCardResult } from '../plugin/runtimes/card-result-resync';
import { createRouteHandler } from '../server/routes';
import { withTempDir } from './setup';

const lines = (entries: object[]) => entries.map(entry => JSON.stringify(entry)).join('\n');

/** A one-turn Claude transcript whose prompt is stamped `now`. */
function claudeTranscript(prompt: string, answers: string[], stopReason = 'end_turn'): string {
  const now = new Date().toISOString();
  const entries: object[] = [{ type: 'user', uuid: 'p', parentUuid: null, timestamp: now, message: { role: 'user', content: prompt } }];
  answers.forEach((answer, i) => entries.push({
    type: 'assistant',
    uuid: `a${i}`,
    parentUuid: i === 0 ? 'p' : `a${i - 1}`,
    timestamp: now,
    message: { role: 'assistant', content: [{ type: 'text', text: answer }], ...(i === answers.length - 1 ? { stop_reason: stopReason } : {}) },
  }));
  return lines(entries);
}

async function expectFailure(promise: Promise<unknown>, reason: string): Promise<void> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(error).toBeInstanceOf(CardResultResyncError);
  expect((error as CardResultResyncError).reason).toBe(reason as CardResultResyncError['reason']);
}

describe('resyncCardResult', () => {
  test('fills a hook card that lost its result from its own turn', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({
        title: 'Q', description: '결과가 날아간 질문', sessionId: 'sess-1', agentRuntime: 'claude', sourceContext: 'claude-code', projectDir: dir,
      });
      const transcript = join(dir, 'sess-1.jsonl');
      writeFileSync(transcript, claudeTranscript('결과가 날아간 질문', ['중간 답', '최종 답']));

      const res = await resyncCardResult({ store, locateTranscript: () => ({ path: transcript, format: 'claude' }) }, card.id);

      expect(res).toMatchObject({ outcome: 'updated', source: 'transcript', turnCompleted: true, previousLength: 0, resultLength: '중간 답\n\n최종 답'.length });
      const saved = await store.getCard(card.id);
      expect(saved?.result).toBe('중간 답\n\n최종 답');
      expect(saved?.finalResult).toBe('최종 답');
      // Status is never touched by a sync — completing stays an explicit action.
      expect(saved?.status).toBe('todo');
    });
  });

  test('never regresses a result that is already longer', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Q', description: '질문', sessionId: 's', agentRuntime: 'claude' });
      await store.updateCard(card.id, { result: '이미 저장된 훨씬 더 긴 결과 텍스트', finalResult: '결과' });
      const transcript = join(dir, 's.jsonl');
      writeFileSync(transcript, claudeTranscript('질문', ['짧음']));

      const res = await resyncCardResult({ store, locateTranscript: () => ({ path: transcript, format: 'claude' }) }, card.id);

      expect(res.outcome).toBe('unchanged');
      expect((await store.getCard(card.id))?.result).toBe('이미 저장된 훨씬 더 긴 결과 텍스트');
    });
  });

  test('a dispatched card matches its run prompt.md, not the bare description', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({ title: 'Q', description: '원본 설명', sessionId: 'thread-1', agentRuntime: 'codex' });
      const run = await runStore.createRun({ cardId: card.id, runtime: 'codex', sessionId: 'thread-1', cwd: dir });
      await runStore.finishRun(run.runId, { status: 'failed' });
      const wrapped = '[Feedback for: x]\n---\n원본 설명';
      writeFileSync(run.promptPath, wrapped);
      const now = new Date().toISOString();
      const rolloutPath = join(dir, 'rollout.jsonl');
      writeFileSync(rolloutPath, lines([
        { timestamp: now, type: 'event_msg', payload: { type: 'task_started' } },
        { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: wrapped }] } },
        { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex 답' }] } },
        { timestamp: now, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'codex 답' } },
      ]));

      const res = await resyncCardResult(
        { store, runStore, locateTranscript: () => ({ path: rolloutPath, format: 'codex' }) },
        card.id,
      );
      expect(res).toMatchObject({ outcome: 'updated', turnCompleted: true });
      expect((await store.getCard(card.id))?.result).toBe('codex 답');
    });
  });

  test('falls back to the run events.jsonl when the transcript is gone', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const card = await store.createCard({ title: 'Q', description: 'D', sessionId: 'old', agentRuntime: 'claude' });
      const run = await runStore.createRun({ cardId: card.id, runtime: 'claude', sessionId: 'old', cwd: dir });
      await runStore.finishRun(run.runId, { status: 'aborted' });
      writeFileSync(run.eventsPath, lines([
        { type: 'assistant', message: { content: [{ type: 'text', text: '기록된 답' }] } },
      ]));

      const res = await resyncCardResult({ store, runStore, locateTranscript: () => undefined }, card.id);
      expect(res).toMatchObject({ outcome: 'updated', source: 'run_events', turnCompleted: false });
    });
  });

  test('refuses while a run is active, and for cards it cannot sync', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const runStore = new RuntimeRunStore(dir);
      const running = await store.createCard({ title: 'R', description: 'D', sessionId: 's', agentRuntime: 'claude' });
      await runStore.createRun({ cardId: running.id, runtime: 'claude', cwd: dir });
      await expectFailure(resyncCardResult({ store, runStore }, running.id), 'run_active');

      const opencode = await store.createCard({ title: 'O', description: 'D', sessionId: 's' });
      await expectFailure(resyncCardResult({ store }, opencode.id), 'unsupported_runtime');

      const noSession = await store.createCard({ title: 'N', description: 'D', agentRuntime: 'codex' });
      await expectFailure(resyncCardResult({ store }, noSession.id), 'no_session');

      const lost = await store.createCard({ title: 'L', description: 'D', sessionId: 'gone', agentRuntime: 'claude' });
      await expectFailure(resyncCardResult({ store, locateTranscript: () => undefined }, lost.id), 'transcript_not_found');
    });
  });

  test('a prompt that never reached the session leaves the card untouched', async () => {
    await withTempDir(async (dir) => {
      const store = new KanbanStore(dir);
      const card = await store.createCard({ title: 'Q', description: '보내지 못한 프롬프트', sessionId: 's', agentRuntime: 'claude' });
      await store.updateCard(card.id, { result: 'Error: That session is running in the background' });
      const transcript = join(dir, 's.jsonl');
      writeFileSync(transcript, claudeTranscript('사용자가 직접 이어간 대화', ['관계없는 긴 답변입니다']));

      await expectFailure(
        resyncCardResult({ store, locateTranscript: () => ({ path: transcript, format: 'claude' }) }, card.id),
        'prompt_not_found',
      );
      expect((await store.getCard(card.id))?.result).toBe('Error: That session is running in the background');
    });
  });
});

describe('POST /api/cards/:id/resync', () => {
  test('locates a codex rollout under CODEX_HOME and returns the sync outcome', async () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'ak-resync-codex-'));
    const original = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      await withTempDir(async (dir) => {
        const store = new KanbanStore(dir);
        const sessionId = 'aktest-resync-0000-7000-000000000001';
        const card = await store.createCard({ title: 'Q', description: 'codex 질문', sessionId, agentRuntime: 'codex', sourceContext: 'codex' });
        const now = new Date().toISOString();
        const rollout = join(codexHome, 'sessions', '2026', '10', '26', `rollout-2026-10-26T00-00-00-${sessionId}.jsonl`);
        mkdirSync(join(codexHome, 'sessions', '2026', '10', '26'), { recursive: true });
        writeFileSync(rollout, lines([
          { timestamp: now, type: 'event_msg', payload: { type: 'task_started' } },
          { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'codex 질문' }] } },
          { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '먼저 확인' }] } },
          { timestamp: now, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '최종' }] } },
          { timestamp: now, type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '최종' } },
        ]));

        const handleRequest = createRouteHandler(store).handleRequest;
        const res = await handleRequest(new Request(`http://localhost/api/cards/${card.id}/resync`, { method: 'POST' }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as CardResultResyncResponse;
        expect(body).toMatchObject({ outcome: 'updated', source: 'transcript', turnCompleted: true });
        expect(body.card.result).toBe('먼저 확인\n\n최종');
        expect(body.card.finalResult).toBe('최종');

        const missing = await handleRequest(new Request('http://localhost/api/cards/nope/resync', { method: 'POST' }));
        expect(missing.status).toBe(404);
        expect(await missing.json()).toEqual({ error: 'Card not found' });
      });
    } finally {
      if (original === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = original;
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
