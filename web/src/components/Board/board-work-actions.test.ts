import { describe, expect, mock, test } from 'bun:test';
import type { MoveWorkSessionResponse, Work, WorkInboxSession } from '../../../../src/core/types';
import type { WorkSessionNoticeState } from '../Works/WorkSessionNotice';
import { applyWorkDropAction, type BoardWorkMutations } from './board-work-actions';

function work(id: string, title = `Work ${id}`): Work {
  return {
    id,
    title,
    status: 'active',
    sessionLinks: [],
    startedAt: '2026-10-20T00:00:00.000Z',
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

const W1 = work('W1', 'Alpha');
const W2 = work('W2', 'Beta');
const session = { sessionId: 's1', projectDir: '/repo' };

function setup(overrides: Partial<BoardWorkMutations> = {}) {
  const notices: WorkSessionNoticeState[] = [];
  const mutations: BoardWorkMutations = {
    link: mock(async (workId: string) => work(workId, workId === 'W1' ? 'Alpha' : 'Beta')),
    move: mock(async (_sessionId: string, input: { toWorkId: string }): Promise<MoveWorkSessionResponse> => ({
      from: W2,
      to: work(input.toWorkId, 'Alpha'),
    })),
    unlink: mock(async (workId: string) => work(workId)),
    createWithSession: mock(async (_session: WorkInboxSession, title: string) => work('NEW', title)),
    moveToNewWork: mock(async (_session: { sessionId: string }, title: string): Promise<MoveWorkSessionResponse> => ({
      from: W2,
      to: work('NEW', title),
    })),
    deleteWork: mock(async () => {}),
    notify: (notice) => { notices.push(notice); },
    ...overrides,
  };
  return { mutations, notices };
}

const works = [W1, W2];

describe('applyWorkDropAction', () => {
  test('link → links, notice undo unlinks', async () => {
    const { mutations, notices } = setup();
    await applyWorkDropAction({ action: { kind: 'link', toWorkId: 'W1' }, session, works, mutations });
    expect(mutations.link).toHaveBeenCalledWith('W1', session);
    expect(notices[0].tone).toBe('success');
    await notices[0].undo?.run();
    expect(mutations.unlink).toHaveBeenCalledWith('W1', 's1');
  });

  test('move → moves, notice undo moves back to the source', async () => {
    const { mutations, notices } = setup();
    await applyWorkDropAction({ action: { kind: 'move', fromWorkId: 'W2', toWorkId: 'W1' }, session, works, mutations });
    expect(mutations.move).toHaveBeenCalledWith('s1', { toWorkId: 'W1' });
    expect(notices[0].message).toContain('Beta');
    expect(notices[0].message).toContain('Alpha');
    await notices[0].undo?.run();
    expect(mutations.move).toHaveBeenLastCalledWith('s1', { toWorkId: 'W2' });
  });

  test('a move that empties (and deletes) the source offers no undo', async () => {
    const { mutations, notices } = setup({
      move: mock(async (): Promise<MoveWorkSessionResponse> => ({ from: null, to: W1 })),
    });
    await applyWorkDropAction({ action: { kind: 'move', fromWorkId: 'W2', toWorkId: 'W1' }, session, works, mutations });
    expect(notices[0].tone).toBe('warn');
    expect(notices[0].undo).toBeUndefined();
  });

  test('unlink → unlinks, notice undo re-links', async () => {
    const { mutations, notices } = setup();
    await applyWorkDropAction({ action: { kind: 'unlink', fromWorkId: 'W2' }, session, works, mutations });
    expect(mutations.unlink).toHaveBeenCalledWith('W2', 's1');
    await notices[0].undo?.run();
    expect(mutations.link).toHaveBeenCalledWith('W2', session);
  });

  test('create needs a title; undo deletes the new Work', async () => {
    const { mutations, notices } = setup();
    const inboxSession: WorkInboxSession = {
      sessionId: 's1',
      cardTitle: 'Session one',
      cardId: 'c1',
      cardStatus: 'complete',
      projectDir: '/repo',
      agentRuntime: 'claude',
      relatedCardCount: 1,
      sessionKind: 'main',
      updatedAt: '2026-10-20T00:00:00.000Z',
    };
    await applyWorkDropAction({ action: { kind: 'create' }, session, works, mutations });
    expect(mutations.createWithSession).not.toHaveBeenCalled();
    await applyWorkDropAction({ action: { kind: 'create' }, session, inboxSession, title: 'Fresh', works, mutations });
    expect(mutations.createWithSession).toHaveBeenCalledWith(inboxSession, 'Fresh');
    await notices[0].undo?.run();
    expect(mutations.deleteWork).toHaveBeenCalledWith('NEW');
  });

  test('moveToNew splits out; undo moves back to the source', async () => {
    const { mutations, notices } = setup();
    await applyWorkDropAction({ action: { kind: 'moveToNew', fromWorkId: 'W2' }, session, title: 'Split', works, mutations });
    expect(mutations.moveToNewWork).toHaveBeenCalledWith(session, 'Split');
    await notices[0].undo?.run();
    expect(mutations.move).toHaveBeenCalledWith('s1', { toWorkId: 'W2' });
  });

  test('a rejected mutation becomes a warn notice, not a thrown drop', async () => {
    const { mutations, notices } = setup({ link: mock(async () => { throw new Error('409 archived'); }) });
    await applyWorkDropAction({ action: { kind: 'link', toWorkId: 'W1' }, session, works, mutations });
    expect(notices[0]).toEqual({ tone: 'warn', message: '⚠ 409 archived' });
  });
});
