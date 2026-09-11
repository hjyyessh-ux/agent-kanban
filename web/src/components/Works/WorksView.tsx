import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  Work,
  WorkListEntry,
  WorkIgnoredSession,
  WorkInboxSession,
  WorkListSort,
  WorkSessionRole,
  WorksConfigDto,
  WorksConfigInput,
} from '../../../../src/core/types';
import { selectWorks, workProjectDirs } from '../../../../src/core/work-list';
import { ErrorAlert } from '../shared/ErrorAlert';
import type { UiAlert } from '../../hooks/uiAlert';
import type { BulkAssignResult, UseWorksResult, WorkResolveOutcome } from '../../hooks/useWorks';
import { WorkAssignInline } from './WorkAssignInline';
import { DirChip } from './WorkAffinityMarks';
import { chainedWorkIds } from './worksAffinity';
import { WorksConfigPanel } from './WorksConfigPanel';
import {
  noticeForDiscardedSession,
  noticeForLinkedSessions,
  noticeForNewWork,
  type WorkAssignUndoActions,
} from './workAssignNotice';
import { WorkResolveConfirmDialog } from './WorkResolveConfirmDialog';
import {
  STALE_WORK_DAYS,
  OLD_SESSION_DAYS,
  WORK_LIST_SORT_LABELS,
  daysSince,
  describeSessionState,
  describeWorkPlanOverrun,
  formatShortDate,
  formatTimeAgo,
  mergeSessionsForAssign,
  projectDirLabel,
  rowIndexAtPointer,
  sessionIdsBetween,
  shortSessionId,
  summarizeRoles,
  type InboxRowExtent,
} from './worksAssign';
import './Works.css';

export interface WorksViewProps {
  works: WorkListEntry[];
  inbox: WorkInboxSession[];
  loading: boolean;
  error: UiAlert | null;
  onCreateWorkFromSession: (
    session: WorkInboxSession,
    title: string,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  onLinkSessionToWork: (
    workId: string,
    session: WorkInboxSession,
    role?: WorkSessionRole,
  ) => Promise<Work>;
  /** Link a whole Inbox selection onto one existing Work. */
  onAssignSessionsToWork: UseWorksResult['assignSessionsToWork'];
  /** Create one Work for a whole Inbox selection. */
  onCreateWorkFromSessions: UseWorksResult['createWorkFromSessions'];
  onIgnoreSession: (sessionId: string) => Promise<void>;
  /** The ignore list behind the Inbox header's "무시한 세션 N개" link. */
  ignoredSessions?: WorkIgnoredSession[];
  /** Take a session off the ignore list — omit to hide the restore list. */
  onRestoreIgnoredSession?: (sessionId: string) => Promise<void>;
  /** Undo toasts for 연결 / 폐기 (owned by `App`); omit to act without them. */
  assignNotice?: WorkAssignUndoActions;
  /**
   * Complete a Work. Only ever called with the confirmation obtained, because
   * the list row routes through `WorkResolveConfirmDialog` first — a bare click
   * used to run the bulk archive outright.
   */
  onCompleteWork: (workId: string, options?: { confirmed?: boolean }) => Promise<WorkResolveOutcome>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
  /** Open the source card's conversation ("대화 보기"). */
  onOpenCard?: (cardId: string) => void;
  /** Open the Work detail dialog (card 3/7 — undefined disables the button). */
  onOpenWork?: (work: Work) => void;
  /** Open the assign-all modal (card 3/7 — undefined disables the button). */
  /**
   * Opens the 모두 배정하기 modal. Required: App has always passed it, so the
   * optional-prop fallback ("일괄 배정 모달은 준비 중입니다") was a tooltip on a
   * button that was never disabled for that reason.
   */
  onAssignAll: () => void;
  /** Works settings for the ⚙ panel + stale threshold (null hides the gear). */
  config?: WorksConfigDto | null;
  /** Persist a works settings update (from the ⚙ panel). */
  onSaveConfig?: (input: WorksConfigInput) => Promise<void>;
}

/**
 * Pointer travel before a press on an Inbox row becomes a drag-select. Without
 * it every plain click would select the row under the cursor.
 */
const DRAG_SELECT_THRESHOLD_PX = 4;

/** One Inbox row + its inline assignment panel when expanded. */
function InboxRow({
  session,
  works,
  expanded,
  onToggle,
  selectionMode,
  selected,
  onToggleSelect,
  registerRow,
  suggestSessionChain,
  preferSameDir,
  assignFailure,
  onCreateWorkFromSession,
  onLinkSessionToWork,
  onIgnoreSession,
  onOpenCard,
}: {
  session: WorkInboxSession;
  works: WorkListEntry[];
  expanded: boolean;
  onToggle: () => void;
  /** Checkboxes are only rendered once a selection exists (or was requested). */
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  /** Publishes the row element so a drag can measure its vertical extent. */
  registerRow: (sessionId: string, node: HTMLElement | null) => void;
  /** `works.assign_suggest_resume_chain` — off means no 🔗 marks, no reorder. */
  suggestSessionChain: boolean;
  /** `works.assign_prefer_same_dir` — off means same-directory Works stop ranking first. */
  preferSameDir: boolean;
  /** Why the last batch assignment skipped this row, if it did. */
  assignFailure?: string;
  onCreateWorkFromSession: WorksViewProps['onCreateWorkFromSession'];
  onLinkSessionToWork: WorksViewProps['onLinkSessionToWork'];
  onIgnoreSession: WorksViewProps['onIgnoreSession'];
  onOpenCard?: (cardId: string) => void;
}) {
  const isOld = daysSince(session.updatedAt) >= OLD_SESSION_DAYS;
  const title = session.sessionTitle?.trim() || session.cardTitle;
  const chained = useMemo(
    () => (suggestSessionChain ? chainedWorkIds(session, works) : undefined),
    [session, works, suggestSessionChain],
  );
  const state = describeSessionState(session);
  // Lineage on the *row*, not only inside the opened panel: whether a session
  // continues another one is what decides which rows get triaged together, and
  // it used to be invisible until 배정 was already pressed. The count is Works
  // that already hold one of those sessions when there are any — that is the
  // actionable form — and the bare lineage otherwise.
  const chainedCount = chained?.size ?? 0;
  const lineageCount = session.relatedSessionIds?.length ?? 0;
  const chainMark = !suggestSessionChain
    ? null
    : chainedCount > 0
      ? {
        label: `🔗 이어진 Work ${chainedCount}`,
        title: '이 세션의 계보에 있는 세션을 이미 가진 Work가 있습니다',
      }
      : lineageCount > 0
        ? {
          label: `🔗 이어진 세션 ${lineageCount}`,
          title: '이 세션은 다른 세션에서 이어졌습니다 (subagent 부모 / 큐 체인 / 이어받은 세션)',
        }
        : null;

  // In selection mode the whole row is a toggle, so clicking a session that is
  // already checked unchecks it. The row's own buttons keep their behaviour.
  const handleRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!selectionMode) return;
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    onToggleSelect();
  };

  // The clickable row needs to be operable without a pointer: in selection mode
  // it is a toggle button (`role`/`tabIndex`/`aria-pressed` below), so Enter and
  // Space have to do what a click does. The checkbox keeps its own Space.
  const handleRowKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    event.preventDefault();
    onToggleSelect();
  };

  return (
    <div className="works-inbox-row-group">
      <div
        className={`works-inbox-row${selectionMode ? ' works-inbox-row--selectable' : ''}${selected ? ' is-selected' : ''}`}
        ref={(node) => registerRow(session.sessionId, node)}
        onClick={handleRowClick}
        role={selectionMode ? 'button' : undefined}
        tabIndex={selectionMode ? 0 : undefined}
        aria-pressed={selectionMode ? selected : undefined}
        onKeyDown={selectionMode ? handleRowKeyDown : undefined}
      >
        {selectionMode && (
          <input
            type="checkbox"
            className="works-inbox-check"
            checked={selected}
            aria-label={`${title} 선택`}
            onChange={onToggleSelect}
          />
        )}
        <span className={`works-inbox-dot${isOld ? ' works-inbox-dot--idle' : ''}`} />
        <div className="works-inbox-body">
          <div className="works-inbox-title">{title}</div>
          <div className="works-inbox-meta">
            {state && (
              <span className={`kv2-badge works-inbox-state works-inbox-state--${state.tone}`}>
                {state.label}
              </span>
            )}
            {chainMark && (
              <span className="works-chain-mark works-inbox-chain" title={chainMark.title}>
                {chainMark.label}
              </span>
            )}
            <span className="kv2-badge works-runtime-chip">{session.agentRuntime}</span>
            <DirChip projectDir={session.projectDir} />
            <span className="works-mono">{shortSessionId(session.sessionId)}</span>
            <span>
              카드 {session.relatedCardCount} · {formatTimeAgo(session.updatedAt)}
              {isOld && <b className="works-warn"> ⚠ 오래됨</b>}
            </span>
          </div>
          {/* A batch assignment links one session per request, so a partial
              failure is normal — and the shared banner can only carry the first
              reason. The row that actually failed says so itself. */}
          {assignFailure && (
            <div className="works-inbox-failure" role="alert">
              ⚠ 배정 실패 — {assignFailure}
            </div>
          )}
        </div>
        {/* Hidden while selecting: in selection mode the row *is* a toggle, and
            three per-row actions next to it both invited the wrong click and
            put button surface in the way of the range drag. The batch panel
            below the list owns the actions for a selection. */}
        {!selectionMode && (
          <div className="works-inbox-actions">
            <button
              type="button"
              className={`kv2-btn kv2-btn--small${expanded ? '' : ' kv2-btn--primary'}`}
              aria-expanded={expanded}
              onClick={onToggle}
            >
              {expanded ? '접기 ▲' : '배정'}
            </button>
            {onOpenCard && (
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--ghost"
                onClick={() => onOpenCard(session.cardId)}
              >
                대화 보기
              </button>
            )}
            {!expanded && (
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--subtle-danger"
                // The hook reports the failure through the shared Works error
                // alert and rethrows; swallowing here keeps a failed 폐기 from
                // becoming an unhandled rejection.
                onClick={() => { void onIgnoreSession(session.sessionId).catch(() => {}); }}
              >
                폐기
              </button>
            )}
          </div>
        )}
      </div>
      {expanded && !selectionMode && (
        <WorkAssignInline
          session={session}
          works={works}
          chained={chained}
          preferSameDir={preferSameDir}
          onCancel={onToggle}
          onCreateWork={async (title, role) => {
            await onCreateWorkFromSession(session, title, role);
          }}
          onLinkToWork={async (workId, role) => {
            await onLinkSessionToWork(workId, session, role);
          }}
          secondary={{
            label: '이 세션 무시 (Work 없이 보관)',
            run: async () => {
              await onIgnoreSession(session.sessionId);
            },
          }}
        />
      )}
    </div>
  );
}

/**
 * The restore list behind the Inbox header's `🗑 무시한 세션 N개`.
 *
 * 폐기 is one click on an Inbox row and one keystroke in the assign-all modal,
 * and until this list existed it was also permanent: `ignoredSessionIds` was
 * append-only with no read route, so a session dropped out of the Inbox, the
 * Works tab badge and the Timeline's assign button with `works.json` as the only
 * way to find or undo it.
 *
 * A row whose restore would not actually bring it back into the Inbox (no cards
 * left, or past the Inbox's `since` window) says so rather than looking broken
 * after the click — the server computes that with the Inbox's own predicate.
 */
function IgnoredSessionsPanel({
  sessions,
  onRestore,
}: {
  sessions: WorkIgnoredSession[];
  onRestore: (sessionId: string) => Promise<void>;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const restore = (sessionId: string) => {
    setBusyId(sessionId);
    // The hook reports failures through the shared Works error alert and
    // rethrows; swallowing keeps a failed restore from becoming an unhandled
    // rejection.
    void onRestore(sessionId)
      .catch(() => {})
      .finally(() => setBusyId(null));
  };

  return (
    <div className="works-ignored">
      <div className="works-ignored-lead">
        폐기한 세션입니다. 복원하면 다시 Inbox에서 배정할 수 있습니다.
      </div>
      {sessions.length === 0 ? (
        <p className="works-empty">무시한 세션이 없습니다.</p>
      ) : (
        <ul className="works-ignored-list">
          {sessions.map((entry) => {
            const summary = entry.session;
            const title = summary?.sessionTitle?.trim()
              || summary?.cardTitle
              || shortSessionId(entry.sessionId);
            return (
              <li key={entry.sessionId} className="works-ignored-row">
                <div className="works-ignored-body">
                  <div className="works-ignored-title">{title}</div>
                  <div className="works-inbox-meta">
                    {summary && (
                      <>
                        <span className="kv2-badge works-runtime-chip">{summary.agentRuntime}</span>
                        <DirChip projectDir={summary.projectDir} />
                      </>
                    )}
                    <span className="works-mono">{shortSessionId(entry.sessionId)}</span>
                    {summary && (
                      <span>
                        카드 {summary.relatedCardCount} · {formatTimeAgo(summary.updatedAt)}
                      </span>
                    )}
                    {!entry.returnsToInbox && (
                      <span className="works-warn">
                        ⚠ 복원해도 Inbox에는 나타나지 않습니다 (카드 없음 또는 기간 초과)
                      </span>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--small kv2-btn--outline"
                  disabled={busyId === entry.sessionId}
                  onClick={() => restore(entry.sessionId)}
                >
                  {busyId === entry.sessionId ? '복원 중…' : '복원'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * How a resolved Work's end reads in the meta line. A merge source is
 * `discarded`, but calling it 폐기 hides the fact that its sessions were folded
 * into another Work rather than abandoned.
 */
function resolvedWordFor(work: Work): string {
  if (work.resolution === 'superseded') return '병합';
  return work.status === 'discarded' ? '폐기' : '완료';
}

/** One Work card in the Active or Resolved list. */
function WorkListCard({
  work,
  onRequestComplete,
  onOpenWork,
  staleDays,
}: {
  work: WorkListEntry;
  /** Opens the confirmation dialog; the row never mutates anything directly. */
  onRequestComplete: (work: Work) => void;
  onOpenWork?: (work: Work) => void;
  staleDays: number;
}) {
  const resolved = work.status !== 'active';
  const sessionCount = work.sessionLinks.length;
  const roleSummary = summarizeRoles(work);
  const stale = !resolved && daysSince(work.activity?.lastActivityAt ?? work.updatedAt) >= staleDays;
  const summaryLines = work.summary?.lines ?? [];
  // An `active` Work past its planned end. `stale` (nothing has happened for N
  // days) is a different complaint and both can be true at once, so they are
  // separate marks rather than one merged warning.
  const overrun = describeWorkPlanOverrun(work);
  // A merge source. Without this the row read "폐기" — the same word as a Work
  // someone gave up on — with no hint that its sessions live on elsewhere.
  const superseded = work.resolution === 'superseded';

  return (
    <div className={`works-card works-card--${work.status}${resolved ? ' works-card--resolved' : ''}${overrun ? ' works-card--overrun' : ''}`}>
      {onOpenWork && (
        <button
          type="button"
          className="works-card-open"
          aria-label={`${work.title} 상세 열기`}
          onClick={() => onOpenWork(work)}
        />
      )}
      <div className="works-card-body">
        <div className="works-card-title">{work.title}</div>
        <div className="works-card-meta">
          <DirChip projectDir={work.projectDir} />
          <span>
            세션 {sessionCount}
            {roleSummary && ` (${roleSummary})`}
          </span>
          <span>
            {resolved && work.resolvedAt
              ? `${formatShortDate(work.startedAt)} → ${formatShortDate(work.resolvedAt)} ${resolvedWordFor(work)}`
              : `시작 ${formatShortDate(work.startedAt)}`}
          </span>
          {overrun && <span className="kv2-badge work-overrun-chip">{overrun}</span>}
          {superseded && <span className="kv2-badge works-superseded-chip">병합됨</span>}
          {work.activity && <span>카드 {work.activity.cardCount} · 진행 {work.activity.inProgressCount} · 완료 {work.activity.doneCount}</span>}
          <span>최근 활동 {formatTimeAgo(work.activity?.lastActivityAt ?? work.updatedAt)}</span>
          {stale && <span className="works-warn">⚠ {daysSince(work.activity?.lastActivityAt ?? work.updatedAt)}일간 활동 없음</span>}
        </div>
        {summaryLines.length > 0 && (
          <div className="works-card-summary">{summaryLines.join(' ')}</div>
        )}
      </div>
      {/* No 세션 count badge here: the meta line above already says
          `세션 17 (개발 17)`, and the badge repeated the same number two
          inches to its right. This column is for the row's actions. */}
      <div className="works-card-side">
        {!resolved && (
          <button
            type="button"
            // Ghost, not the green primary it used to be: completing a Work is
            // the most destructive action on this screen, so it must not be the
            // most inviting target on a row people click to open 상세.
            className="kv2-btn kv2-btn--small kv2-btn--ghost works-card-action"
            onClick={() => onRequestComplete(work)}
          >
            완료…
          </button>
        )}
        <button
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--outline works-card-action"
          disabled={!onOpenWork}
          onClick={onOpenWork ? () => onOpenWork(work) : undefined}
        >
          상세
        </button>
      </div>
    </div>
  );
}

/** Active Works and Inbox assignment share the primary workspace. */
export function WorksView({
  works,
  inbox,
  loading,
  error,
  onCreateWorkFromSession,
  onLinkSessionToWork,
  onAssignSessionsToWork,
  onCreateWorkFromSessions,
  onIgnoreSession,
  ignoredSessions,
  onRestoreIgnoredSession,
  assignNotice,
  onCompleteWork,
  onRefresh,
  onClearError,
  onOpenCard,
  onOpenWork,
  onAssignAll,
  config,
  onSaveConfig,
}: WorksViewProps) {
  const [expandedSessionId, setExpandedSessionId] = useState<string | null>(null);
  const [showConfig, setShowConfig] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [section, setSection] = useState<'active' | 'resolved'>('active');
  // The Work whose completion is awaiting confirmation. One instance for the
  // whole list: the row button only names a target, it never mutates.
  const [completing, setCompleting] = useState<Work | null>(null);

  // ── Inbox multi-select ──
  // Selection mode turns itself on the moment a drag picks anything up; the
  // header toggle exists so the same batch flow is reachable without a pointer.
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [selecting, setSelecting] = useState(false);
  const [bulkPanelOpen, setBulkPanelOpen] = useState(false);
  // Only used to suppress text selection while sweeping: the checkboxes and the
  // row tint already trace the exact range, so there is no rubber band to draw.
  const [dragging, setDragging] = useState(false);
  // Per-row reasons from the last batch assignment. The shared error banner has
  // room for one sentence ("외 N개 세션도 실패"), which never said *which* rows.
  const [assignFailures, setAssignFailures] = useState<ReadonlyMap<string, string>>(
    () => new Map(),
  );

  const listRef = useRef<HTMLDivElement | null>(null);
  const rowNodes = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{
    /** Viewport Y of the press — the movement threshold survives a layout shift. */
    startClientY: number;
    /** Anchor row by id, so a poll re-ordering the Inbox cannot move the anchor. */
    startSessionId: string;
    base: string[];
    moved: boolean;
  } | null>(null);

  const registerRow = useCallback((sessionId: string, node: HTMLElement | null) => {
    if (node) rowNodes.current.set(sessionId, node);
    else rowNodes.current.delete(sessionId);
  }, []);

  // Polling drops sessions out of the Inbox as they get assigned elsewhere —
  // a selection must never keep pointing at a session that is no longer there.
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const live = new Set(inbox.map((session) => session.sessionId));
      const next = new Set([...current].filter((id) => live.has(id)));
      if (next.size === current.size) return current;
      // Pruning to empty must also put the batch panel away. It used to stay
      // `bulkPanelOpen`, so the next row the user checked re-opened an assign
      // panel they never asked for — and it was seeded from that one row.
      if (next.size === 0) setBulkPanelOpen(false);
      return next;
    });
  }, [inbox]);

  const selectedSessions = useMemo(
    () => inbox.filter((session) => selectedIds.has(session.sessionId)),
    [inbox, selectedIds],
  );
  const bulkTarget = useMemo(() => mergeSessionsForAssign(selectedSessions), [selectedSessions]);
  const selectionMode = selecting || selectedIds.size > 0;
  const bulkChained = useMemo(
    () => (bulkTarget && (config?.assignSuggestResumeChain ?? true)
      ? chainedWorkIds(bulkTarget, works)
      : undefined),
    [bulkTarget, works, config?.assignSuggestResumeChain],
  );
  const showBulkPanel = bulkPanelOpen && bulkTarget !== null;

  // Entering selection mode retires the single-row panel: the row's actions are
  // hidden while selecting, so an open panel would be the one piece of the row
  // UI left pointing at a single session mid-batch.
  useEffect(() => {
    if (selectionMode) setExpandedSessionId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionMode]);

  // The batch panel has to render *below* the rows (see the drag notes), so on
  // an Inbox longer than the viewport it opened outside it. `nearest` scrolls
  // only as far as it has to, leaving the selected rows on screen where they
  // are the context for the choice.
  const bulkPanelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (showBulkPanel) bulkPanelRef.current?.scrollIntoView({ block: 'nearest' });
  }, [showBulkPanel]);

  const clearSelection = () => {
    setSelectedIds(new Set());
    setSelecting(false);
    setBulkPanelOpen(false);
    setAssignFailures(new Map());
  };

  // ── single-session assignment, with an undo ──
  // Wrapped here rather than inside `InboxRow` so the row keeps taking the
  // hook's mutations verbatim, and so the modal (`BulkAssignModal`) and this
  // panel build the same notice from the same helpers.
  const createWorkFromSession: WorksViewProps['onCreateWorkFromSession'] = async (
    session, title, role,
  ) => {
    const work = await onCreateWorkFromSession(session, title, role);
    if (assignNotice) assignNotice.notify(noticeForNewWork(work, 1, assignNotice));
    return work;
  };

  const linkSessionToWork: WorksViewProps['onLinkSessionToWork'] = async (
    workId, session, role,
  ) => {
    const work = await onLinkSessionToWork(workId, session, role);
    if (assignNotice) {
      assignNotice.notify(noticeForLinkedSessions(work, [session.sessionId], assignNotice));
    }
    return work;
  };

  const ignoreSession = async (sessionId: string): Promise<void> => {
    // Read the row *before* awaiting: the hook refreshes the Inbox as part of
    // the ignore, so by the time it resolves this session is no longer in it.
    const session = inbox.find((entry) => entry.sessionId === sessionId);
    await onIgnoreSession(sessionId);
    if (assignNotice && session) {
      assignNotice.notify(noticeForDiscardedSession(session, assignNotice));
    }
  };

  const toggleSelect = (sessionId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  /**
   * Row extents in current list coordinates, in Inbox order. Re-measured on
   * every pointer move rather than cached at the press, so the drag stays
   * correct even if the list reflows underneath it.
   */
  const measureRows = (container: HTMLElement): { containerTop: number; rows: InboxRowExtent[] } => {
    const containerTop = container.getBoundingClientRect().top;
    const rows: InboxRowExtent[] = [];
    for (const session of inbox) {
      const node = rowNodes.current.get(session.sessionId);
      if (!node) continue;
      const rect = node.getBoundingClientRect();
      rows.push({
        sessionId: session.sessionId,
        top: rect.top - containerTop,
        bottom: rect.bottom - containerTop,
      });
    }
    return { containerTop, rows };
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Touch drags belong to the scroller, and the row's own controls keep their
    // clicks — a drag-select only starts on empty row surface.
    if (event.button !== 0 || event.pointerType === 'touch') return;
    if ((event.target as HTMLElement).closest('button, a, input, select, textarea, .works-assign-inline')) return;
    const container = listRef.current;
    if (!container) return;

    const { containerTop, rows } = measureRows(container);
    const anchor = rows[rowIndexAtPointer(event.clientY - containerTop, rows)];
    if (!anchor) return;
    // Capture is taken on the first real move, not here: a captured pointer
    // also redirects the compatibility mouse events, so capturing on press
    // would send the click to this container and the row would never see the
    // click that toggles it.
    dragRef.current = {
      startClientY: event.clientY,
      startSessionId: anchor.sessionId,
      base: [...selectedIds],
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const container = listRef.current;
    if (!drag || !container) return;
    // Below the threshold this is still a click, not a drag — otherwise every
    // press on a row would select it.
    if (!drag.moved && Math.abs(event.clientY - drag.startClientY) < DRAG_SELECT_THRESHOLD_PX) return;
    if (!drag.moved) {
      drag.moved = true;
      // From here the gesture is a drag: capture keeps it tracked even when the
      // pointer leaves the list, and it swallows the trailing click so a sweep
      // does not also toggle the row it ended on.
      container.setPointerCapture(event.pointerId);
      setDragging(true);
    }

    const { containerTop, rows } = measureRows(container);
    const fromIndex = rows.findIndex((row) => row.sessionId === drag.startSessionId);
    if (fromIndex < 0) return;
    const toIndex = rowIndexAtPointer(event.clientY - containerTop, rows);

    // Additive: a second sweep extends the batch instead of replacing it, and
    // individual mistakes are corrected by clicking the row (or 선택 해제).
    setSelectedIds(new Set([...drag.base, ...sessionIdsBetween(rows, fromIndex, toIndex)]));
  };

  // Both `pointerup` and `lostpointercapture` end the gesture: a press that
  // never passed the threshold never captured, so it only has the former. This
  // is safe to hear twice — unlike the Timeline's bar drag, nothing is
  // committed here at the end; the selection is already applied per move.
  const handleDragEnd = () => {
    dragRef.current = null;
    setDragging(false);
  };

  /**
   * A bulk assignment that partly failed keeps exactly the sessions that did
   * not link selected — they are still in the Inbox, and the shared error alert
   * already says why — so the retry is one more click on the same panel.
   */
  const settleBulkAssign = (result: BulkAssignResult, sessionIds: string[]) => {
    const failedIds = new Set(result.failed.map((failure) => failure.sessionId));
    if (result.work && result.assigned > 0 && assignNotice) {
      assignNotice.notify(noticeForLinkedSessions(
        result.work,
        sessionIds.filter((id) => !failedIds.has(id)),
        assignNotice,
      ));
    }
    if (result.failed.length === 0) {
      clearSelection();
      return;
    }
    // Each failure is named on its own row; the banner only carries the first
    // reason, so "외 N개 세션도 실패" used to be all the user got.
    setAssignFailures(new Map(result.failed.map((f) => [f.sessionId, f.message])));
    setSelectedIds(failedIds);
  };

  const handleBulkCreateWork = async (title: string, role?: WorkSessionRole) => {
    if (!bulkTarget) return;
    const sessionIds = selectedSessions.map((session) => session.sessionId);
    setAssignFailures(new Map());
    try {
      const result = await onCreateWorkFromSessions({
        sessions: selectedSessions,
        title,
        role,
        projectDir: bulkTarget.projectDir,
      });
      // A brand-new Work: the undo is deleting it again, which releases every
      // session it just took — not N unlinks.
      const failedIds = new Set(result.failed.map((failure) => failure.sessionId));
      if (result.work && assignNotice) {
        assignNotice.notify(noticeForNewWork(
          result.work,
          sessionIds.length - failedIds.size,
          assignNotice,
        ));
      }
      if (result.failed.length === 0) clearSelection();
      else {
        setAssignFailures(new Map(result.failed.map((f) => [f.sessionId, f.message])));
        setSelectedIds(failedIds);
      }
    } catch {
      // The hook reported the reason through the shared error alert; the
      // selection stays put so the batch can be retried.
    }
  };

  const handleBulkLinkToWork = async (workId: string, role?: WorkSessionRole) => {
    const sessionIds = selectedSessions.map((session) => session.sessionId);
    setAssignFailures(new Map());
    try {
      settleBulkAssign(await onAssignSessionsToWork(workId, selectedSessions, role), sessionIds);
    } catch {
      // Same as above — errors surface in the banner, selection is preserved.
    }
  };

  /**
   * Active-list narrowing.
   *
   * The list was `updatedAt` descending, full stop — which is the wrong order
   * for the question it is usually asked. A Work nobody has touched for three
   * weeks sank to the bottom, i.e. to where it was already invisible, and with
   * a dozen Works across several repos there was no way to ask for one by name.
   *
   * Narrowing happens client-side even though `GET /api/works?q=&sort=` exists:
   * the Works poll fetches the *whole* list because the Timeline, the assign
   * recommendations and the move dialog all need every Work, so the request
   * cannot be narrowed without breaking them. `selectWorks` is the same
   * function the route applies, so both sides agree.
   */
  const [activeQuery, setActiveQuery] = useState('');
  const [activeDir, setActiveDir] = useState('');
  const [activeSort, setActiveSort] = useState<WorkListSort>('updated');
  const activeDirs = useMemo(
    () => workProjectDirs(works),
    [works],
  );
  const activeTotal = works.filter((work) => section === 'resolved' ? work.status !== 'active' : work.status === 'active').length;
  const activeWorks = useMemo(
    () => selectWorks(works.filter(work => section === 'resolved' ? work.status !== 'active' : work.status === 'active'), {
      q: activeQuery,
      projectDir: activeDir || undefined,
      sort: activeSort,
    }),
    [works, section, activeQuery, activeDir, activeSort],
  );
  const activeFiltered = activeWorks.length !== activeTotal;
  const staleDays = config?.staleDays ?? STALE_WORK_DAYS;
  const suggestSessionChain = config?.assignSuggestResumeChain ?? true;
  // Both assignment settings default to `true` before the config lands, which is
  // what `works-config.ts` documents as their default.
  const preferSameDir = config?.assignPreferSameDir ?? true;
  const canConfig = !!config && !!onSaveConfig;
  const ignoredCount = ignoredSessions?.length ?? 0;
  const canRestore = !!onRestoreIgnoredSession;

  return (
    <div className="works-view">
      <div className="works-view-header">
        <span className="works-view-title">Works</span>
        {canConfig && (
          <button
            type="button"
            className={`kv2-btn kv2-btn--small kv2-btn--ghost works-config-gear${showConfig ? ' works-config-gear--on' : ''}`}
            aria-label="Works 설정"
            aria-expanded={showConfig}
            onClick={() => setShowConfig((v) => !v)}
          >
            ⚙ 설정
          </button>
        )}
      </div>

      <p className="kv2-session-helper">미배정 세션을 하나의 목표로 묶고, 진행 중인 Work를 관리하세요.</p>
      <div className="works-navigation" role="group" aria-label="Work 목록 보기">
        {(['active', 'resolved'] as const).map(value => (
          <button key={value} type="button" aria-pressed={section === value}
            className={`kv2-btn${section === value ? ' kv2-btn--primary' : ' kv2-btn--ghost'}`}
            onClick={() => setSection(value)}>
            {value === 'active' ? `진행 중 ${works.filter(w => w.status === 'active').length}`
              : `완료·폐기 ${works.filter(w => w.status !== 'active').length}`}
          </button>
        ))}
      </div>

      {showConfig && config && onSaveConfig && (
        <WorksConfigPanel config={config} busy={loading} onSave={onSaveConfig} />
      )}

      {error && (
        <ErrorAlert
          className="error-banner"
          title={error.title}
          message={error.message}
          actionLabel={error.actionLabel}
          onAction={() => {
            void onRefresh();
          }}
          onDismiss={onClearError}
        />
      )}

      {loading && works.length === 0 && inbox.length === 0 ? (
        <div className="loading-spinner" role="status" aria-label="Loading works..." />
      ) : (
        <div className={section === 'active' ? 'works-active-layout' : undefined}>
          {/* The section also renders with an empty Inbox when something is on
              the ignore list: the restore list is reached from this header, and
              hiding the header would make a discarded session unrecoverable
              exactly when the Inbox is finally clean. */}
          {section === 'active' && (
            <section className="works-section works-triage-section" aria-label="미배정 세션">
              <div className="works-section-heading">
                <span>📥 미배정 세션</span>
                <span className="works-section-hint">함께 진행한 세션만 선택해 Work로 묶으세요</span>
                <span className="works-section-rule" />
              </div>
              <div className="works-inbox">
                <div className="works-inbox-header">
                  <span>미배정 세션 {inbox.length}개</span>
                  <span className="works-inbox-header-sub">
                    · 최근 활동순 · 드래그하면 여러 개 선택
                  </span>
                  {ignoredCount > 0 && canRestore && (
                    <button
                      type="button"
                      className={`kv2-btn kv2-btn--small works-inbox-ignored-toggle${showIgnored ? ' kv2-btn--outline' : ' kv2-btn--ghost'}`}
                      aria-expanded={showIgnored}
                      onClick={() => setShowIgnored((v) => !v)}
                    >
                      🗑 무시한 세션 {ignoredCount}개
                    </button>
                  )}
                  <button
                    type="button"
                    className={`kv2-btn kv2-btn--small works-inbox-select-toggle${selectionMode ? ' kv2-btn--outline' : ' kv2-btn--ghost'}`}
                    aria-pressed={selectionMode}
                    disabled={inbox.length === 0}
                    onClick={() => (selectionMode ? clearSelection() : setSelecting(true))}
                  >
                    {selectionMode ? '☑ 선택 끝내기' : '☑ 선택'}
                  </button>
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--small kv2-btn--primary"
                    disabled={inbox.length === 0}
                    onClick={onAssignAll}
                  >
                    ⚡ 모두 배정하기
                  </button>
                </div>

                {showIgnored && onRestoreIgnoredSession && (
                  <IgnoredSessionsPanel
                    sessions={ignoredSessions ?? []}
                    onRestore={onRestoreIgnoredSession}
                  />
                )}

                {inbox.length === 0 && (
                  <p className="works-empty">
                    미배정 세션이 없습니다. 무시한 세션을 되살리려면 위 목록에서 복원하세요.
                  </p>
                )}

                <div
                  className={`works-inbox-rows${dragging ? ' is-dragging' : ''}${expandedSessionId ? ' works-inbox-rows--assigning' : ''}`}
                  ref={listRef}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={handleDragEnd}
                  onPointerCancel={handleDragEnd}
                  onLostPointerCapture={handleDragEnd}
                >
                  {inbox.map((session) => (
                    <InboxRow
                      key={session.sessionId}
                      session={session}
                      works={works}
                      expanded={expandedSessionId === session.sessionId}
                      onToggle={() => {
                        setBulkPanelOpen(false);
                        setExpandedSessionId((current) =>
                          current === session.sessionId ? null : session.sessionId,
                        );
                      }}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(session.sessionId)}
                      onToggleSelect={() => toggleSelect(session.sessionId)}
                      registerRow={registerRow}
                      suggestSessionChain={suggestSessionChain}
                      preferSameDir={preferSameDir}
                      assignFailure={assignFailures.get(session.sessionId)}
                      onCreateWorkFromSession={createWorkFromSession}
                      onLinkSessionToWork={linkSessionToWork}
                      onIgnoreSession={ignoreSession}
                      onOpenCard={onOpenCard}
                    />
                  ))}
                </div>
                {selectionMode && (
                  <div className="works-inbox-selection">
                    <span className="works-inbox-selection-count">
                      {selectedIds.size > 0
                        ? `선택 ${selectedIds.size}개`
                        : '세션을 드래그하거나 체크해서 선택하세요'}
                    </span>
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--small kv2-btn--ghost"
                      onClick={() => setSelectedIds(new Set(inbox.map((session) => session.sessionId)))}
                    >
                      전체 선택
                    </button>
                    {/* One meaning of 선택 해제, per docs/works.md: clear the
                        selection *and* put the checkboxes away. It used to only
                        empty the set here while the batch panel's own 선택 해제
                        (same words, same screen) also left selection mode. */}
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--small kv2-btn--ghost"
                      disabled={selectedIds.size === 0}
                      onClick={clearSelection}
                    >
                      선택 해제
                    </button>
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--small kv2-btn--primary"
                      disabled={selectedIds.size === 0}
                      aria-expanded={showBulkPanel}
                      onClick={() => {
                        setBulkPanelOpen((open) => !open);
                        setExpandedSessionId(null);
                      }}
                    >
                      {showBulkPanel ? '접기 ▲' : `배정하기 (${selectedIds.size})`}
                    </button>
                  </div>
                )}

                {/* Scrolled into view when it opens: it renders below the rows
                    (mounting it above would push every row out from under a
                    starting drag), so on a long Inbox the panel the user just
                    asked for opened off-screen. The selection chips are here
                    too — the panel body only shows the representative session,
                    so this is the only place the batch is enumerated. */}
                {showBulkPanel && bulkTarget && (
                  <div className="works-bulk-panel" ref={bulkPanelRef}>
                    <div className="works-bulk-selected">
                      <span className="works-bulk-selected-label">
                        선택한 세션 {selectedSessions.length}개
                      </span>
                      {selectedSessions.map((session) => (
                        <span key={session.sessionId} className="works-bulk-chip">
                          <span className="works-bulk-chip-title">
                            {session.sessionTitle?.trim() || session.cardTitle}
                          </span>
                          <button
                            type="button"
                            className="works-bulk-chip-remove"
                            aria-label={`${session.sessionTitle?.trim() || session.cardTitle} 선택 해제`}
                            onClick={() => toggleSelect(session.sessionId)}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <WorkAssignInline
                      // Keyed on the batch so switching selection re-seeds the
                      // title suggestion and the recommended target.
                      key={selectedSessions.map((session) => session.sessionId).join(',')}
                      session={bulkTarget}
                      works={works}
                      bulk={{ count: selectedSessions.length }}
                      chained={bulkChained}
                      preferSameDir={preferSameDir}
                      onCancel={() => setBulkPanelOpen(false)}
                      onCreateWork={handleBulkCreateWork}
                      onLinkToWork={handleBulkLinkToWork}
                      secondary={{
                        label: '선택 해제',
                        tone: 'neutral',
                        run: async () => {
                          clearSelection();
                        },
                      }}
                    />
                  </div>
                )}
              </div>
            </section>
          )}

          <section className="works-section works-grouped-section">
            <div className="works-section-heading">
              <span>{section === 'resolved' ? '완료·폐기한 작업' : '진행 중인 작업'}</span>
              <span className="works-section-hint">
                {activeFiltered ? `${activeWorks.length} / ${activeTotal}개` : `전체 ${activeTotal}개`}
              </span>
              <span className="works-section-rule" />
            </div>
              <div className="works-active-toolbar">
                <input
                  type="search"
                  className="kv2-input works-active-search"
                  placeholder="Work 검색 (제목·디렉토리·메모·Summary)"
                  value={activeQuery}
                  aria-label="Work 검색"
                  onChange={(e) => setActiveQuery(e.target.value)}
                />
                {activeDirs.length > 1 && (
                  <label className="works-active-filter">
                    <span className="kv2-label">디렉토리</span>
                    <select
                      className="kv2-select"
                      value={activeDir}
                      onChange={(e) => setActiveDir(e.target.value)}
                    >
                      <option value="">전체</option>
                      {activeDirs.map((dir) => (
                        <option key={dir} value={dir}>{projectDirLabel(dir)}</option>
                      ))}
                    </select>
                  </label>
                )}
                <label className="works-active-filter">
                  <span className="kv2-label">정렬</span>
                  <select
                    className="kv2-select"
                    value={activeSort}
                    aria-label="정렬"
                    onChange={(e) => setActiveSort(e.target.value as WorkListSort)}
                  >
                    {WORK_LIST_SORT_LABELS.map(([value, label]) => (
                      <option key={value} value={value}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
            {activeWorks.length === 0 ? (
              <p className="works-empty">
                {activeTotal === 0
                  ? section === 'resolved' ? '완료·폐기한 Work가 없습니다.' : '진행 중인 Work가 없습니다. 미배정 세션을 묶어 시작하세요.'
                  : '검색·필터 조건에 맞는 Work가 없습니다.'}
              </p>
            ) : (
              <div className="works-list">
                {activeWorks.map((work) => (
                  <WorkListCard
                    key={work.id}
                    work={work}
                    onRequestComplete={setCompleting}
                    onOpenWork={onOpenWork}
                    staleDays={staleDays}
                  />
                ))}
              </div>
            )}
          </section>


        </div>
      )}

      {completing && (
        <WorkResolveConfirmDialog
          work={completing}
          mode="complete"
          onCancel={() => setCompleting(null)}
          onConfirm={() => onCompleteWork(completing.id, { confirmed: true })}
          // The list needs nothing on success — the poll (and the optimistic
          // update in `useWorks`) moves the Work into Resolved on its own.
          onResolved={() => {}}
        />
      )}
    </div>
  );
}
