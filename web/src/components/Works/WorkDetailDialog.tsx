import React, { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { RuntimeBadge } from '../Board/BoardCardSections';
import { IdChip } from '../shared/IdChip';
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
import { WorkProjectChips } from './WorkAffinityMarks';
import type { TimelineHighlight } from './timelineRows';
import {
  WORK_SEARCH_FIELD_LABELS,
  searchHighlight,
  searchWorkSessions,
  splitOnQuery,
  type WorkSearchGroup,
} from './workSessionSearch';
import { useWorkSearchCards } from '../../hooks/useWorkSearchCards';
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
  /**
   * Open a linked session's conversation (reuses SessionConversationModal via
   * App). A search result passes `focus` so the modal opens on that turn with
   * the same query highlighted.
   */
  onOpenSession: (sessionId: string, focus?: WorkSessionFocus) => void;
  /**
   * The 세션 흐름 section: the Board timeline (`TimelineView variant="work"`)
   * scoped to this Work, rendered by App because it owns the timeline's
   * callbacks. Receives the session search's hits so matching chips stand out
   * and the rest dims. Omit to hide the section.
   */
  renderTimeline?: (highlight: TimelineHighlight | null) => ReactNode;
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
  /**
   * Open straight into one of the dialog's own flows — the board's Work `⋯`
   * menu (`이름 변경` / `병합…` / `완료…`). Read once, on mount; omit for the
   * plain detail view.
   */
  initialIntent?: WorkDetailIntent;
}

export type WorkDetailIntent = 'rename' | 'merge' | 'complete';

/** Where a session conversation should open: prefilled search + the turn to show. */
export interface WorkSessionFocus {
  query?: string;
  cardId?: string;
}

/** Hits shown per session before its "N개 더" toggle. */
const SEARCH_HITS_PER_SESSION = 3;

function Highlighted({ text, query }: { text: string; query: string }) {
  return (
    <>
      {splitOnQuery(text, query).map((part, i) => (part.match ? <mark key={i}>{part.text}</mark> : part.text))}
    </>
  );
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
  renderTimeline,
  onUpdateDates,
  onRegenerateSummary,
  onDelete,
  onUpdateMeta,
  sessionActions,
  onPruneSessions,
  assignableSessions = [],
  onAddSession,
  initialIntent,
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
          // Server first: its scan reaches the archive months this Work can
          // touch, so a completed Work's rows still carry a runtime. The board
          // lookup is the fallback for a row the detail read has not caught up
          // with — the same precedence `cardCount`/`archived` use above.
          agentRuntime: summary?.agentRuntime
            ?? workCards.find((c) => c.sessionId === link.sessionId)?.agentRuntime,
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
          // A link made without one (API / older triage) borrows the session's
          // card directory, so the row still leads with its project chip.
          projectDir: link.projectDir
            ?? workCards.find((c) => c.sessionId === link.sessionId && c.projectDir)?.projectDir,
        };
      }),
    [links, detailBySession, cards, workCards],
  );

  const isResolved = work.status !== 'active';

  // ── KPI tiles ──
  // 실행 중 is read off the board (top-level `in_progress` cards), not
  // `detail.inProgressCount`, which also counts queued `todo` cards.
  const cardTotal = detail?.cardCount ?? workCards.length;
  const doneTotal = detail?.doneCount
    ?? workCards.filter((card) => card.status === 'done' || card.status === 'complete').length;
  const runningTotal = workCards.filter((card) => card.status === 'in_progress' && !card.parentCardId).length;
  const remainingTotal = Math.max(0, cardTotal - doneTotal - runningTotal);
  const projectCount = useMemo(() => {
    const dirs = new Set(sessionRows.map((row) => row.projectDir).filter(Boolean));
    return dirs.size;
  }, [sessionRows]);
  const plannedOverrun = describeWorkPlanOverrun(work);

  // ── Session search (Obsidian-style: grouped per session, snippet marked) ──
  const [searchQuery, setSearchQuery] = useState('');
  const deferredQuery = useDeferredValue(searchQuery);
  const trimmedQuery = deferredQuery.trim();
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const sessionIdList = useMemo(() => sessionRows.map((row) => row.link.sessionId), [sessionRows]);
  const searchCards = useWorkSearchCards(sessionIdList, workCards, searchQuery.trim().length > 0);
  const searchGroups = useMemo<WorkSearchGroup[]>(
    () => searchWorkSessions(sessionIdList, searchCards.cardsBySession, trimmedQuery),
    [sessionIdList, searchCards.cardsBySession, trimmedQuery],
  );
  const searchHitCount = searchGroups.reduce((sum, group) => sum + group.hits.length, 0);
  const timelineHighlight = useMemo(
    () => (trimmedQuery ? searchHighlight(searchGroups) : null),
    [trimmedQuery, searchGroups],
  );
  const rowBySession = useMemo(
    () => new Map(sessionRows.map((row) => [row.link.sessionId, row])),
    [sessionRows],
  );
  const toggleSet = (setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>, id: string) => {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const openHit = (sessionId: string, cardId?: string) => {
    onOpenSession(sessionId, { query: trimmedQuery || undefined, cardId });
  };

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
  const initialTitleDraft = initialIntent === 'rename' && onUpdateMeta ? work.title : null;
  const [titleDraft, setTitleDraft] = useState<string | null>(initialTitleDraft);
  const [dirDraft, setDirDraft] = useState<string | null>(null);
  const draftRef = useRef<{ title: string | null; projectDir: string | null }>({
    title: initialTitleDraft,
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
  const [propsOpen, setPropsOpen] = useState(false);
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
  const propsExpanded = propsOpen || dirDraft !== null || dateError !== null;

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
  const [resolveMode, setResolveMode] = useState<WorkResolveMode | null>(
    initialIntent === 'complete' && work.status === 'active' ? 'complete' : null,
  );
  /** Whether the merge target picker is open. */
  const [merging, setMerging] = useState(initialIntent === 'merge' && !!onMerge && !!sessionActions);

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
      // Wider than the card detail: 세션 흐름 is a day grid and needs the room.
      width="1080px"
      persistSizeKey="work-detail"
      defaultSize={{ width: 1080, height: 820 }}
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
            <IdChip id={work.id} kind="work" showKind className="kv2-card-detail-id work-detail-id" />
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

        {/* Every project the Work's sessions ran in, then its dates — the
            facts line the list row shows, so a Work reads the same in both. */}
        <div className="work-detail-facts-row">
          <WorkProjectChips work={work} />
          <span className="work-detail-facts-text">
            시작 {formatShortDate(work.startedAt)}
            {work.resolvedAt && ` · ${isResolved ? '종료' : '예정'} ${formatShortDate(work.resolvedAt)}`}
            {lastActivity && ` · 최근 활동 ${formatDateTime(lastActivity)}`}
          </span>
        </div>

        <div className="work-kpis" aria-label="작업 현황">
          <div className="work-kpi">
            <b>{links.length}</b>
            <span>세션{projectCount > 1 ? ` (프로젝트 ${projectCount})` : ''}</span>
          </div>
          <div className={`work-kpi${cardTotal > 0 && doneTotal >= cardTotal ? ' work-kpi--ok' : ''}`}>
            <b>{doneTotal}</b>
            <span>끝난 카드 / {cardTotal}</span>
          </div>
          <div className={`work-kpi${runningTotal > 0 ? ' work-kpi--running' : ''}`}>
            <b>{runningTotal}</b>
            <span>실행 중</span>
          </div>
          <div className={`work-kpi${plannedOverrun ? ' work-kpi--warn' : ''}`}>
            <b>{remainingTotal}</b>
            <span>남은 카드</span>
          </div>
        </div>
        {detailError && <p className="work-detail-inline-error" role="alert">기록을 불러오지 못했습니다: {detailError}</p>}

        {/* ── 세션 흐름 — the Board timeline, scoped to this Work ── */}
        {renderTimeline && links.length > 0 && (
          <section className="kv2-detail-primary-block work-detail-section work-detail-flow">
            <div className="kv2-panel-heading work-detail-heading">
              <span className="kv2-session-title">세션 흐름</span>
              <span className="work-detail-heading-actions kv2-session-helper">
                {timelineHighlight
                  ? `검색 결과가 있는 세션만 진하게 표시합니다`
                  : '칩을 누르면 그 카드가 열립니다'}
              </span>
            </div>
            {renderTimeline(timelineHighlight)}
          </section>
        )}

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
          {links.length > 0 && (
            <div className="work-search-bar">
              <span aria-hidden="true" className="work-search-icon">⌕</span>
              <input
                type="search"
                className="kv2-input work-search-input"
                placeholder="이 Work의 세션·카드 검색 (제목·프롬프트·결과)"
                aria-label="세션 검색"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Esc clears the search first; only an empty box lets the
                  // dialog close on the next Esc.
                  if (e.key === 'Escape' && searchQuery) {
                    e.stopPropagation();
                    setSearchQuery('');
                  }
                }}
              />
              {trimmedQuery && (
                <span className="work-search-count" role="status">
                  {searchHitCount}개 · 세션 {searchGroups.length}
                  {searchCards.pending > 0 && ' · 보관 카드 불러오는 중…'}
                  {searchCards.failed > 0 && ` · ${searchCards.failed}개 세션은 보드 카드만`}
                </span>
              )}
            </div>
          )}
          {links.length === 0 ? (
            <p className="works-empty">연결된 세션이 없습니다.</p>
          ) : trimmedQuery ? (
            searchGroups.length === 0 ? (
              <p className="works-empty work-search-empty">
                {searchCards.pending > 0
                  ? '보관된 카드까지 찾는 중입니다…'
                  : `"${trimmedQuery}"와 일치하는 세션·카드가 없습니다.`}
              </p>
            ) : (
              <div className="work-search-results">
                {searchGroups.map(({ sessionId, hits }) => {
                  const row = rowBySession.get(sessionId);
                  const open = !collapsedGroups.has(sessionId);
                  const showAll = expandedGroups.has(sessionId);
                  const shown = showAll ? hits : hits.slice(0, SEARCH_HITS_PER_SESSION);
                  return (
                    <div key={sessionId} className={`work-search-group${open ? ' is-open' : ''}`}>
                      <div className="work-search-group-head">
                        <button
                          type="button"
                          className="work-search-group-toggle"
                          aria-expanded={open}
                          onClick={() => toggleSet(setCollapsedGroups, sessionId)}
                        >
                          <span className="work-search-caret" aria-hidden="true">▸</span>
                          {row?.projectDir && (
                            <span className={`works-dir-chip kv2-project-chip ${dirAccentClass(row.projectDir)}`} title={row.projectDir}>
                              {projectDirLabel(row.projectDir)}
                            </span>
                          )}
                          <span className="work-search-group-title">
                            <Highlighted text={row?.title ?? shortSessionId(sessionId)} query={trimmedQuery} />
                          </span>
                        </button>
                        <span className="work-search-turns">
                          {hits.map((hit) => (
                            <button
                              key={hit.cardId}
                              type="button"
                              className="work-search-turn"
                              title={`T${hit.turnNumber} 대화 열기`}
                              onClick={() => openHit(sessionId, hit.cardId)}
                            >
                              T{hit.turnNumber}
                            </button>
                          ))}
                        </span>
                        <span className="work-search-group-count">{hits.length}</span>
                      </div>
                      {open && (
                        <div className="work-search-hits">
                          {shown.map((hit) => (
                            <button
                              key={hit.cardId}
                              type="button"
                              className="work-search-hit"
                              onClick={() => openHit(sessionId, hit.cardId)}
                            >
                              <span className="work-search-hit-where">
                                <b>T{hit.turnNumber}</b>
                                <small>{WORK_SEARCH_FIELD_LABELS[hit.field]}</small>
                              </span>
                              <span className="work-search-hit-snippet">
                                <Highlighted text={hit.snippet} query={trimmedQuery} />
                              </span>
                            </button>
                          ))}
                          {hits.length > SEARCH_HITS_PER_SESSION && (
                            <button
                              type="button"
                              className="kv2-btn kv2-btn--small kv2-btn--ghost work-search-more"
                              onClick={() => toggleSet(setExpandedGroups, sessionId)}
                            >
                              {showAll ? '접기' : `${hits.length - SEARCH_HITS_PER_SESSION}개 더`}
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : (
            <div className="work-session-list">
              {sessionRows.map(({ link, title, agentRuntime, cardCount: sessionCardCount, archived, cardsMissingAt, startedAt, projectDir }) => (
                <div
                  className={[
                    'work-session-item',
                    'work-session-item--open',
                    // The role tints the whole row (background + left edge), not
                    // just the chip: a list of 개발 / 리뷰 / 디버그 rows should
                    // read as bands at a glance.
                    link.role ? `work-session-item--role-${link.role}` : '',
                    cardsMissingAt ? 'work-session-item--missing' : '',
                  ].filter(Boolean).join(' ')}
                  key={link.sessionId}
                  role="button"
                  tabIndex={0}
                  title="눌러서 대화 보기"
                  onClick={() => onOpenSession(link.sessionId)}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onOpenSession(link.sessionId);
                    }
                  }}
                >
                  {link.role && (
                    <span className={`kv2-badge works-role works-role--${link.role}`}>
                      {ROLE_LABELS[link.role]}
                    </span>
                  )}
                  <div className="work-session-body">
                    <div className="work-session-head">
                      <div className="work-session-title">{title}</div>
                      {/* Copying the id must not open the conversation. */}
                      <span className="work-session-id" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                        <IdChip id={link.sessionId} kind="session" />
                      </span>
                    </div>
                    <div className="work-session-meta">
                      {/* Project first and in its board colour — in a Work that
                          spans repos it is what tells two rows apart. Then the
                          board's own runtime chip, then date and count. */}
                      {projectDir && (
                        <span
                          className={`works-dir-chip kv2-project-chip work-session-project ${dirAccentClass(projectDir)}`.trim()}
                          title={projectDir}
                        >
                          {projectDirLabel(projectDir)}
                        </span>
                      )}
                      {agentRuntime && <RuntimeBadge runtime={agentRuntime} />}
                      <span title={startedAt ? '이 세션의 첫 카드가 만들어진 날' : 'Work에 연결된 날'}>
                        {formatShortDate(startedAt ?? link.linkedAt)}
                        {startedAt ? '' : ' 연결'}
                      </span>
                      {` · 카드 ${sessionCardCount}`}
                      {archived ? ' · 보관됨' : ''}
                    </div>
                    {cardsMissingAt && (
                      <div className="work-session-missing">
                        ⚠ 카드가 하나도 남아 있지 않습니다 — 이 링크는 Work의 시작일을 연결 시각으로
                        끌어내립니다. 아래 <b>끊긴 세션 정리</b>로 제거하세요.
                      </div>
                    )}
                  </div>
                  {sessionActions && (
                    // The menu (and its portal items, which bubble through the
                    // React tree) must not also open the conversation.
                    <span className="work-session-actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
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
                    </span>
                  )}
                  <span className="work-session-go" aria-hidden="true">›</span>
                </div>
              ))}
            </div>
          )}
          {!isResolved && onAddSession && <WorkSessionPicker sessions={assignableSessions} onAdd={onAddSession} />}
        </section>

        {/* ── 속성 (directory + dates) — settings, not what the Work is about,
            so one folded line under the content: `▸ 속성 · zadar · 시작 10/22 ·
            예정 없음`. Opening it shows the editable tiles — DIRECTORY (the card
            detail's click-to-edit tile → DirectoryPicker) beside Start and the
            (planned) end. A live directory draft or a date error keeps it open
            so neither is hidden mid-edit. Last activity is not repeated: the
            facts line under the title already carries it. */}
        <section className={`work-props${propsExpanded ? ' is-open' : ''}`} aria-label="속성">
          <button
            type="button"
            className="work-props-head"
            aria-expanded={propsExpanded}
            aria-controls={`work-${work.id}-props`}
            onClick={() => {
              if (propsExpanded) {
                setDraft('projectDir', null);
                setDateError(null);
              }
              setPropsOpen(!propsExpanded);
            }}
          >
            <span className="work-props-caret" aria-hidden="true">▸</span>
            <b className="work-props-title">속성</b>
            <span className="work-props-sum">
              {work.projectDir ? (
                <span className={`works-dir-chip kv2-project-chip ${dirAccentClass(work.projectDir)}`} title={work.projectDir}>
                  {projectDirLabel(work.projectDir)}
                </span>
              ) : <span className="work-props-muted">디렉토리 없음</span>}
              <span>· 시작 <b>{formatShortDate(work.startedAt)}</b></span>
              <span>
                · {isOpenWork ? '예정' : '종료'}{' '}
                {work.resolvedAt ? <b>{formatShortDate(work.resolvedAt)}</b> : <span className="work-props-muted">없음</span>}
              </span>
            </span>
            <span className="work-props-action">{propsExpanded ? '접기' : '편집'}</span>
          </button>
          {propsExpanded && <div className="kv2-detail-overview work-detail-overview" id={`work-${work.id}-props`}>
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
            </div>
            {dateError && <p className="work-date-error">⚠ {dateError}</p>}
          </div>}
        </section>

        {work.archivedAt && <WorkWikiArchive
          docPaths={[...new Set([...(detail?.wikiDocPaths ?? []), ...(work.wikiDocPath ? [work.wikiDocPath] : [])])]}
          pending={detail?.wikiPending ?? false}
          loading={detailLoading}
          error={detailError}
          onOpenDoc={setOpenWikiDoc}
        />}
        {pruneError && <p className="work-date-error work-detail-inline-error">⚠ {pruneError}</p>}

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
              {/* What 완료 does, said beside the button that does it — it used
                  to be a green box above the footer. */}
              {!isResolved && (
                <span className="work-detail-footer-hint">
                  완료하면 카드 {cardTotal}장을 보관하고 Wiki 문서를 만듭니다
                </span>
              )}
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
