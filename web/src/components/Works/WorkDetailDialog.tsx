import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  KanbanCard,
  MoveWorkSessionResponse,
  Work,
  WorkInboxSession,
  WorkSessionLink,
  WorkSessionRole,
  WorkSessionsResponse,
  WorkSummaryResponse,
} from '../../../../src/core/types';
import { WORK_NOTES_MAX_LENGTH } from '../../../../src/core/types';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { DirectoryPicker } from '../Card/DirectoryPicker';
import { MoveSessionDialog } from './MoveSessionDialog';
import { WorkMergeDialog } from './WorkMergeDialog';
import { WorkResolveConfirmDialog, type WorkResolveMode } from './WorkResolveConfirmDialog';
import type { WorkResolveOutcome } from '../../hooks/useWorks';
import { WorkSessionMenu } from './WorkSessionMenu';
import { WorkWikiDocDialog } from './WorkWikiDocDialog';
import type { WorkSessionNoticeState } from './WorkSessionNotice';
import {
  ROLE_LABELS,
  confirmDeleteWorkMessage,
  describeWorkPlanOverrun,
  describeWorkStatusBadge,
  formatShortDate,
  projectDirLabel,
  shortSessionId,
} from './worksAssign';
import { endFromDateInputValue, fromDateInputValue, toDateInputValue } from './timelineModel';
import { dirAccentClass } from './worksAffinity';
import { WorkWikiArchive } from './WorkWikiArchive';
import { WorkSessionPicker } from './WorkSessionPicker';
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
  assignableSessions?: WorkInboxSession[];
  onAddSession?: (session: WorkInboxSession) => Promise<void>;
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
  onRegenerateSummary?: (workId: string) => Promise<WorkSummaryResponse>;
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
 * 완료 and 폐기 change Work state, so their footer
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
  assignableSessions = [],
  onAddSession,
}: WorkDetailDialogProps) {
  const [busy, setBusy] = useState(false);
  const [summaryBusy, setSummaryBusy] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryNotice, setSummaryNotice] = useState<string | null>(null);
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
  const boardLastActivity = useMemo(() => {
    const times = workCards.map((c) => c.updatedAt).filter(Boolean);
    times.push(work.updatedAt);
    return times.sort().at(-1);
  }, [workCards, work.updatedAt]);

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
  // Tile labels are English like the card detail's (RUNTIME · MODEL · DIRECTORY);
  // `.kv2-meta-label` uppercases them. `End` becomes `Planned end` while the
  // Work is open because that date is a forecast, not a record.
  const endLabel = isOpenWork ? 'Planned end' : 'End';
  const canEditMeta = Boolean(onUpdateMeta) && !metaBusy && !busy;
  const directoryValue = work.projectDir?.trim() || 'Not set';

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
  // Collapsed like the card detail's sidebar panels, unless there is already
  // something to read; a draft in progress keeps it open regardless.
  const [notesOpen, setNotesOpen] = useState(() => Boolean((work.notes ?? '').trim()));
  const [openWikiDoc, setOpenWikiDoc] = useState<string | null>(null);
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
    setSummaryNotice(null);
    void onRegenerateSummary(work.id)
      .then(result => setSummaryNotice(`세션 ${result.generatedSessions.length}개 반영 · 저장된 카드 기반 ${result.cardSourceSessions?.length ?? 0}개`
        + (result.skippedSessions.length ? ` · 기록이 없어 제외된 세션 ${result.skippedSessions.length}개` : '')))
      .catch((e: unknown) => setSummaryError(e instanceof Error ? e.message : '요약 생성에 실패했습니다'))
      .finally(() => setSummaryBusy(false));
  };
  const summaryDisabled = !onRegenerateSummary || summaryBusy || busy;

  return (
    <DialogSkeleton
      // The title still names the dialog (aria-labelledby) even though the
      // `kv2-dialog--detail` chrome hides the skeleton's own header: the hero
      // below draws the title the way the card detail does.
      title={work.title}
      onClose={closeGuarded}
      width="920px"
      persistSizeKey="work-detail"
      defaultSize={{ width: 920, height: 760 }}
      className={`kv2-dialog--detail work-detail-dialog work-detail-dialog--${work.status}`}
    >
      <div className="kv2-detail-shell work-detail">
        {/* ── Hero: status badge + meta, then the title ─────────────
            Same shell as CardDetailDialog: a status badge top-left, the id
            and close top-right, the title as the one large line underneath. */}
        <div className="kv2-status-row kv2-status-row--hero work-detail-status">
          <span className={`kv2-status-badge work-status work-status--${work.status}`}>
            {describeWorkStatusBadge(work)}
          </span>
          <div className="kv2-status-row-meta">
            {describeWorkPlanOverrun(work) && (
              <span className="kv2-badge work-overrun-chip">{describeWorkPlanOverrun(work)}</span>
            )}
            <span className="kv2-card-id-meta work-detail-id" title={work.id}>🆔 {work.id.slice(0, 8)}</span>
            <button
              type="button"
              className="kv2-dialog-close"
              onClick={closeGuarded}
              aria-label="Close dialog"
            >
              ×
            </button>
          </div>
        </div>

        <div className="kv2-title-row work-detail-title-row">
          <div className="kv2-title-block">
            {titleDraft !== null ? (
              <input
                type="text"
                className="kv2-input kv2-title-input work-title-input"
                value={titleDraft}
                autoFocus
                aria-label="제목"
                disabled={metaBusy || busy}
                title="Enter 저장 · Esc 취소"
                onChange={(e) => setDraft('title', e.target.value)}
                onKeyDown={(e) => metaKeyDown('title', e)}
                onBlur={(e) => blurMeta('title', e.target.value)}
              />
            ) : (
              <button
                type="button"
                className={`kv2-title-text kv2-unstyled-button work-title-text${onUpdateMeta ? ' kv2-editable-text' : ''}`}
                title={onUpdateMeta ? '클릭해서 제목 편집' : undefined}
                disabled={!onUpdateMeta || metaBusy || busy}
                onClick={() => setDraft('title', work.title)}
              >
                {work.title}
              </button>
            )}
            {metaError && <p className="work-date-error">⚠ {metaError}</p>}
          </div>
        </div>

        <div className="work-detail-progress">
          <div className="works-card-meta" aria-label="작업 현황">
            <span>세션 {links.length}</span><span>카드 {detail?.cardCount ?? workCards.length}</span>
            <span>진행 {detail?.inProgressCount ?? workCards.filter(card => card.status === 'todo' || card.status === 'in_progress').length}</span>
            <span>완료 {detail?.doneCount ?? workCards.filter(card => card.status === 'done' || card.status === 'complete').length}</span>
            <span>최근 활동 {formatDateTime(lastActivity)}</span>
          </div>
          {detailError && <p role="alert">기록을 불러오지 못했습니다: {detailError}</p>}
        </div>
        {/* ── Meta tiles ───────────────────────────────────────────
            The card detail's RUNTIME · MODEL · PERMISSION row, for a Work:
            DIRECTORY on its own tile (it is a project identity, not a sub-field
            of the title) — the card detail's tile verbatim, a click-to-edit
            `kv2-meta-editable` that swaps to `DirectoryPicker` — then the
            dates as three equal tiles across the full width. */}
        <div className="kv2-detail-overview work-detail-overview">
          <div className="kv2-meta-panel work-meta-panel work-meta-panel--dates">
            {dirDraft !== null ? (
              <div className={`kv2-meta-card kv2-meta-card--edit kv2-meta-card--directory work-meta-card ${dirAccentClass(work.projectDir)}`}>
                <span className="kv2-meta-label">Directory</span>
                {/* Escape abandons the draft only — the same contract as the
                    title's Escape. `DialogSkeleton` would otherwise read the
                    keystroke as "close the dialog" as well. */}
                <div
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') e.stopPropagation();
                  }}
                >
                  <DirectoryPicker
                    id={`work-${work.id}-directory-input`}
                    value={dirDraft}
                    onChange={(value) => setDraft('projectDir', value)}
                    onCommit={(value) => commitMeta('projectDir', value)}
                    onCancel={() => {
                      setDraft('projectDir', null);
                      setMetaError(null);
                    }}
                    commitLabel="Save"
                    placeholder="/path/to/project"
                    autoFocus
                    variant="meta"
                  />
                </div>
              </div>
            ) : onUpdateMeta ? (
              <button
                type="button"
                className={`kv2-meta-card kv2-meta-card--directory kv2-meta-editable work-meta-card ${dirAccentClass(work.projectDir)}`}
                disabled={!canEditMeta}
                onClick={() => setDraft('projectDir', work.projectDir ?? '')}
                title={work.projectDir ? work.projectDir : 'Click to edit directory'}
              >
                <span className="kv2-meta-label">Directory</span>
                <span className={`kv2-meta-value${work.projectDir ? ' kv2-meta-value--mono' : ' kv2-meta-placeholder'}`}>
                  {directoryValue}
                </span>
              </button>
            ) : (
              <div
                className={`kv2-meta-card kv2-meta-card--directory work-meta-card ${dirAccentClass(work.projectDir)}`}
                title={work.projectDir ?? undefined}
              >
                <span className="kv2-meta-label">Directory</span>
                <span className={`kv2-meta-value${work.projectDir ? ' kv2-meta-value--mono' : ' kv2-meta-placeholder'}`}>
                  {directoryValue}
                </span>
              </div>
            )}
            <div className="kv2-meta-card work-meta-card">
              <span className="kv2-meta-label">Start</span>
              <input
                type="date"
                className="kv2-input work-date-input"
                aria-label="Start"
                value={startInput}
                max={endInput || undefined}
                disabled={datesDisabled}
                onChange={(e) => commitDate('startedAt', e.target.value)}
              />
            </div>
            <div className="kv2-meta-card work-meta-card">
              <span className="kv2-meta-label">{endLabel}</span>
              <div className="work-meta-card-line">
                <input
                  type="date"
                  className="kv2-input work-date-input"
                  aria-label={endLabel}
                  value={endInput}
                  min={startInput || undefined}
                  disabled={datesDisabled}
                  onChange={(e) => commitDate('resolvedAt', e.target.value)}
                />
                {isOpenWork && endInput && (
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--small kv2-btn--ghost"
                    disabled={datesDisabled}
                    title="종료 예정일 지우기"
                    onClick={() => commitDate('resolvedAt', '')}
                  >
                    지우기
                  </button>
                )}
              </div>
            </div>
            <div className="kv2-meta-card work-meta-card">
              <span className="kv2-meta-label">Last activity</span>
              {/* Read-only, but in the same field chrome as the two date inputs
                  beside it — a bare bold value next to two bordered pickers read
                  as a different kind of thing. The resolution date is not
                  repeated here: the End input already holds it. */}
              <div className="kv2-input work-meta-input work-meta-readonly work-detail-facts" aria-label="Last activity">
                {formatDateTime(lastActivity) || '-'}
              </div>
            </div>
          </div>
          {dateError && <p className="work-date-error">⚠ {dateError}</p>}
        </div>

        {/* ── Summary ─────────────────────────────────────────────
            The card detail's Prompt block: a heading line with its actions,
            then the text in an accent-bordered box. */}
        <section className="kv2-detail-primary-block work-detail-section work-summary">
          <div className="kv2-panel-heading work-detail-heading">
            <span className="kv2-session-title">Summary</span>
            {work.summary && (
              <span className="kv2-badge work-summary-model">{work.summary.model}</span>
            )}
            <span className="work-detail-heading-actions">
              {work.summary && (
                <span className="kv2-session-helper">{formatDateTime(work.summary.generatedAt)} 생성</span>
              )}
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--outline"
                disabled={summaryDisabled}
                title={onRegenerateSummary ? undefined : '요약 생성은 준비 중입니다'}
                onClick={runSummary}
              >
                {summaryBusy ? '생성 중…' : work.summary ? '↻ 다시 생성' : '📝 요약 생성'}
              </button>
            </span>
          </div>
          {work.summary ? (
            <ul className="work-summary-lines work-detail-box">
              {work.summary.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="work-summary-empty-text work-detail-box work-detail-box--empty">
              연결된 세션에서 한 일과 남은 일을 요약할 수 있습니다. 대화와 실행 기록은 아래 세션에서 확인하세요.
            </p>
          )}
          {summaryNotice && <p role="status" className="kv2-session-helper">{summaryNotice}</p>}
          {summaryError && <p className="work-summary-error">⚠ {summaryError}</p>}
        </section>

        {/* ── 메모 — collapsible like the card detail's sidebar panels ──
            Human-owned, visibly separate from the machine-owned Summary. Opens
            by itself when there is something to read or a draft in progress. */}
        <section className="kv2-detail-primary-block work-detail-section work-notes">
          <div className="kv2-panel-heading work-detail-heading">
            <button
              type="button"
              className="kv2-session-title work-detail-disclosure"
              aria-expanded={notesOpen}
              onClick={() => setNotesOpen((open) => !open)}
            >
              메모
              <span className="kv2-chevron" style={{ transform: notesOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
            </button>
            {notesDirty && <span className="work-notes-dirty">저장하지 않은 변경</span>}
            {!notesOpen && (work.notes ?? '').trim() && (
              <span className="kv2-session-helper work-notes-peek">{(work.notes ?? '').trim().split('\n')[0]}</span>
            )}
          </div>
          {!notesOpen && !(work.notes ?? '').trim() && (
            <div className="kv2-session-helper">다음에 볼 것, 막힌 지점, 결정 사항. Summary와 달리 자동으로 덮어쓰이지 않습니다.</div>
          )}
          {notesOpen && (
            <div className="work-notes-body">
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
          )}
        </section>

        {/* ── 연결된 세션 ───────────────────────────────────────── */}
        <section className="kv2-detail-primary-block work-detail-section work-detail-sessions">
          <div className="kv2-panel-heading work-detail-heading">
            <span className="kv2-session-title">연결된 세션</span>
            <span className="kv2-badge kv2-badge--session">{links.length}</span>
          </div>
          {links.length === 0 ? (
            <p className="works-empty">연결된 세션이 없습니다.</p>
          ) : (
            <div className="work-session-list">
              {sessionRows.map(({ link, title, cardCount: sessionCardCount, archived, cardsMissingAt, startedAt }) => (
                <div
                  className={[
                    'work-session-item',
                    // The role tints the whole row (background + left edge), not
                    // just the chip: a list of 개발 / 리뷰 / 디버그 rows should
                    // read as bands at a glance.
                    link.role ? `work-session-item--role-${link.role}` : '',
                    cardsMissingAt ? 'work-session-item--missing' : '',
                  ].filter(Boolean).join(' ')}
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
                    className="kv2-btn kv2-btn--small kv2-btn--outline"
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
              ))}
            </div>
          )}
          {!isResolved && onAddSession && <WorkSessionPicker sessions={assignableSessions} onAdd={onAddSession} />}
        </section>

        {work.archivedAt && <WorkWikiArchive
          docPaths={[...new Set([...(detail?.wikiDocPaths ?? []), ...(work.wikiDocPath ? [work.wikiDocPath] : [])])]}
          pending={detail?.wikiPending ?? false}
          loading={detailLoading}
          error={detailError}
          onOpenDoc={setOpenWikiDoc}
        />}
        {pruneError && <p className="work-date-error work-detail-inline-error">⚠ {pruneError}</p>}

        {/* Only meaningful while the Work can still be completed. */}
        {!isResolved && (
          <div className="work-detail-note">
            완료하면 연결된 카드가 보관됩니다. 이후 Wiki 디렉토리와 생성된 문서를 확인할 수 있습니다.
          </div>
        )}

        {/* ── Footer: the card detail's rail — danger left, primary right ── */}
        <div className="kv2-dialog-footer kv2-dialog-actions kv2-dialog-actions--detail work-detail-footer">
          <div className="kv2-dialog-actions-rail kv2-actions-split">
            <div className="kv2-dialog-danger-row kv2-actions-danger">
              <button
                type="button"
                className="kv2-btn kv2-btn--subtle-danger"
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
            <div className="kv2-dialog-actions-group work-detail-footer-secondary">
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
            </div>
            <div className="kv2-dialog-actions-group kv2-dialog-actions-group--detail-priority kv2-actions-primary">
              {isResolved && onReopen && <button type="button" className="kv2-btn kv2-btn--primary"
                disabled={busy || resolveMode !== null} onClick={() => setResolveMode('reopen')}>다시 열기</button>}
              {!isResolved && (
                <button
                  type="button"
                  className="kv2-btn kv2-btn--success"
                  disabled={busy || resolveMode !== null}
                  onClick={() => setResolveMode('complete')}
                >
                  ✔ 완료 (일괄 archive)
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {openWikiDoc && (
        <WorkWikiDocDialog docPath={openWikiDoc} onClose={() => setOpenWikiDoc(null)} />
      )}
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
