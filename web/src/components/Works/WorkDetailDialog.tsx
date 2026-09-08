import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KanbanCard,
  MoveWorkSessionResponse,
  Work,
  WorkInboxSession,
  WorkSessionLink,
  WorkSessionRole,
  WorkSessionsResponse,
} from '../../../../src/core/types';
import { WORK_NOTES_MAX_LENGTH } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { MoveSessionDialog } from './MoveSessionDialog';
import { WorkMergeDialog } from './WorkMergeDialog';
import { WorkResolveConfirmDialog, type WorkResolveMode } from './WorkResolveConfirmDialog';
import type { WorkResolveOutcome } from '../../hooks/useWorks';
import { WorkSessionMenu } from './WorkSessionMenu';
import type { WorkSessionNoticeState } from './WorkSessionNotice';
import {
  ROLE_LABELS,
  WORK_STATUS_LABELS,
  confirmDeleteWorkMessage,
  describeWorkArtifacts,
  describeWorkPlanOverrun,
  describeWorkStatusBadge,
  formatShortDate,
  projectDirLabel,
  shortSessionId,
} from './worksAssign';
import { endFromDateInputValue, fromDateInputValue, toDateInputValue } from './timelineModel';
import './Works.css';

interface WorkDetailDialogProps {
  work: Work;
  /**
   * Board cards. Only a *fallback* source for session titles and counts: a
   * completed Work's cards are archived off the board, so `detail` (computed
   * server-side over the archive too) is what these rows normally read. Still
   * needed for `MoveSessionDialog`'s impact preview, which reasons about the
   * live board.
   */
  cards: KanbanCard[];
  /**
   * `GET /api/works/:id/sessions` — archive-inclusive session summaries and
   * artifact totals. Absent while loading or after a failed read, in which case
   * the dialog falls back to `cards` and says so.
   */
  detail?: WorkSessionsResponse | null;
  detailLoading?: boolean;
  detailError?: string | null;
  onClose: () => void;
  /**
   * `PATCH status:'done'` — the bulk done→archive sweep. Takes the confirmation
   * flag because the hook refuses to send the destructive path without it, and
   * answers `'done' | 'declined' | 'blocked'`: this dialog closes **only** on
   * `'done'`. It used to chain `.then(onClose)` onto a `Promise<void>`, so a
   * cancelled confirmation closed the dialog and read as a completed archive.
   */
  onComplete: (workId: string, options?: { confirmed?: boolean }) => Promise<WorkResolveOutcome>;
  /** `PATCH status:'discarded'` — same confirmation + outcome contract as onComplete. */
  onDiscard: (workId: string, options?: { confirmed?: boolean }) => Promise<WorkResolveOutcome>;
  /**
   * `POST /api/works/:id/reopen` — undo a completion or a discard: back to
   * `active`, and the bulk-archived cards back onto the board. Omit to render
   * the 다시 열기 button disabled.
   *
   * Same `'done' | 'blocked'` outcome contract as the two transitions above, but
   * this dialog deliberately stays **open** on `'done'`: the point of reopening
   * is to keep working on the Work, so it re-renders in the active layout
   * instead of vanishing.
   */
  onReopen?: (workId: string) => Promise<WorkResolveOutcome>;
  /**
   * `POST /api/works/:id/merge` — fold this Work's sessions into another one.
   * Omit to hide the 병합 button.
   */
  onMerge?: (workId: string, intoWorkId: string) => Promise<void>;
  /**
   * PATCH `notes` — the Work's human-owned free text. Omit to render the 메모
   * area read-only. Distinct from Summary, which the LLM overwrites.
   */
  onUpdateNotes?: (workId: string, notes: string) => Promise<void>;
  /** Open a linked session's conversation (reuses SessionConversationModal via App). */
  onOpenSession: (sessionId: string) => void;
  /**
   * PATCH `startedAt` / `resolvedAt`. The same edit the Timeline performs by
   * dragging a bar's edge — omit to render the dates read-only.
   */
  onUpdateDates?: (
    workId: string,
    patch: { startedAt?: string; resolvedAt?: string | null },
  ) => Promise<void>;
  /** Generate/regenerate the Summary via the works.summary_model LLM. Resolves
   * when the Work has been updated; rejects with an error to display inline. */
  onRegenerateSummary?: (workId: string) => Promise<void>;
  /**
   * `DELETE /api/works/:id` — drops the Work only: cards stay put and its
   * sessions return to the Inbox. Omit to render the 삭제 button disabled. The
   * dialog confirms before calling this.
   */
  onDelete?: (workId: string) => Promise<void>;
  /**
   * PATCH `title` / `projectDir` — the inline header edits. Omit to render both
   * read-only. A Work's title was fixed at creation, which meant a Work seeded
   * from a session's first prompt was stuck with whatever that prompt said.
   */
  onUpdateMeta?: (
    workId: string,
    patch: { title?: string; projectDir?: string },
  ) => Promise<void>;
  /** Session-level mutations behind each row's ⋯ menu. Omit to hide the menu. */
  sessionActions?: WorkSessionActions;
  /**
   * `POST /api/works/:id/prune-sessions` — drop the links whose session has no
   * cards left at all. Omit to render the cleanup button disabled. Resolves with
   * the removed session ids.
   */
  onPruneSessions?: (workId: string) => Promise<string[]>;
}

/**
 * The `⋯` menu's mutations, passed straight through from `useWorks` (fetch stays
 * in the hook). `link` doubles as the role change and as the undo of an unlink —
 * a same-Work re-link refreshes the role instead of duplicating the link.
 */
export interface WorkSessionActions {
  works: Work[];
  move: (
    sessionId: string,
    input: { toWorkId: string; role?: WorkSessionRole },
  ) => Promise<MoveWorkSessionResponse>;
  moveToNewWork: (
    session: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>,
    title: string,
    role?: WorkSessionRole,
  ) => Promise<MoveWorkSessionResponse>;
  link: (
    workId: string,
    session: Pick<WorkInboxSession, 'sessionId' | 'projectDir'>,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  unlink: (workId: string, sessionId: string) => Promise<Work>;
  /** Report the outcome. Owned by App so it outlives a dialog that closes. */
  notify: (notice: WorkSessionNoticeState) => void;
}

const DATETIME_FMT = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function formatDateTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return DATETIME_FMT.format(date);
}

/** Oldest card's title for a session (its first prompt), falling back to the short id. */
function sessionTitleOf(sessionId: string, cards: KanbanCard[]): string {
  const owned = cards.filter((card) => card.sessionId === sessionId);
  if (owned.length === 0) return shortSessionId(sessionId);
  const oldest = [...owned].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )[0];
  return oldest.title?.trim() || oldest.sessionTitle?.trim() || shortSessionId(sessionId);
}

/**
 * Work detail (mockup screen ③, DialogSkeleton). Self-contained given a `work` +
 * the board `cards`, so both WorksView [상세] and the Timeline can reuse it.
 *
 * 완료 and 폐기 are both terminal and neither has an undo, so their footer
 * buttons only *open* `WorkResolveConfirmDialog` — and this dialog closes only
 * once that answers `'done'`. Everything else (dates, Summary, session actions)
 * mutates directly, because each of those is reversible.
 */
export function WorkDetailDialog({
  work,
  cards,
  detail,
  detailLoading,
  detailError,
  onClose,
  onComplete,
  onDiscard,
  onReopen,
  onMerge,
  onUpdateNotes,
  onOpenSession,
  onUpdateDates,
  onRegenerateSummary,
  onDelete,
  onUpdateMeta,
  sessionActions,
  onPruneSessions,
}: WorkDetailDialogProps) {
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [pruneError, setPruneError] = useState<string | null>(null);

  const links = work.sessionLinks;
  const sessionIds = useMemo(
    () => new Set(links.map((link) => link.sessionId)),
    [links],
  );

  // Board cards for this Work's sessions — the fallback the panels use until
  // `detail` lands (and permanently if that read failed). A resolved Work has
  // none of them: its cards are in the archive, which is exactly why `detail`
  // exists.
  const workCards = useMemo(
    () => cards.filter((card) => card.sessionId && sessionIds.has(card.sessionId)),
    [cards, sessionIds],
  );
  const boardDoneCount = workCards.filter((c) => c.status === 'done' || c.status === 'complete').length;
  const boardInProgressCount = workCards.filter((c) => c.status === 'todo' || c.status === 'in_progress').length;
  const boardLastActivity = useMemo(() => {
    const times = workCards.map((c) => c.updatedAt).filter(Boolean);
    times.push(work.updatedAt);
    return times.sort().at(-1);
  }, [workCards, work.updatedAt]);

  const cardCount = detail?.cardCount ?? workCards.length;
  const doneCount = detail?.doneCount ?? boardDoneCount;
  const inProgressCount = detail?.inProgressCount ?? boardInProgressCount;
  const lastActivity = detail?.lastActivityAt ?? boardLastActivity;

  // `work.sessionLinks` stays authoritative for *which* rows exist so an
  // optimistic unlink drops its row immediately; `detail` only supplies each
  // row's numbers, and a row it has not caught up with falls back to the board.
  const detailBySession = useMemo(
    () => new Map((detail?.sessions ?? []).map((session) => [session.sessionId, session])),
    [detail],
  );
  const sessionRows = useMemo(
    () => [...links]
      .sort((a, b) => new Date(a.linkedAt).getTime() - new Date(b.linkedAt).getTime())
      .map((link) => {
        const summary = detailBySession.get(link.sessionId);
        const boardFirstCardAt = workCards
          .filter((c) => c.sessionId === link.sessionId)
          .map((c) => c.createdAt)
          .sort()[0];
        // When the session actually ran, not when triage happened to file it.
        // The row printed `linkedAt`, so every session in a Work assigned this
        // afternoon read as today no matter how old the work was.
        const startedAt = summary?.firstCardAt ?? boardFirstCardAt;
        return {
          link,
          title: summary
            ? summary.title || shortSessionId(link.sessionId)
            : sessionTitleOf(link.sessionId, cards),
          cardCount: summary?.cardCount ?? workCards.filter((c) => c.sessionId === link.sessionId).length,
          archived: summary?.archived ?? false,
          // Read off the link, not off `cardCount === 0`: this dialog's counts
          // come from a month-bounded scan, so "no cards in the window" and "no
          // cards at all" are different answers. The server stamps the second.
          cardsMissingAt: link.cardsMissingAt,
          startedAt,
        };
      }),
    [links, detailBySession, cards, workCards],
  );

  const isResolved = work.status !== 'active';

  /**
   * The 산출물 row's wiki line. Three distinct states, because "no document"
   * and "not processed yet" are different answers and a completed Work is
   * always briefly the latter — the archive sweep is what queues its cards.
   */
  const wikiDocPaths = detail?.wikiDocPaths ?? [];
  const wikiLabel = wikiDocPaths.length > 0
    ? null
    : !detail
      ? (detailLoading ? '확인 중…' : '알 수 없음')
      : detail.wikiPending
        ? '생성 대기 중'
        : '없음';

  const runAction = (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    // Errors are already surfaced via the Works error alert; swallow here so a
    // failed PATCH keeps the dialog open (no close) instead of raising unhandled.
    void action()
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  /**
   * Title / directory editing.
   *
   * `draft === null` means "not editing" and the field renders the server's
   * value; a string is the user's in-progress text. Keeping the sentinel rather
   * than mirroring `work.title` into state is what makes the 10s Works poll
   * harmless — a poll landing mid-edit cannot overwrite a draft, because while
   * a draft exists it is the only thing rendered.
   *
   * The drafts are **also mirrored in a ref**, and every handler reads the ref.
   * `setState` is queued, but `input.blur()` inside a `keydown` handler fires
   * `onBlur` *synchronously*, before the re-render — so a blur-commits/Escape-
   * abandons pair implemented on state alone has the blur handler observing the
   * previous render's draft. Escape cleared the draft, blurred, and the blur
   * then committed the very text Escape had just thrown away.
   */
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [dirDraft, setDirDraft] = useState<string | null>(null);
  const draftRef = useRef<{ title: string | null; projectDir: string | null }>({
    title: null,
    projectDir: null,
  });
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);

  const setDraft = (field: 'title' | 'projectDir', value: string | null) => {
    draftRef.current = { ...draftRef.current, [field]: value };
    (field === 'title' ? setTitleDraft : setDirDraft)(value);
  };

  const commitMeta = (field: 'title' | 'projectDir', raw: string) => {
    const trimmed = raw.trim();
    const current = (field === 'title' ? work.title : work.projectDir ?? '').trim();
    setDraft(field, null);
    setMetaError(null);
    if (!onUpdateMeta || trimmed === current) return;
    // A Work with no title is unaddressable in every list that shows one, so an
    // emptied title is a mis-edit rather than a request. The directory may be
    // cleared: a Work spanning two checkouts legitimately has none.
    if (field === 'title' && trimmed.length === 0) {
      setMetaError('제목은 비워둘 수 없습니다.');
      return;
    }
    setMetaBusy(true);
    void onUpdateMeta(work.id, field === 'title' ? { title: trimmed } : { projectDir: trimmed })
      .catch((e: unknown) => setMetaError(e instanceof Error ? e.message : '저장하지 못했습니다'))
      .finally(() => setMetaBusy(false));
  };

  /** Blur commits, but only an edit that is still live — see `draftRef`. */
  const blurMeta = (field: 'title' | 'projectDir', value: string) => {
    if (draftRef.current[field] === null) return;
    commitMeta(field, value);
  };

  /** Enter = commit, Escape = abandon the draft without closing the dialog. */
  const metaKeyDown = (
    field: 'title' | 'projectDir',
    event: React.KeyboardEvent<HTMLInputElement>,
  ) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitMeta(field, event.currentTarget.value);
      event.currentTarget.blur();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // `DialogSkeleton` reads Escape as "close the dialog"; abandoning a draft
      // must not also throw away the dialog the draft was being made in.
      event.stopPropagation();
      setDraft(field, null);
      setMetaError(null);
      event.currentTarget.blur();
    }
  };

  // Date inputs are locally controlled so a half-typed value is not fought by
  // the 10s Works poll; each committed change re-syncs from the server's Work.
  const [startInput, setStartInput] = useState(() => toDateInputValue(work.startedAt));
  const [endInput, setEndInput] = useState(() => toDateInputValue(work.resolvedAt));
  const [dateBusy, setDateBusy] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);
  useEffect(() => setStartInput(toDateInputValue(work.startedAt)), [work.startedAt]);
  useEffect(() => setEndInput(toDateInputValue(work.resolvedAt)), [work.resolvedAt]);

  const isOpenWork = work.status === 'active';

  const saveDates = (patch: { startedAt?: string; resolvedAt?: string | null }) => {
    if (!onUpdateDates) return;
    setDateError(null);
    setDateBusy(true);
    void onUpdateDates(work.id, patch)
      .catch((e: unknown) => setDateError(e instanceof Error ? e.message : '날짜를 저장하지 못했습니다'))
      .finally(() => setDateBusy(false));
  };

  const commitDate = (field: 'startedAt' | 'resolvedAt', value: string) => {
    if (field === 'startedAt') setStartInput(value);
    else setEndInput(value);
    if (!onUpdateDates || dateBusy) return;
    if (!value) {
      // Emptying an open Work's end drops the planned date, putting its bar back
      // on today. Everywhere else an empty value is a mid-edit state, not a clear.
      if (field === 'resolvedAt' && isOpenWork && work.resolvedAt) saveDates({ resolvedAt: null });
      return;
    }
    // A start keeps its real clock time; an end lands at end-of-day so a
    // same-day span is never an inverted instant (see `endIsoForColumn`).
    const iso = field === 'startedAt'
      ? fromDateInputValue(value, work.startedAt)
      : endFromDateInputValue(value);
    if (!iso) return; // partial input while typing
    const nextStart = field === 'startedAt' ? iso : work.startedAt;
    const nextEnd = field === 'resolvedAt' ? iso : work.resolvedAt;
    if (nextEnd && Date.parse(nextEnd) < Date.parse(nextStart)) {
      setDateError(`${isOpenWork ? '종료 예정일' : '종료일'}은 시작일보다 빠를 수 없습니다.`);
      return;
    }
    saveDates(field === 'startedAt' ? { startedAt: iso } : { resolvedAt: iso });
  };

  const datesDisabled = !onUpdateDates || dateBusy || busy;
  const endLabel = isOpenWork ? '종료 예정' : '종료';
  const dateHint = !isOpenWork
    ? ''
    : work.resolvedAt
      ? '완료 처리하면 이 날짜가 종료일로 기록됩니다.'
      : '비워두면 타임라인 바가 오늘까지 이어집니다.';

  /**
   * 메모 — the Work's one human-owned free-text field.
   *
   * Summary looks like the place to write "락 순서부터 다시 보기" and is not: it
   * is regenerated from transcripts by an LLM and overwritten wholesale on every
   * `↻ 다시 생성`, so anything typed there is lost the next time anyone presses
   * that button. Notes are never written by the server.
   *
   * Same draft-sentinel discipline as the title/directory edits: `null` means
   * "not editing" and the textarea renders the server's value, so the 10s Works
   * poll cannot overwrite in-progress typing. Unlike those two this commits on
   * an explicit button rather than blur — a multi-line note is long enough that
   * clicking away mid-thought is normal, and a blur-commit would send half a
   * sentence on every stray click.
   */
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  const [notesBusy, setNotesBusy] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const notesValue = notesDraft ?? work.notes ?? '';
  const notesDirty = notesDraft !== null && notesDraft !== (work.notes ?? '');
  const notesTooLong = notesValue.length > WORK_NOTES_MAX_LENGTH;

  const saveNotes = () => {
    if (!onUpdateNotes || notesBusy || notesDraft === null || notesTooLong) return;
    const next = notesDraft;
    setNotesBusy(true);
    setNotesError(null);
    void onUpdateNotes(work.id, next)
      // Clear the draft only on success, so a failed PATCH keeps the text the
      // user typed instead of silently reverting to the server's copy.
      .then(() => { setNotesDraft(null); })
      .catch((e: unknown) => {
        setNotesError(e instanceof Error ? e.message : '메모를 저장하지 못했습니다');
      })
      .finally(() => setNotesBusy(false));
  };

  /**
   * Closing with unsaved notes asks first.
   *
   * The dialog is closed by Escape, by the ✕, and by a click on the backdrop —
   * three easy accidents, and a discarded note is not recoverable from anywhere.
   * The same guard fronts every close path, including the ones the transitions
   * below trigger.
   */
  const closeGuarded = () => {
    if (notesDirty && !window.confirm('저장하지 않은 메모가 있습니다. 닫으면 사라집니다.')) return;
    onClose();
  };

  // Which transition is awaiting confirmation. 완료 and 폐기 are irreversible
  // and neither offers an undo; 다시 열기 is reversible but moves a pile of
  // cards between the board and the archive, so all three confirm first.
  const [resolveMode, setResolveMode] = useState<WorkResolveMode | null>(null);
  /** Whether the merge target picker is open. */
  const [merging, setMerging] = useState(false);

  /**
   * Close on `'done'` only — and not even then for a reopen, whose whole point
   * is to leave the Work open in front of you. `'declined'` (no confirmation)
   * and `'blocked'` (server refused — e.g. a card is still running) both leave
   * the dialog up so the user can see that nothing happened.
   */
  const handleResolved = (outcome: WorkResolveOutcome) => {
    if (outcome === 'done' && resolveMode !== 'reopen') closeGuarded();
  };

  // ⋯ → 다른 Work로 이동: which link the move dialog is aimed at.
  const [moveLink, setMoveLink] = useState<WorkSessionLink | null>(null);

  /** The subset of a link the session mutations need. */
  const sessionRef = (link: WorkSessionLink) => ({
    sessionId: link.sessionId,
    projectDir: link.projectDir,
  });

  const reportMove = (link: WorkSessionLink, result: MoveWorkSessionResponse) => {
    if (!sessionActions) return;
    const from = result.from;
    if (!from) {
      // The source Work lost its last session and the server deleted it, which
      // also closes this dialog. No undo: re-creating it would mint a new id and
      // could not restore its Summary or createdAt.
      sessionActions.notify({
        tone: 'warn',
        message: `✓ 세션을 "${result.to.title}"으로 옮기고, 비워진 Work "${work.title}"를 삭제했습니다.`,
      });
      return;
    }
    sessionActions.notify({
      tone: 'success',
      message: `✓ 세션을 "${result.to.title}"으로 옮겼습니다.`,
      undo: {
        label: '되돌리기',
        run: async () => {
          await sessionActions.move(link.sessionId, { toWorkId: from.id, role: link.role });
        },
      },
    });
  };

  const handleMove = async (link: WorkSessionLink, toWorkId: string, role?: WorkSessionRole) => {
    if (!sessionActions) return;
    const result = await sessionActions.move(link.sessionId, { toWorkId, role });
    setMoveLink(null);
    reportMove(link, result);
  };

  const handleMoveToNewWork = async (
    link: WorkSessionLink,
    title: string,
    role?: WorkSessionRole,
  ) => {
    if (!sessionActions) return;
    const result = await sessionActions.moveToNewWork(sessionRef(link), title, role);
    setMoveLink(null);
    reportMove(link, result);
  };

  const handleUnlink = async (link: WorkSessionLink) => {
    if (!sessionActions) return;
    await sessionActions.unlink(work.id, link.sessionId);
    setMoveLink(null);
    // Unlinking is not destructive — the session goes back to the Inbox — so it
    // runs without a confirmation and offers a plain re-link as undo.
    // No undo once the Work is resolved: re-linking would be a *new* link onto
    // a non-active Work, which the server refuses with 409. Say so rather than
    // offering a button that cannot keep its promise.
    sessionActions.notify({
      tone: work.status === 'active' ? 'success' : 'warn',
      message: work.status === 'active'
        ? `⤺ 세션을 Inbox로 되돌렸습니다 ("${work.title}" 연결 해제).`
        : `⤺ 세션을 Inbox로 되돌렸습니다. 종료된 Work "${work.title}"에는 다시 연결할 수 없습니다.`,
      undo: work.status === 'active'
        ? {
          label: '되돌리기',
          run: async () => {
            await sessionActions.link(work.id, sessionRef(link), link.role);
          },
        }
        : undefined,
    });
  };

  const handleSetRole = (link: WorkSessionLink, role: WorkSessionRole) => {
    if (!sessionActions) return;
    const previous = link.role;
    void sessionActions.link(work.id, sessionRef(link), role)
      .then(() => {
        sessionActions.notify({
          tone: 'success',
          message: `🏷 역할을 ${ROLE_LABELS[role]}(으)로 바꿨습니다.`,
          // A link that had no role cannot be put back: the server's re-link
          // keeps the existing role when none is sent, so there is no "clear".
          undo: previous
            ? {
                label: `${ROLE_LABELS[previous]}로 되돌리기`,
                run: async () => {
                  await sessionActions.link(work.id, sessionRef(link), previous);
                },
              }
            : undefined,
        });
      })
      // The failure is already surfaced through the Works error alert.
      .catch(() => {});
  };

  // Deleting a Work cannot be undone — unlike a move or an unlink, there is no
  // notice with an undo — so the confirmation is never skipped. `window.confirm`
  // matches how `useWorks.completeWork` gates its own destructive path; the copy
  // lives in a pure helper (`confirmDeleteWorkMessage`) because it branches on
  // status. The prompt stays here rather than in the hook because the dialog is
  // the only entry point and already holds the Work the message describes.
  const handleDelete = () => {
    if (!onDelete || busy) return;
    if (!window.confirm(confirmDeleteWorkMessage(work))) return;
    runAction(() => onDelete(work.id).then(() => { onClose(); }));
  };

  /**
   * Cleanup for links whose session lost every card. Confirmed, because unlike
   * an unlink there is nothing to return to the Inbox — a session with no cards
   * is filtered out of it — so this is the one link removal with no way back.
   */
  const missingLinkCount = sessionRows.filter((row) => row.cardsMissingAt).length;
  const handlePrune = () => {
    if (!onPruneSessions || busy || missingLinkCount === 0) return;
    const message = `카드가 하나도 남지 않은 세션 ${missingLinkCount}개의 연결을 끊습니다.\n`
      + '이 세션들은 Inbox로 돌아오지 않습니다 (카드가 없는 세션은 Inbox에 나타나지 않습니다).';
    if (!window.confirm(message)) return;
    setPruneError(null);
    setBusy(true);
    // Not `runAction`: that swallows the rejection into the shared Works alert,
    // and this button is far enough from the top banner that the reason has to
    // land next to it.
    void onPruneSessions(work.id)
      .catch((e: unknown) => {
        setPruneError(e instanceof Error ? e.message : '끊긴 세션을 정리하지 못했습니다');
      })
      .finally(() => setBusy(false));
  };

  const runSummary = () => {
    if (!onRegenerateSummary || summaryBusy) return;
    setSummaryBusy(true);
    setSummaryError(null);
    void onRegenerateSummary(work.id)
      .catch((e: unknown) => setSummaryError(e instanceof Error ? e.message : '요약 생성에 실패했습니다'))
      .finally(() => setSummaryBusy(false));
  };
  const summaryDisabled = !onRegenerateSummary || summaryBusy || busy;

  return (
    <DialogSkeleton
      title={work.title}
      onClose={closeGuarded}
      width="920px"
      persistSizeKey="work-detail"
      defaultSize={{ width: 920, height: 760 }}
      className="work-detail-dialog"
    >
      <div className="work-detail">
        {/* The one status badge on this screen. It used to be joined by
            "3일째 active" in the 기간 row below, which said the same two facts
            in a second language. */}
        <div className="work-detail-status">
          <span className={`kv2-badge work-status work-status--${work.status}`}>
            {describeWorkStatusBadge(work)}
          </span>
        </div>

        {/* 제목 · 디렉토리 — inline, because a Work seeded from a session's
            first prompt is titled by that prompt, and that is rarely the name
            the work ends up having. */}
        <section className="work-detail-row work-detail-meta">
          <div className="work-detail-panel-title">기본 정보</div>
          <div className="work-detail-row-body work-detail-meta-body">
            <label className="work-meta-field work-meta-field--title">
              <span className="work-date-label">제목</span>
              <input
                type="text"
                className="kv2-input work-meta-input"
                value={titleDraft ?? work.title}
                disabled={!onUpdateMeta || metaBusy || busy}
                readOnly={!onUpdateMeta}
                title={onUpdateMeta ? 'Enter 저장 · Esc 취소' : undefined}
                onChange={(e) => setDraft('title', e.target.value)}
                onKeyDown={(e) => metaKeyDown('title', e)}
                onBlur={(e) => blurMeta('title', e.target.value)}
              />
            </label>
            <label className="work-meta-field">
              <span className="work-date-label">디렉토리</span>
              <input
                type="text"
                className="kv2-input work-meta-input works-mono"
                value={dirDraft ?? work.projectDir ?? ''}
                placeholder="비워두면 특정 폴더에 묶이지 않습니다"
                disabled={!onUpdateMeta || metaBusy || busy}
                readOnly={!onUpdateMeta}
                title={onUpdateMeta ? 'Enter 저장 · Esc 취소' : undefined}
                onChange={(e) => setDraft('projectDir', e.target.value)}
                onKeyDown={(e) => metaKeyDown('projectDir', e)}
                onBlur={(e) => blurMeta('projectDir', e.target.value)}
              />
            </label>
          </div>
          {metaError && <p className="work-date-error">⚠ {metaError}</p>}
        </section>

        {/* Summary hero — full-width, right under the title (mockup ③). */}
        <section className="work-summary-hero">
          {work.summary ? (
            <>
              <div className="work-summary-head">
                📝 Summary
                <span className="kv2-badge work-summary-model">{work.summary.model}</span>
              </div>
              <ul className="work-summary-lines">
                {work.summary.lines.map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
              <div className="work-summary-meta">
                <span>{formatDateTime(work.summary.generatedAt)} 생성</span>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--small work-summary-regen"
                  disabled={summaryDisabled}
                  title={onRegenerateSummary ? undefined : '요약 생성은 준비 중입니다'}
                  onClick={runSummary}
                >
                  {summaryBusy ? '생성 중…' : '↻ 다시 생성'}
                </button>
              </div>
            </>
          ) : (
            <div className="work-summary-empty">
              <p className="work-summary-empty-text">
                아직 요약이 없습니다. 연결된 세션 transcript를 종합해 3~5줄 요약을 생성합니다.
              </p>
              {/* Outline, not primary: this spends an LLM call, and it was the
                  strongest-looking target on a dialog whose actual purpose is
                  reading a Work and closing it. */}
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--outline"
                disabled={summaryDisabled}
                title={onRegenerateSummary ? undefined : '요약 생성은 준비 중입니다'}
                onClick={runSummary}
              >
                {summaryBusy ? '생성 중…' : '📝 요약 생성'}
              </button>
            </div>
          )}
          {summaryError && <p className="work-summary-error">⚠ {summaryError}</p>}
        </section>

        {/* 메모 — human-owned, right under the machine-owned Summary and
            visibly not part of it: no 📝 hero framing, its own bordered panel.
            The two sit adjacent on purpose (both answer "what is this Work
            about?") but only one of them survives a `↻ 다시 생성`. */}
        <section className="work-detail-row work-notes">
          <div className="work-detail-panel-title">메모</div>
          <div className="work-detail-row-body work-notes-body">
            <textarea
              className="kv2-input work-notes-input"
              value={notesValue}
              rows={4}
              maxLength={WORK_NOTES_MAX_LENGTH}
              disabled={!onUpdateNotes || notesBusy}
              readOnly={!onUpdateNotes}
              placeholder={onUpdateNotes
                ? '다음에 볼 것, 막힌 지점, 결정 사항… (Summary와 달리 자동으로 덮어쓰이지 않습니다)'
                : '메모 편집은 준비 중입니다'}
              aria-label="메모"
              onChange={(e) => setNotesDraft(e.target.value)}
            />
            <div className="work-notes-foot">
              <span className="work-notes-count">
                {notesValue.length} / {WORK_NOTES_MAX_LENGTH}
              </span>
              {notesDirty && <span className="work-notes-dirty">저장하지 않은 변경</span>}
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--outline"
                disabled={!onUpdateNotes || notesBusy || !notesDirty || notesTooLong}
                onClick={saveNotes}
              >
                {notesBusy ? '저장 중…' : '메모 저장'}
              </button>
            </div>
            {notesError && <p className="work-date-error">⚠ {notesError}</p>}
          </div>
        </section>

        {/* 기간 — the dialog-side twin of the Timeline's bar-edge drag. Both
            write day-level dates and preserve the original time-of-day. */}
        <section className="work-detail-row">
          <div className="work-detail-panel-title">기간</div>
          <div className="work-detail-row-body">
            <label className="work-date-field">
              <span className="work-date-label">시작</span>
              <input
                type="date"
                className="kv2-input work-date-input"
                value={startInput}
                max={endInput || undefined}
                disabled={datesDisabled}
                onChange={(e) => commitDate('startedAt', e.target.value)}
              />
            </label>
            <span className="work-date-arrow" aria-hidden="true">→</span>
            <label className="work-date-field">
              <span className="work-date-label">{endLabel}</span>
              <input
                type="date"
                className="kv2-input work-date-input"
                value={endInput}
                min={startInput || undefined}
                disabled={datesDisabled}
                onChange={(e) => commitDate('resolvedAt', e.target.value)}
              />
            </label>
            {isOpenWork && endInput && (
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--ghost"
                disabled={datesDisabled}
                onClick={() => commitDate('resolvedAt', '')}
              >
                예정일 지우기
              </button>
            )}
            <div className="work-detail-facts">
              {/* An `active` Work whose planned end has passed. The date input
                  above shows it either way, and a date in the past reads exactly
                  like one in the future unless something says so. */}
              {describeWorkPlanOverrun(work) && (
                <span className="kv2-badge work-overrun-chip">{describeWorkPlanOverrun(work)}</span>
              )}
              {/* The day count lives in the badge at the top; what this row can
                  add is when the Work was closed and when it last moved. */}
              {!isOpenWork && work.resolvedAt && (
                <span>{formatShortDate(work.resolvedAt)} {WORK_STATUS_LABELS[work.status]}</span>
              )}
              <span>마지막 활동 {formatDateTime(lastActivity) || '-'}</span>
            </div>
          </div>
          {dateError && <p className="work-date-error">⚠ {dateError}</p>}
          {dateHint && !dateError && <p className="work-date-hint">{dateHint}</p>}
        </section>

        <section className="work-detail-row">
          <div className="work-detail-panel-title">산출물</div>
          <div className="work-detail-row-body">
            {describeWorkArtifacts({ cardCount, doneCount, inProgressCount }).map((chip) => (
              <span className="kv2-badge" key={chip.label} title={chip.hint}>
                {chip.label} {chip.count}
              </span>
            ))}
            {wikiLabel ? (
              <span className="work-detail-fact">wiki 문서: {wikiLabel}</span>
            ) : (
              <span className="work-detail-fact work-detail-wiki">
                wiki 문서:
                {wikiDocPaths.map((docPath) => (
                  <code className="works-mono work-detail-wiki-doc" key={docPath} title={docPath}>
                    {docPath}
                  </code>
                ))}
              </span>
            )}
          </div>
          {detailError && (
            <p className="work-date-error">
              ⚠ 산출물 집계를 불러오지 못했습니다 ({detailError}) — 보드에 남은 카드만 세었습니다.
            </p>
          )}
        </section>

        <section className="work-detail-sessions">
          <div className="work-detail-panel-title">연결된 세션 {links.length}</div>
          {links.length === 0 ? (
            <p className="works-empty">연결된 세션이 없습니다.</p>
          ) : (
            sessionRows.map(({ link, title, cardCount: sessionCardCount, archived, cardsMissingAt, startedAt }) => (
              <div
                className={`work-session-item${cardsMissingAt ? ' work-session-item--missing' : ''}`}
                key={link.sessionId}
              >
                {link.role && (
                  <span className={`kv2-badge works-role works-role--${link.role}`}>
                    {ROLE_LABELS[link.role]}
                  </span>
                )}
                <div className="work-session-body">
                  <div className="work-session-title">{title}</div>
                  <div className="work-session-meta">
                    <span title={startedAt ? '이 세션의 첫 카드가 만들어진 날' : 'Work에 연결된 날'}>
                      {formatShortDate(startedAt ?? link.linkedAt)}
                      {startedAt ? '' : ' 연결'}
                    </span>
                    {link.projectDir ? ` · ${projectDirLabel(link.projectDir)}` : ''}
                    {` · 카드 ${sessionCardCount}`}
                    {archived ? ' · 보관됨' : ''}
                    {` · `}
                    <span className="works-mono">{shortSessionId(link.sessionId)}</span>
                  </div>
                  {cardsMissingAt && (
                    <div className="work-session-missing">
                      ⚠ 카드가 하나도 남아 있지 않습니다 — 이 링크는 Work의 시작일을 연결 시각으로
                      끌어내립니다. 아래 <b>끊긴 세션 정리</b>로 제거하세요.
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--small kv2-btn--ghost"
                  onClick={() => onOpenSession(link.sessionId)}
                >
                  대화
                </button>
                {sessionActions && (
                  <WorkSessionMenu
                    role={link.role}
                    disabled={busy}
                    onMove={() => setMoveLink(link)}
                    onSetRole={(role) => handleSetRole(link, role)}
                    // The unlink rejects through the shared Works error alert;
                    // swallowing here keeps that from becoming an unhandled
                    // rejection (same contract as `handleSetRole`).
                    onUnlink={() => { void handleUnlink(link).catch(() => {}); }}
                  />
                )}
              </div>
            ))
          )}
          {/* No "＋ 세션 연결" button. It was a permanently disabled control —
              App never passed a handler — and linking a session already has a
              working home: Inbox triage, or ⋯ → 다른 Work로 이동 on the session
              that owns it. A button that can never fire is worse than no
              button, because it advertises a capability and then withholds it. */}
        </section>

        {pruneError && <p className="work-date-error">⚠ {pruneError}</p>}

        {/* Only meaningful while the Work can still be completed. A resolved
            Work has already been swept (or was discarded), so the notice would
            describe an action that is no longer available. */}
        {!isResolved && (
          <div className="work-detail-note">
            ✅ <b>완료</b> 시: 산하 카드를 일괄 done 처리 후 archive → wiki 파이프라인이 연결된 세션 transcript를 종합해 문서를 생성합니다.
          </div>
        )}

        <div className="kv2-dialog-footer">
          <div className="kv2-actions-split">
            {/* Destructive actions grouped at the left edge, least severe first:
                폐기 keeps everything and only closes the Work, 삭제 removes it. */}
            <div className="kv2-actions-danger">
              {/* 폐기 only closes the Work (cards and sessions stay put), 삭제
                  removes it — so the softer variant carries the softer action
                  instead of both reading as the same red. */}
              <button
                type="button"
                className="kv2-btn kv2-btn--subtle-danger"
                // 폐기 closes an *open* Work. A resolved one is already closed,
                // and re-closing a completed Work would only overwrite the
                // resolution that its archive sweep recorded.
                disabled={busy || isResolved || resolveMode !== null}
                title={isResolved ? '이미 종료된 Work입니다' : undefined}
                onClick={() => setResolveMode('discard')}
              >
                폐기…
              </button>
              <button
                type="button"
                className="kv2-btn kv2-btn--danger"
                disabled={busy || !onDelete}
                title={onDelete ? undefined : 'Work 삭제는 준비 중입니다'}
                onClick={handleDelete}
              >
                삭제…
              </button>
            </div>
            {/* 다시 열기 — the escape from what used to be a one-way door:
                before this, a completed Work could only be DELETEd, which threw
                the record away instead of undoing the completion. Only offered
                on a resolved Work, and grouped with the constructive actions
                (it restores rather than closes). */}
            {isResolved && (
              <button
                type="button"
                className="kv2-btn kv2-btn--outline"
                disabled={busy || !onReopen || resolveMode !== null}
                title={onReopen ? undefined : 'Work 다시 열기는 준비 중입니다'}
                onClick={() => setResolveMode('reopen')}
              >
                ↺ 다시 열기…
              </button>
            )}
            {/* 병합 needs the Works list to pick a target from, which arrives
                with `sessionActions`. */}
            {!isResolved && onMerge && sessionActions && (
              <button
                type="button"
                className="kv2-btn kv2-btn--outline"
                disabled={busy || merging || links.length === 0}
                title={links.length === 0 ? '옮길 세션이 없습니다' : undefined}
                onClick={() => setMerging(true)}
              >
                ⇉ 다른 Work에 병합…
              </button>
            )}
            {missingLinkCount > 0 && (
              <button
                type="button"
                className="kv2-btn kv2-btn--outline"
                disabled={busy || !onPruneSessions}
                title={onPruneSessions ? undefined : '세션 정리는 준비 중입니다'}
                onClick={handlePrune}
              >
                🧹 끊긴 세션 정리 ({missingLinkCount})
              </button>
            )}
            <div className="kv2-actions-primary">
              <button
                type="button"
                className="kv2-btn kv2-btn--success"
                disabled={busy || work.status !== 'active' || resolveMode !== null}
                onClick={() => setResolveMode('complete')}
              >
                ✔ 완료 (일괄 archive)
              </button>
            </div>
          </div>
        </div>
      </div>

      {resolveMode && (
        <WorkResolveConfirmDialog
          work={work}
          mode={resolveMode}
          archivedCardCount={detail?.archivedCardCount ?? null}
          onCancel={() => setResolveMode(null)}
          onConfirm={() => {
            if (resolveMode === 'complete') return onComplete(work.id, { confirmed: true });
            if (resolveMode === 'discard') return onDiscard(work.id, { confirmed: true });
            // `onReopen` omitted means the button was disabled, so this is
            // unreachable from the UI; answered as declined rather than thrown.
            return onReopen ? onReopen(work.id) : Promise.resolve<WorkResolveOutcome>('declined');
          }}
          onResolved={handleResolved}
        />
      )}

      {merging && onMerge && (
        <WorkMergeDialog
          work={work}
          works={sessionActions?.works ?? []}
          cards={cards}
          onClose={() => setMerging(false)}
          onMerge={(intoWorkId) => onMerge(work.id, intoWorkId)}
        />
      )}

      {moveLink && sessionActions && (
        <MoveSessionDialog
          link={moveLink}
          fromWork={work}
          works={sessionActions.works}
          cards={cards}
          onClose={() => setMoveLink(null)}
          onMove={(toWorkId, role) => handleMove(moveLink, toWorkId, role)}
          onMoveToNewWork={(title, role) => handleMoveToNewWork(moveLink, title, role)}
          onUnlink={() => handleUnlink(moveLink)}
        />
      )}
    </DialogSkeleton>
  );
}
