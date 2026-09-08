import { describe, expect, test } from 'bun:test';
import type {
  KanbanCard,
  Work,
  WorkCompletionPreview,
  WorkInboxSession,
  WorkSessionLink,
  WorksConfigDto,
} from '../../../../src/core/types';
import {
  confirmDeleteWorkMessage,
  describeBulkAssignProgress,
  describeCompletionByStatus,
  describeSessionState,
  describeWorkCompletion,
  describeWorkCompletionBlock,
  describeWorkArtifacts,
  describeWorkDiscard,
  describeWorkStatusBadge,
  inboxSessionFromLink,
  mergeSessionsForAssign,
  recommendWorksForSession,
  requiresDoneConfirm,
  resolveBulkAssignShortcut,
  resolvedWorksNewestFirst,
  rowIndexAtPointer,
  sessionIdsBetween,
  workAgeDays,
  workCompletionBlock,
  WORK_STATUS_LABELS,
  WORK_LIST_SORT_LABELS,
  describeWorkMergeImpact,
  describeWorkPlanOverrun,
  describeWorkReopen,
  mergeTargetsFor,
} from './worksAssign';

function work(overrides: Partial<Work> & Pick<Work, 'id'>): Work {
  return {
    title: overrides.id,
    status: 'active',
    sessionLinks: [],
    startedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function card(overrides: Partial<KanbanCard> & Pick<KanbanCard, 'id'>): KanbanCard {
  return {
    title: overrides.id,
    description: '',
    status: 'done',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  } as KanbanCard;
}

const link: WorkSessionLink = {
  sessionId: 'ses-1',
  projectDir: '/repo',
  linkedAt: '2026-09-03T00:00:00.000Z',
  role: 'review',
};

describe('recommendWorksForSession', () => {
  const session = inboxSessionFromLink(link, []);

  test('excludes the Work a session already belongs to', () => {
    const works = [work({ id: 'current', projectDir: '/repo' }), work({ id: 'other', projectDir: '/repo' })];
    expect(recommendWorksForSession(session, works).map((r) => r.work.id))
      .toEqual(['current', 'other']);
    // The move dialog passes the current Work — "move it where it already is"
    // is not a destination.
    expect(recommendWorksForSession(session, works, 'current').map((r) => r.work.id))
      .toEqual(['other']);
  });

  test('ranks session lineage above a shared directory', () => {
    const works = [
      work({ id: 'same-dir', projectDir: '/repo', updatedAt: '2026-09-09T00:00:00.000Z' }),
      work({ id: 'lineage', projectDir: '/elsewhere' }),
    ];
    const ranked = recommendWorksForSession(session, works, undefined, new Set(['lineage']));
    // A shared directory says "same project"; lineage says "same piece of work".
    expect(ranked.map((r) => r.work.id)).toEqual(['lineage', 'same-dir']);
    expect(ranked[0]).toMatchObject({ chained: true, sameDirectory: false });
    expect(ranked[1]).toMatchObject({ chained: false, sameDirectory: true });
  });

  test('lists a Work that is both chained and same-directory once, in the lineage group', () => {
    const works = [
      work({ id: 'plain-same-dir', projectDir: '/repo' }),
      work({ id: 'both', projectDir: '/repo' }),
    ];
    const ranked = recommendWorksForSession(session, works, undefined, new Set(['both']));
    expect(ranked.map((r) => r.work.id)).toEqual(['both', 'plain-same-dir']);
    expect(ranked[0]).toMatchObject({ chained: true, sameDirectory: true });
  });

  test('without a lineage set the ordering is unchanged', () => {
    // The move dialog passes none; it must behave exactly as before.
    const works = [work({ id: 'a', projectDir: '/repo' }), work({ id: 'b', projectDir: '/other' })];
    expect(recommendWorksForSession(session, works).map((r) => r.chained)).toEqual([false, false]);
  });

  test('still ranks same-directory Works first after the exclusion', () => {
    const works = [
      work({ id: 'current', projectDir: '/repo' }),
      work({ id: 'elsewhere', projectDir: '/other', updatedAt: '2026-09-09T00:00:00.000Z' }),
      work({ id: 'same-dir', projectDir: '/repo' }),
    ];
    const ranked = recommendWorksForSession(session, works, 'current');
    expect(ranked.map((r) => r.work.id)).toEqual(['same-dir', 'elsewhere']);
    expect(ranked[0]?.sameDirectory).toBe(true);
  });

  // ── works.assign_prefer_same_dir ──
  // The setting was read and written by the settings panel and consulted by
  // nothing: the ranking always put same-directory Works first, so the
  // checkbox was decorative. These pin it to the ranking.
  test('preferSameDir: false stops the same-directory group from ranking first', () => {
    const works = [
      work({ id: 'elsewhere', projectDir: '/other', updatedAt: '2026-09-09T00:00:00.000Z' }),
      work({ id: 'same-dir', projectDir: '/repo' }),
    ];
    expect(
      recommendWorksForSession(session, works, undefined, undefined, { preferSameDir: true })
        .map((r) => r.work.id),
    ).toEqual(['same-dir', 'elsewhere']);
    // Off: plain most-recent-activity order.
    expect(
      recommendWorksForSession(session, works, undefined, undefined, { preferSameDir: false })
        .map((r) => r.work.id),
    ).toEqual(['elsewhere', 'same-dir']);
  });

  test('preferSameDir: false still reports sameDirectory, so the mark survives', () => {
    // The 같은 디렉토리 mark describes the Work; the setting only decides
    // whether that fact is used to sort.
    const works = [work({ id: 'same-dir', projectDir: '/repo' })];
    const ranked = recommendWorksForSession(session, works, undefined, undefined, {
      preferSameDir: false,
    });
    expect(ranked[0]).toMatchObject({ sameDirectory: true, chained: false });
  });

  test('preferSameDir: false keeps lineage ranking first', () => {
    const works = [
      work({ id: 'recent', projectDir: '/other', updatedAt: '2026-09-09T00:00:00.000Z' }),
      work({ id: 'lineage', projectDir: '/other' }),
    ];
    const ranked = recommendWorksForSession(session, works, undefined, new Set(['lineage']), {
      preferSameDir: false,
    });
    expect(ranked.map((r) => r.work.id)).toEqual(['lineage', 'recent']);
  });

  test('omitting the options bag keeps same-directory-first (the documented default)', () => {
    const works = [
      work({ id: 'elsewhere', projectDir: '/other', updatedAt: '2026-09-09T00:00:00.000Z' }),
      work({ id: 'same-dir', projectDir: '/repo' }),
    ];
    expect(recommendWorksForSession(session, works).map((r) => r.work.id))
      .toEqual(['same-dir', 'elsewhere']);
  });
});

describe('WORK_STATUS_LABELS', () => {
  test('names every status in the language the rest of the screen uses', () => {
    // `active` used to render as the literal wire value `ACTIVE` next to `완료`
    // and `폐기` — one field, two conventions, and the enum on screen.
    expect(WORK_STATUS_LABELS).toEqual({ active: '진행 중', done: '완료', discarded: '폐기' });
    for (const label of Object.values(WORK_STATUS_LABELS)) {
      expect(label).not.toMatch(/[A-Za-z_]/);
    }
  });
});

describe('describeWorkStatusBadge', () => {
  const now = Date.parse('2026-09-04T00:00:00.000Z');

  test('an open Work is still counting', () => {
    expect(describeWorkStatusBadge(
      { status: 'active', startedAt: '2026-09-02T00:00:00.000Z' },
      now,
    )).toBe('진행 중 · 3일째');
  });

  test('a finished Work reports the span it took, not a day count to today', () => {
    expect(describeWorkStatusBadge(
      {
        status: 'done',
        startedAt: '2026-03-01T00:00:00.000Z',
        resolvedAt: '2026-03-03T00:00:00.000Z',
      },
      now,
    )).toBe('완료 · 3일 소요');
    expect(describeWorkStatusBadge(
      {
        status: 'discarded',
        startedAt: '2026-03-01T00:00:00.000Z',
        resolvedAt: '2026-03-01T12:00:00.000Z',
      },
      now,
    )).toBe('폐기 · 1일 소요');
  });

  test('never prints a wire enum', () => {
    for (const status of ['active', 'done', 'discarded'] as const) {
      const badge = describeWorkStatusBadge({ status, startedAt: '2026-09-02T00:00:00.000Z' }, now);
      expect(badge).not.toContain('ACTIVE');
      expect(badge).not.toContain(status);
    }
  });
});

describe('describeWorkArtifacts', () => {
  test('labels each count by what it actually sums', () => {
    // `inProgressCount` is todo + in_progress, so the old `in_progress N` chip
    // was counting cards that had never started.
    const chips = describeWorkArtifacts({ cardCount: 6, doneCount: 5, inProgressCount: 1 });
    expect(chips.map((chip) => `${chip.label} ${chip.count}`))
      .toEqual(['카드 6', '끝난 카드 5', '남은 카드 1']);
    expect(chips[1].hint).toBe('완료 + 검토 대기');
    expect(chips[2].hint).toBe('대기 + 진행중');
  });

  test('leaks no wire status name into a label or a hint', () => {
    const chips = describeWorkArtifacts({ cardCount: 0, doneCount: 0, inProgressCount: 0 });
    for (const chip of chips) {
      for (const text of [chip.label, chip.hint]) {
        expect(text).not.toMatch(/done|in_progress|todo|complete/);
      }
    }
  });
});

describe('inboxSessionFromLink', () => {
  test('derives the session view from its oldest card and latest activity', () => {
    const cards = [
      card({
        id: 'c2', title: '두 번째', sessionId: 'ses-1',
        createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
      }),
      card({
        id: 'c1', title: '첫 프롬프트', sessionId: 'ses-1', sessionTitle: '세션 제목',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
      }),
      card({ id: 'c9', title: '남의 세션', sessionId: 'ses-9' }),
    ];
    const session = inboxSessionFromLink(link, cards);
    expect(session.cardTitle).toBe('첫 프롬프트');
    expect(session.cardId).toBe('c1');
    expect(session.sessionTitle).toBe('세션 제목');
    expect(session.relatedCardCount).toBe(2);
    expect(session.updatedAt).toBe('2026-09-05T00:00:00.000Z');
    expect(session.projectDir).toBe('/repo');
  });

  test('falls back to the link itself when every card is gone', () => {
    const session = inboxSessionFromLink(link, []);
    expect(session.sessionId).toBe('ses-1');
    expect(session.relatedCardCount).toBe(0);
    expect(session.updatedAt).toBe(link.linkedAt);
    // Non-empty so the title suggestion has something to work with.
    expect(session.cardTitle.length).toBeGreaterThan(0);
  });
});

describe('confirmDeleteWorkMessage', () => {
  const links: WorkSessionLink[] = [link, { ...link, sessionId: 'ses-2' }];

  test('an open Work names itself and where its sessions go', () => {
    const message = confirmDeleteWorkMessage(
      work({ id: 'w1', title: 'Works 세션 이동', sessionLinks: links }),
    );
    expect(message).toContain('"Works 세션 이동"을 삭제합니다.');
    expect(message).toContain('연결된 세션 2개는 Inbox로 돌아가고, 카드는 보드에 그대로 남습니다.');
    // Nothing was archived, so no archive/wiki caveat belongs here.
    expect(message).not.toContain('archive');
  });

  test('a discarded Work uses the same wording', () => {
    const message = confirmDeleteWorkMessage(
      work({ id: 'w1', title: '폐기됨', status: 'discarded', sessionLinks: [link] }),
    );
    expect(message).toContain('"폐기됨"을 삭제합니다.');
    expect(message).toContain('연결된 세션 1개는 Inbox로 돌아가고');
  });

  test('a completed Work spells out what deletion does not undo', () => {
    const message = confirmDeleteWorkMessage(
      work({ id: 'w1', title: '완료됨', status: 'done', sessionLinks: links }),
    );
    // Deletion is the only route back to the Inbox for a done Work's sessions,
    // so it stays available — but it must not imply an un-archive.
    expect(message).toContain('⚠ 완료된 Work를 삭제합니다.');
    expect(message).toContain('연결된 세션 2개가 Inbox로 돌아오지만, 이미 archive된 카드는 복구되지 않습니다.');
    expect(message).toContain('생성된 wiki 문서도 그대로 남습니다.');
  });
});

describe('resolvedWorksNewestFirst', () => {
  test('keeps only resolved Works, most recently resolved first', () => {
    const list = resolvedWorksNewestFirst([
      work({ id: 'open' }),
      work({ id: 'old-done', status: 'done', resolvedAt: '2026-08-01T00:00:00.000Z' }),
      work({ id: 'new-discarded', status: 'discarded', resolvedAt: '2026-09-02T00:00:00.000Z' }),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(['new-discarded', 'old-done']);
  });

  test('sorts an undated resolution by updatedAt instead of dropping it', () => {
    // There is no date window any more, so a resolved Work with no resolvedAt
    // must still land somewhere sane rather than disappearing.
    const list = resolvedWorksNewestFirst([
      work({ id: 'dated', status: 'done', resolvedAt: '2026-08-01T00:00:00.000Z' }),
      work({ id: 'undated', status: 'done', updatedAt: '2026-09-05T00:00:00.000Z' }),
    ]);
    expect(list.map((entry) => entry.id)).toEqual(['undated', 'dated']);
  });
});

describe('Inbox drag-select geometry', () => {
  const rows = [
    { sessionId: 'a', top: 0, bottom: 40 },
    { sessionId: 'b', top: 40, bottom: 80 },
    { sessionId: 'c', top: 80, bottom: 120 },
  ];

  test('hit-tests the row under the pointer', () => {
    expect(rowIndexAtPointer(10, rows)).toBe(0);
    expect(rowIndexAtPointer(60, rows)).toBe(1);
    expect(rowIndexAtPointer(100, rows)).toBe(2);
  });

  test('clamps a pointer dragged past either end onto the nearest row', () => {
    // Dragging out of the list keeps extending the selection instead of
    // dropping it.
    expect(rowIndexAtPointer(-500, rows)).toBe(0);
    expect(rowIndexAtPointer(9999, rows)).toBe(2);
    expect(rowIndexAtPointer(10, [])).toBe(-1);
  });

  test('selects the inclusive range between the anchor and the pointer, either direction', () => {
    expect(sessionIdsBetween(rows, 0, 2)).toEqual(['a', 'b', 'c']);
    expect(sessionIdsBetween(rows, 2, 0)).toEqual(['a', 'b', 'c']);
    expect(sessionIdsBetween(rows, 1, 1)).toEqual(['b']);
    expect(sessionIdsBetween(rows, -1, 2)).toEqual([]);
  });
});

describe('mergeSessionsForAssign', () => {
  function inboxSession(overrides: Partial<WorkInboxSession> & Pick<WorkInboxSession, 'sessionId'>): WorkInboxSession {
    return {
      cardTitle: overrides.sessionId,
      cardId: `card-${overrides.sessionId}`,
      cardStatus: 'done',
      agentRuntime: 'claude',
      relatedCardCount: 1,
      sessionKind: 'main',
      updatedAt: '2026-09-03T00:00:00.000Z',
      ...overrides,
    };
  }

  test('seeds identity from the oldest session and sums the card counts', () => {
    const merged = mergeSessionsForAssign([
      inboxSession({ sessionId: 'newer', projectDir: '/repo', relatedCardCount: 2, updatedAt: '2026-09-03T00:00:00.000Z' }),
      inboxSession({ sessionId: 'older', projectDir: '/repo', sessionTitle: '첫 프롬프트', relatedCardCount: 3, updatedAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(merged?.sessionId).toBe('older');
    expect(merged?.sessionTitle).toBe('첫 프롬프트');
    expect(merged?.relatedCardCount).toBe(5);
    expect(merged?.projectDir).toBe('/repo');
  });

  test('drops projectDir when the batch spans directories', () => {
    // A mixed batch has no "same directory" Work to recommend, and the Work it
    // creates must not claim one either.
    const merged = mergeSessionsForAssign([
      inboxSession({ sessionId: 'a', projectDir: '/repo' }),
      inboxSession({ sessionId: 'b', projectDir: '/other' }),
    ]);
    expect(merged?.projectDir).toBeUndefined();
  });

  test('an empty selection has no representative', () => {
    expect(mergeSessionsForAssign([])).toBeNull();
  });
});

describe('workAgeDays', () => {
  const NOW = Date.parse('2026-09-20T12:00:00.000Z');

  test('an open Work keeps counting to today, inclusive of its first day', () => {
    expect(workAgeDays(work({ id: 'w', startedAt: '2026-09-20T01:00:00.000Z' }), NOW)).toBe(1);
    expect(workAgeDays(work({ id: 'w', startedAt: '2026-09-18T01:00:00.000Z' }), NOW)).toBe(3);
  });

  test('a planned end does not freeze an open Work', () => {
    // `resolvedAt` on an `active` Work is a forecast, not an end — the badge
    // must still say how long it has actually been open.
    const planned = work({
      id: 'w',
      startedAt: '2026-09-10T00:00:00.000Z',
      resolvedAt: '2026-09-12T00:00:00.000Z',
    });
    expect(workAgeDays(planned, NOW)).toBe(11);
  });

  test('a resolved Work is fixed at resolvedAt − startedAt', () => {
    // The bug this pins: a Work finished long ago used to grow one day older
    // every day it was reopened for review.
    const done = work({
      id: 'w',
      status: 'done',
      startedAt: '2026-03-01T00:00:00.000Z',
      resolvedAt: '2026-03-03T00:00:00.000Z',
    });
    expect(workAgeDays(done, NOW)).toBe(3);
    expect(workAgeDays(done, NOW + 86_400_000 * 30)).toBe(3);
  });

  test('a discarded Work is measured the same way', () => {
    expect(workAgeDays(work({
      id: 'w',
      status: 'discarded',
      startedAt: '2026-09-01T00:00:00.000Z',
      resolvedAt: '2026-09-01T23:00:00.000Z',
    }), NOW)).toBe(1);
  });

  test('a terminal Work with no resolvedAt falls back to the clock', () => {
    expect(workAgeDays(work({
      id: 'w',
      status: 'done',
      startedAt: '2026-09-18T00:00:00.000Z',
    }), NOW)).toBe(3);
  });

  test('never reports fewer than one day, even for a broken record', () => {
    expect(workAgeDays(work({ id: 'w', startedAt: 'not-a-date' }), NOW)).toBe(1);
    expect(workAgeDays(work({
      id: 'w',
      status: 'done',
      startedAt: '2026-09-05T00:00:00.000Z',
      resolvedAt: '2026-09-01T00:00:00.000Z',
    }), NOW)).toBe(1);
  });
});

function preview(overrides: Partial<WorkCompletionPreview> = {}): WorkCompletionPreview {
  return {
    workId: 'w1',
    cardCount: 3,
    byStatus: { todo: 1, in_progress: 0, complete: 1, done: 1 },
    sweepCardCount: 3,
    favoriteCardIds: [],
    runningCardIds: [],
    runningCardTitles: [],
    sessionCount: 2,
    alreadyArchived: false,
    scannedMonths: ['2026-09'],
    ...overrides,
  };
}

function config(overrides: Partial<WorksConfigDto> = {}): WorksConfigDto {
  return {
    summaryModel: 'claude-sonnet-5',
    summaryLines: 4,
    assignPreferSameDir: true,
    assignSuggestResumeChain: true,
    staleDays: 5,
    doneConfirm: true,
    configured: true,
    route: 'claude',
    ...overrides,
  };
}

/**
 * The confirmation gate in front of the bulk done→archive sweep. Every case
 * here is a way the old gate let the destructive path run unannounced.
 */
describe('requiresDoneConfirm', () => {
  test('an unloaded config still requires confirmation', () => {
    // The regression: the gate read `config?.doneConfirm`, so a click that beat
    // the config request saw `undefined` and bulk-archived with no prompt.
    expect(requiresDoneConfirm(null)).toBe(true);
    expect(requiresDoneConfirm(undefined)).toBe(true);
  });

  test('only an explicit false skips the dialog', () => {
    expect(requiresDoneConfirm(config({ doneConfirm: false }))).toBe(false);
    expect(requiresDoneConfirm(config({ doneConfirm: true }))).toBe(true);
  });
});

describe('workCompletionBlock', () => {
  test('a running card blocks completion', () => {
    const blocked = preview({ runningCardIds: ['c1'], runningCardTitles: ['에이전트 실행중'] });
    expect(workCompletionBlock(blocked)).toBe('running');
    expect(describeWorkCompletionBlock(blocked))
      .toContain('실행 중 카드 1장이 있어 완료할 수 없습니다');
  });

  test('an already-archived Work blocks a second sweep', () => {
    expect(workCompletionBlock(preview({ alreadyArchived: true }))).toBe('already-archived');
    expect(describeWorkCompletionBlock(preview({ alreadyArchived: true })))
      .toBe('이미 archive된 Work입니다.');
  });

  test('nothing blocks a plain active Work, and no preview is not a block', () => {
    expect(workCompletionBlock(preview())).toBeNull();
    expect(workCompletionBlock(null)).toBeNull();
    expect(describeWorkCompletionBlock(preview())).toBe('');
  });

  test('a running card outranks the archived flag', () => {
    // Both true is reachable while a late run finishes under an archived Work;
    // "still running" is the actionable half.
    expect(workCompletionBlock(preview({
      runningCardIds: ['c1'], runningCardTitles: ['t'], alreadyArchived: true,
    }))).toBe('running');
  });
});

describe('describeWorkCompletion', () => {
  test('states the card count that will be archived', () => {
    expect(describeWorkCompletion(preview({ sweepCardCount: 4 })))
      .toBe('카드 4장이 done 처리된 뒤 archive됩니다. 다시 열기로 보드에 복원할 수 있습니다.');
  });

  test('an already-swept Work says there is nothing left to archive', () => {
    expect(describeWorkCompletion(preview({ alreadyArchived: true, sweepCardCount: 0 })))
      .toContain('이미 archive됐습니다');
  });

  test('a Work with nothing on the board says only its status changes', () => {
    expect(describeWorkCompletion(preview({ sweepCardCount: 0 })))
      .toBe('보드에 남은 카드가 없습니다. Work 상태만 완료로 기록됩니다.');
  });

  test('without a preview it still warns rather than promising nothing happens', () => {
    expect(describeWorkCompletion(null)).toContain('다시 열기');
  });
});

describe('describeCompletionByStatus', () => {
  test('lists non-zero statuses in board order', () => {
    expect(describeCompletionByStatus(preview({
      byStatus: { todo: 2, in_progress: 1, complete: 0, done: 3 },
    }))).toBe('대기 2 · 진행중 1 · 완료 3');
  });

  test('an empty Work reads as an empty string, not "0"', () => {
    expect(describeCompletionByStatus(preview({
      byStatus: { todo: 0, in_progress: 0, complete: 0, done: 0 },
    }))).toBe('');
  });
});

describe('describeWorkDiscard', () => {
  test('says the cards stay and the action cannot be undone', () => {
    const message = describeWorkDiscard(
      work({ id: 'w1', title: '중단한 작업', sessionLinks: [link, { ...link, sessionId: 'ses-2' }] }),
    );
    expect(message).toContain('"중단한 작업"을 폐기합니다.');
    expect(message).toContain('카드 2개 세션은 보드에 그대로 남고');
    expect(message).toContain('다시 열 수 있습니다');
  });
});

describe('describeSessionState', () => {
  test('names the states that change the triage decision', () => {
    expect(describeSessionState({ cardStatus: 'in_progress', sessionKind: 'main' }))
      .toEqual({ label: '실행 중', tone: 'running' });
    expect(describeSessionState({ cardStatus: 'todo', sessionKind: 'main' }))
      .toEqual({ label: '미실행', tone: 'idle' });
  });

  test('says nothing for a settled session', () => {
    // The common case is a finished session; a chip on every row would be noise.
    expect(describeSessionState({ cardStatus: 'done', sessionKind: 'main' })).toBeNull();
    expect(describeSessionState({ cardStatus: 'complete', sessionKind: 'main' })).toBeNull();
  });

  test('subagent outranks the card status', () => {
    // The row's real problem is that it duplicates its (still unassigned)
    // parent — not what its own card is doing.
    expect(describeSessionState({ cardStatus: 'in_progress', sessionKind: 'subagent' }))
      .toEqual({ label: 'subagent', tone: 'subagent' });
  });
});

/**
 * The assign-all modal's key rule. It binds on `window` in the capture phase,
 * so every key in the dialog reaches it wherever focus is — which is exactly
 * how one keystroke on the wrong element used to discard a session for good.
 */
describe('resolveBulkAssignShortcut', () => {
  const on = (
    tagName: string,
    key: string,
    extra: { isContentEditable?: boolean; recommendationCount?: number } = {},
  ) => resolveBulkAssignShortcut({
    key,
    target: { tagName, isContentEditable: extra.isContentEditable },
    recommendationCount: extra.recommendationCount ?? 3,
  });

  test('Enter connects from the body and from the title input', () => {
    expect(on('DIV', 'Enter')).toEqual({ action: 'connect' });
    expect(on('INPUT', 'Enter')).toEqual({ action: 'connect' });
  });

  test('Enter on a button belongs to that button', () => {
    // 폐기 / 건너뛰기 / × all sit on buttons: Enter there used to run
    // "연결하고 다음" *and* preventDefault the button's own activation, so the
    // user got the opposite of the action they had focused.
    expect(on('BUTTON', 'Enter')).toBeNull();
    expect(on('A', 'Enter')).toBeNull();
    expect(on('DIV', 'Enter', { isContentEditable: true })).toBeNull();
  });

  test('letters and digits are shortcuts only outside a form control', () => {
    expect(on('DIV', 'x')).toEqual({ action: 'discard' });
    expect(on('DIV', 's')).toEqual({ action: 'skip' });
    expect(on('DIV', 'n')).toEqual({ action: 'select-new' });
    expect(on('DIV', '2')).toEqual({ action: 'select-recommendation', index: 1 });
    expect(on('BUTTON', 'x')).toEqual({ action: 'discard' });
  });

  test('a focused <select> or contenteditable swallows every letter', () => {
    // `x` with the 역할 select focused used to discard the session outright.
    expect(on('SELECT', 'x')).toBeNull();
    expect(on('SELECT', 's')).toBeNull();
    expect(on('SELECT', '1')).toBeNull();
    expect(on('INPUT', 'x')).toBeNull();
    expect(on('TEXTAREA', 'n')).toBeNull();
    expect(on('DIV', 'x', { isContentEditable: true })).toBeNull();
  });

  test('a digit past the recommendation list is not a shortcut', () => {
    expect(on('DIV', '4', { recommendationCount: 3 })).toBeNull();
    expect(on('DIV', '3', { recommendationCount: 3 }))
      .toEqual({ action: 'select-recommendation', index: 2 });
  });

  test('modified keys belong to the browser', () => {
    expect(resolveBulkAssignShortcut({
      key: 'n', target: { tagName: 'DIV' }, metaKey: true, recommendationCount: 3,
    })).toBeNull();
    expect(resolveBulkAssignShortcut({
      key: 'Enter', target: { tagName: 'DIV' }, ctrlKey: true, recommendationCount: 3,
    })).toBeNull();
  });
});

describe('describeBulkAssignProgress', () => {
  test('reports only what has happened, plus the live remainder', () => {
    expect(describeBulkAssignProgress({ linked: 0, skipped: 0, discarded: 0 }, 4))
      .toBe('남은 4개');
    expect(describeBulkAssignProgress({ linked: 2, skipped: 1, discarded: 1 }, 1))
      .toBe('연결 2 · 건너뜀 1 · 폐기 1 · 남은 1개');
  });

  test('says the queue is empty rather than "남은 0개"', () => {
    expect(describeBulkAssignProgress({ linked: 3, skipped: 0, discarded: 0 }, 0))
      .toBe('연결 3 · 남은 세션 없음');
  });
});

/**
 * The Active list was `updatedAt` descending with no controls at all, which put
 * a Work nobody had touched for three weeks at the very bottom, and a planned
 * end that had come and gone looked identical to one still in the future. These
 * are the copy/selection halves of the fix; the ordering rule itself is pinned
 * in `src/__tests__/work-list.test.ts`.
 */
describe('describeWorkPlanOverrun', () => {
  const NOW = Date.parse('2026-09-10T00:00:00.000Z');

  test('names the overrun in days for an active Work past its planned end', () => {
    expect(describeWorkPlanOverrun(work({ id: 'a', resolvedAt: '2026-09-07T23:59:59.999Z' }), NOW))
      .toBe('예정 2일 초과');
  });

  test('is empty for a future end, no end, and a closed Work', () => {
    expect(describeWorkPlanOverrun(work({ id: 'a', resolvedAt: '2026-09-20T00:00:00.000Z' }), NOW))
      .toBe('');
    expect(describeWorkPlanOverrun(work({ id: 'a' }), NOW)).toBe('');
    // A resolved Work's `resolvedAt` is when it ended, not a missed forecast —
    // marking every completed Work "초과" would flag the whole Resolved list.
    expect(describeWorkPlanOverrun(
      work({ id: 'a', status: 'done', resolvedAt: '2026-09-01T00:00:00.000Z' }),
      NOW,
    )).toBe('');
  });
});

describe('WORK_LIST_SORT_LABELS', () => {
  test('offers exactly the three sorts the route accepts, in order', () => {
    expect(WORK_LIST_SORT_LABELS.map(([value]) => value))
      .toEqual(['updated', 'stale', 'planned']);
  });
});

describe('describeWorkReopen', () => {
  test('leads with how many cards come back, and that they come back done', () => {
    const message = describeWorkReopen(12);
    expect(message).toContain('12장');
    // The completion sweep flipped every card to `done` and recorded their
    // previous statuses nowhere, so a reopen cannot restore them — saying so is
    // the difference between a surprise and an expectation.
    expect(message).toContain('done');
  });

  test('says so when there is nothing in the archive to restore', () => {
    expect(describeWorkReopen(0)).toContain('archive된 카드가 없습니다');
  });

  test('admits an unknown count instead of printing a number nobody computed', () => {
    const message = describeWorkReopen(null);
    expect(message).toContain('확인하지 못했습니다');
    expect(message).not.toContain('0장');
  });
});

describe('describeWorkMergeImpact', () => {
  const from = work({
    id: 'from',
    title: '위키 파이프라인',
    startedAt: '2026-09-01T00:00:00.000Z',
    sessionLinks: [
      { sessionId: 's1', projectDir: '/repo', linkedAt: '2026-09-01T00:00:00.000Z', role: 'dev' },
      { sessionId: 's2', projectDir: '/repo', linkedAt: '2026-09-02T00:00:00.000Z', role: 'review' },
    ],
  });
  const to = work({
    id: 'to',
    title: '위키 정리',
    startedAt: '2026-09-05T00:00:00.000Z',
    sessionLinks: [
      { sessionId: 's9', projectDir: '/repo', linkedAt: '2026-09-05T00:00:00.000Z', role: 'dev' },
    ],
  });

  test('states the moved count and the target’s resulting session total', () => {
    const lines = describeWorkMergeImpact(from, to, []);
    expect(lines[0]).toBe('세션 2개가 "위키 정리"으로 옮겨져 총 3개가 됩니다.');
  });

  test('previews the target’s start date shift using the server’s own rule', () => {
    // The merge recalculates `startedAt = min()` over the post-merge link set
    // inside the store lock. A move re-dating a Timeline bar used to be silent.
    const cards = [
      card({ id: 'c1', sessionId: 's1', createdAt: '2026-08-20T00:00:00.000Z' }),
      card({ id: 'c9', sessionId: 's9', createdAt: '2026-09-05T00:00:00.000Z' }),
    ];
    expect(describeWorkMergeImpact(from, to, cards).join('\n')).toContain('시작일이');
  });

  test('says nothing about the start date when the merge does not move it', () => {
    // Both incoming sessions start after the target's own start, so `min()` is
    // unchanged and there is nothing to warn about.
    const cards = [
      card({ id: 'c1', sessionId: 's1', createdAt: '2026-09-09T00:00:00.000Z' }),
      card({ id: 'c2', sessionId: 's2', createdAt: '2026-09-09T00:00:00.000Z' }),
    ];
    expect(describeWorkMergeImpact(from, to, cards).join('\n')).not.toContain('시작일이');
  });

  test('flags sessions the target already holds instead of silently rewriting them', () => {
    const overlapping = work({
      ...to,
      sessionLinks: [
        ...to.sessionLinks,
        { sessionId: 's1', projectDir: '/repo', linkedAt: '2026-09-06T00:00:00.000Z', role: 'debug' },
      ],
    });
    const lines = describeWorkMergeImpact(from, overlapping, []).join('\n');
    expect(lines).toContain('세션 1개가');
    expect(lines).toContain('이미 "위키 정리"에 있는 세션 1개');
  });

  test('always states what happens to the source — closed, not deleted', () => {
    // Emptying a Work by moving sessions one at a time *deletes* it and takes
    // its Summary with it; a merge keeps the record so the row can say where
    // its sessions went.
    expect(describeWorkMergeImpact(from, to, []).at(-1))
      .toBe('"위키 파이프라인"은 폐기(병합됨)로 닫히고, 어디로 합쳐졌는지 기록됩니다.');
  });
});

describe('mergeTargetsFor', () => {
  const source = work({ id: 'src', title: '원본' });

  test('excludes itself and every non-active Work', () => {
    // The store's move gate refuses both ends of an archived or completed Work,
    // so offering one would only produce a 409 after the click.
    const works = [
      source,
      work({ id: 'open', title: '진행 중' }),
      work({ id: 'closed', title: '완료됨', status: 'done' }),
      work({ id: 'dropped', title: '폐기됨', status: 'discarded' }),
    ];
    expect(mergeTargetsFor(source, works).map((w) => w.id)).toEqual(['open']);
  });

  test('narrows by the search box and orders by most recent activity', () => {
    const works = [
      source,
      work({ id: 'a', title: 'wiki 정리', updatedAt: '2026-09-02T00:00:00.000Z' }),
      work({ id: 'b', title: 'wiki 파이프라인', updatedAt: '2026-09-06T00:00:00.000Z' }),
      work({ id: 'c', title: 'Timeline 드래그' }),
    ];
    expect(mergeTargetsFor(source, works, 'wiki').map((w) => w.id)).toEqual(['b', 'a']);
  });
});
