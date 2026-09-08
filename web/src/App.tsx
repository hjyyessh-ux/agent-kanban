import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { BoardFilterBar } from './components/Board/BoardFilterBar';
import { BoardProjectSwitcher } from './components/Board/BoardProjectSwitcher';
import { BoardScreen } from './components/Board/BoardScreen';
import { BoardWorkspace } from './components/Board/BoardWorkspace';
import { groupCompleteCardsBySession } from './components/Board/BoardCompleteSessionView';
import type { CompleteSessionGroup } from './components/Board/BoardCompleteSessionView';
import { SessionConversationModal } from './components/Board/SessionConversationModal';
import { CardDetailDialog } from './components/Card/CardDetailDialog';
import { CreateCardDialog } from './components/Card/CreateCardDialog';
import { SchedulerView } from './components/Scheduler/SchedulerView';
import { SettingsView } from './components/Settings/SettingsView';
import { WorksView } from './components/Works/WorksView';
import { TimelineView } from './components/Works/TimelineView';
import { BulkAssignModal } from './components/Works/BulkAssignModal';
import { WorkDetailDialog } from './components/Works/WorkDetailDialog';
import { WorkSessionNotice, type WorkSessionNoticeState } from './components/Works/WorkSessionNotice';
import type { WorkAssignUndoActions } from './components/Works/workAssignNotice';
import { ErrorAlert } from './components/shared/ErrorAlert';
import { AppTabs, PANEL_IDS, TAB_IDS, type MainTab } from './components/shared/AppTabs';
import { applyCardUpdates } from './utils/cardUpdate';
import { useSettings } from './hooks/useSettings';
import { useKanbanBoard } from './hooks/useKanbanBoard';
import { useScheduler } from './hooks/useScheduler';
import { useWorks } from './hooks/useWorks';
import { useWorkSessions } from './hooks/useWorkSessions';
import { CapabilitiesView } from './components/Capabilities/CapabilitiesView';
import { useScripts } from './hooks/useScripts';
import { useSkills } from './hooks/useSkills';
import { useSkillRoots } from './hooks/useSkillRoots';
import type { KanbanCard, Work, WorkInboxSession } from '../../src/core/types';
import './components/Scheduler/Scheduler.css';
import './components/Settings/Settings.css';
import './App.css';
import { QuestionBanner } from './components/Question/QuestionBanner';
import { useQuestions } from './hooks/useQuestions';
import { useFontScale } from './hooks/useFontScale';
import { useTheme } from './hooks/useTheme';
import './components/Question/Question.css';
import type { QueueSessionMode } from '../../src/core/types';
import { createUiAlert } from './hooks/uiAlert';
import type { BoardFilters } from './components/Board/board-filters';
import { DEFAULT_BOARD_FILTERS } from './components/Board/board-filters';
import { fetchCard, fetchSessionCards, uploadScreenshot } from './hooks/useKanbanApi';
import { useQuickActions } from './hooks/useQuickActions';
import { QuickActionsDrawer } from './components/QuickActions/QuickActionsDrawer';

const WikiView = React.lazy(async () => {
  const module = await import('./components/Wiki/WikiView');
  return { default: module.WikiView };
});

// "Feedback: " / "Feedback #N: " prefix를 모두 벗겨 원본 제목과 누적 피드백 깊이를 구한다.
// 피드백 카드에 다시 피드백을 줄 때 prefix가 중첩되는 것을 막기 위해 사용한다.
function extractFeedbackBase(rawTitle: string | undefined): { base: string; level: number } {
  let base = rawTitle ?? 'Unknown';
  let level = 0;
  for (;;) {
    const numbered = base.match(/^Feedback #(\d+):\s*/);
    if (numbered) {
      level = Math.max(level, Number(numbered[1]));
      base = base.slice(numbered[0].length);
      continue;
    }
    if (base.startsWith('Feedback: ')) {
      base = base.slice('Feedback: '.length);
      level += 1;
      continue;
    }
    break;
  }
  return { base, level };
}

const BOARD_VIEW_MODE_STORAGE_KEY = 'kanban-board-view-mode';
const COMPLETE_SESSION_VIEW_STORAGE_KEY = 'kanban-complete-session-view';

/**
 * The Board tab's three views, ClickUp-style: 리스트 / 보드 / 타임라인. Timeline
 * used to be a top-level tab, which read as a separate section even though it
 * only ever showed the board's own work.
 */
type BoardViewMode = 'board' | 'list' | 'timeline';

/** Switch order + labels, matching the tab strip's own left-to-right reading. */
const BOARD_VIEW_MODES: [BoardViewMode, string][] = [
  ['list', '리스트'],
  ['board', '보드'],
  ['timeline', '타임라인'],
];

function getStoredBoardViewMode(): BoardViewMode {
  if (typeof localStorage === 'undefined') return 'board';

  const stored = localStorage.getItem(BOARD_VIEW_MODE_STORAGE_KEY);
  if (stored === 'list' || stored === 'timeline') return stored;
  return 'board';
}

function getStoredCompleteSessionView(): boolean {
  if (typeof localStorage === 'undefined') return false;

  return localStorage.getItem(COMPLETE_SESSION_VIEW_STORAGE_KEY) === 'true';
}

export default function App() {
  const { cards, loading, error, updateCard, deleteCard, refreshCards, archiveCards, completeAllCards, dispatchCard, createCard, queueCard, unqueueCard, scheduleCard, cancelCardSchedule, reorderCards, setResumeSession, clearResumeSession, markCompletionSeen, clearError, showError } = useKanbanBoard();
  const [activeTab, setActiveTab] = useState<MainTab>('board');
  const [boardViewMode, setBoardViewMode] = useState<BoardViewMode>(getStoredBoardViewMode);
  const [groupCompleteSessions, setGroupCompleteSessions] = useState(getStoredCompleteSessionView);
  const [boardFilters, setBoardFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  const [showBoardTools, setShowBoardTools] = useState(false);
  const scheduler = useScheduler(activeTab === 'scheduler');
  // The Timeline is a Board *view*, so it replaces the card layouts rather than
  // living in its own tab; everything below that reads `boardViewMode` only
  // ever sees the two card layouts.
  const timelineActive = activeTab === 'board' && boardViewMode === 'timeline';
  const works = useWorks(activeTab === 'works' || timelineActive);
  const scripts = useScripts(activeTab === 'capabilities' || activeTab === 'board');
  const quickActions = useQuickActions(activeTab === 'board');
  const skillRoots = useSkillRoots(activeTab === 'capabilities');
  const settings = useSettings(activeTab === 'settings');
  // Loaded eagerly (not tab-gated) so card pickers see discovered skills on open.
  const skills = useSkills();
  const { questions, reply: replyQuestion, reject: rejectQuestion, refreshQuestions } = useQuestions();
  useFontScale();
  useTheme();
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  /**
   * The open card detail was resolved from the archive, not the board. Deep
   * links into finished work (a Timeline day cell, a Works session) land here,
   * and the board poll must not treat "not on the board" as "gone".
   */
  const [selectedCardArchived, setSelectedCardArchived] = useState(false);
  const [selectedSession, setSelectedSession] = useState<{ key: string; status: 'complete' | 'done' } | null>(null);
  /**
   * Cards for a session whose conversation was opened from outside the board —
   * a completed Work's session, or a Timeline rail older than the board. Keyed
   * by group key so a stale fetch cannot feed the wrong modal.
   */
  const [archivedSessionCards, setArchivedSessionCards] = useState<{ key: string; cards: KanbanCard[] } | null>(null);
  const [openWorkId, setOpenWorkId] = useState<string | null>(null);
  // Outcome of a Works session action. Owned here because a move that empties
  // the source Work deletes it, which closes the detail dialog that started it.
  const [workSessionNotice, setWorkSessionNotice] = useState<WorkSessionNoticeState | null>(null);
  const [bulkAssignSessions, setBulkAssignSessions] = useState<WorkInboxSession[] | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  useEffect(() => {
    setSelectedCard((prev) => {
      if (!prev) return prev;
      const live = cards.find((card) => card.id === prev.id);
      if (live) return live;
      // An archived card is off the board by definition — closing it here would
      // shut the dialog within one poll of opening it.
      return selectedCardArchived ? prev : null;
    });
  }, [cards, selectedCardArchived]);

  useEffect(() => {
    if (activeTab !== 'board') setQuickActionsOpen(false);
  }, [activeTab]);

  // 객체가 아닌 key만 보관하고, 매 렌더마다 최신 카드 목록에서 세션 그룹을 다시 만든다.
  // 폴링으로 카드가 갱신되어도 모달이 최신 turn을 반영하도록 보장한다.
  const selectedSessionGroup = useMemo(() => {
    if (!selectedSession) return null;
    // A session opened from outside the board carries its own (archive-inclusive)
    // card list; board sessions keep re-deriving from the poll so the modal
    // shows the latest turn.
    const source = archivedSessionCards?.key === selectedSession.key
      ? archivedSessionCards.cards
      : cards.filter((card) => card.status === selectedSession.status);
    return groupCompleteCardsBySession(source).find((group) => group.key === selectedSession.key) ?? null;
  }, [cards, selectedSession, archivedSessionCards]);

  // 세션이 사라지면(전부 archive/이동 등) 모달을 닫는다. 명시적으로 archive에서
  // 가져온 세션은 보드에 없는 것이 정상이므로 위 memo가 그 목록을 계속 쓴다.
  useEffect(() => {
    if (selectedSession && !selectedSessionGroup) {
      setSelectedSession(null);
      setArchivedSessionCards(null);
    }
  }, [selectedSession, selectedSessionGroup]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(BOARD_VIEW_MODE_STORAGE_KEY, boardViewMode);
  }, [boardViewMode]);

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(COMPLETE_SESSION_VIEW_STORAGE_KEY, String(groupCompleteSessions));
  }, [groupCompleteSessions]);

  const answerQuestionAndRefresh = async (questionId: string, answers: string[][]) => {
    await replyQuestion(questionId, answers);
    await Promise.all([refreshCards(), refreshQuestions()]);
  };

  const rejectQuestionAndRefresh = async (questionId: string) => {
    await rejectQuestion(questionId);
    await Promise.all([refreshCards(), refreshQuestions()]);
  };

  const handleQueueCard = async (cardId: string, afterCardId: string, sessionMode: QueueSessionMode) => {
    const updated = await queueCard(cardId, afterCardId, sessionMode);
    setSelectedCard(prev => prev?.id === updated.id ? updated : prev);
    return updated;
  };

  const handleUnqueueCard = async (cardId: string) => {
    const updated = await unqueueCard(cardId);
    setSelectedCard(prev => prev?.id === updated.id ? updated : prev);
    return updated;
  };

  const handleCreateFeedback = async (cardId: string, feedback: string, shouldDispatch: boolean, screenshots?: File[]) => {
    const originalCard = cards.find(c => c.id === cardId);
    const resultExcerpt = originalCard?.result
      ? originalCard.result.substring(0, 200) + (originalCard.result.length > 200 ? '...' : '')
      : '';

    // 피드백 카드에 다시 피드백을 주면 "Feedback: Feedback: ..." 처럼 prefix가 무한 중첩된다.
    // 기존 prefix(구형 "Feedback: " 반복 / 신형 "Feedback #N: ")를 모두 벗겨 원본 제목과
    // 누적 깊이를 구한 뒤, 한 단계만 올린 "Feedback #N: <원본>" 형태로 정규화한다.
    const { base: baseTitle, level } = extractFeedbackBase(originalCard?.title);
    const feedbackLevel = level + 1;

    const description = [
      `[Feedback for: ${baseTitle}]`,
      `[Original Card ID: ${cardId.substring(0, 8)}]`,
      resultExcerpt ? `[Original Result: ${resultExcerpt}]` : '',
      '---',
      feedback,
    ].filter(Boolean).join('\n');

    const newCard = await createCard({
      title: `Feedback #${feedbackLevel}: ${baseTitle}`,
      description,
      projectDir: originalCard?.projectDir,
      agentRuntime: originalCard?.agentRuntime,
      agentType: originalCard?.agentRuntime === 'opencode'
        ? (originalCard?.agentType ?? 'hephaestus')
        : originalCard?.agentType,
      model: originalCard?.model,
      codexOptions: originalCard?.codexOptions,
      feedbackForCardId: cardId,
    });

    if (screenshots && screenshots.length > 0) {
      for (const file of screenshots) {
        try {
          await uploadScreenshot(newCard.id, file);
        } catch {
          // 개별 업로드 실패는 무시하고 나머지를 계속 시도한다.
        }
      }
    }

    if (shouldDispatch) {
      await dispatchCard(newCard.id);
    }
  };

  const handleToggleFavorite = async (card: KanbanCard) => {
    await updateCard(card.id, { favorite: !card.favorite });
    setSelectedCard((prev) => prev?.id === card.id ? { ...prev, favorite: !card.favorite } : prev);
  };

  const hasUnreadCompletion = (card: KanbanCard): boolean => {
    if (card.status !== 'complete') return false;
    const completionTime = card.responseAt ?? card.completedAt ?? card.updatedAt;
    return !card.completedSeenAt || card.completedSeenAt < completionTime;
  };

  const handleOpenSession = (group: CompleteSessionGroup) => {
    const status = group.cards[0]?.status === 'done' ? 'done' : 'complete';
    setSelectedSession({ key: group.key, status });
  };

  const handleOpenCard = (card: KanbanCard, options?: { archived?: boolean }) => {
    setSelectedCard(card);
    setSelectedCardArchived(options?.archived === true);

    // An archived card has no board row to stamp, and the completion badge it
    // would clear is long gone.
    if (options?.archived) return;
    if (!hasUnreadCompletion(card)) return;

    void markCompletionSeen(card.id)
      .then((updated) => {
        setSelectedCard((prev) => prev?.id === updated.id ? updated : prev);
      })
      .catch(() => {
        // The board hook already surfaces the error banner.
      });
  };

  /**
   * Open a card by id from a surface that does not hold the board list —
   * Timeline day cells, the Works Inbox, the scheduler history. A card that has
   * been archived is *expected* here (that is the whole point of a Work being
   * looked back at), so the archive-inclusive read is the fallback rather than
   * an error, and a genuine miss reports itself instead of dying as an
   * unhandled rejection behind an unresponsive click.
   */
  const handleOpenCardById = async (cardId: string) => {
    const existing = cards.find((card) => card.id === cardId);
    if (existing) {
      handleOpenCard(existing);
      return;
    }

    try {
      const fetchedCard = await fetchCard(cardId, { includeArchived: true });
      handleOpenCard(fetchedCard, { archived: true });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : '카드를 불러오지 못했습니다';
      showError(createUiAlert('카드를 열 수 없습니다', message, 'Refresh board'));
    }
  };

  // The Work object is resolved from the live list each render so summary/status
  // updates from polling flow into the open detail dialog.
  const openWork = openWorkId
    ? works.works.find((work) => work.id === openWorkId) ?? null
    : null;
  /**
   * Archive-inclusive session detail for the open Work. Keyed on the Work's
   * `updatedAt` so a link, an unlink, a role change, or the completion sweep all
   * refetch — and so nothing is fetched at all while no dialog is open.
   */
  const workSessions = useWorkSessions(openWork?.id ?? null, openWork?.updatedAt);

  /**
   * Re-use the board's SessionConversationModal for a session addressed from the
   * Works tab or the Timeline.
   *
   * A board session is grouped from the live poll as before. A session with no
   * board cards is not an error — a completed Work archived all of them — so it
   * is fetched with the archive included and handed to the modal as its own
   * group. Only a session with no cards anywhere is reported as a failure.
   */
  const handleOpenWorkSession = (sessionId: string) => {
    const key = `session:${sessionId}`;
    const sessionCards = cards.filter((card) => card.sessionId === sessionId);
    if (sessionCards.length > 0) {
      const status = sessionCards.some((card) => card.status === 'done') ? 'done' : 'complete';
      setArchivedSessionCards(null);
      setSelectedSession({ key, status });
      return;
    }

    void fetchSessionCards(sessionId)
      .then((fetched) => {
        if (fetched.length === 0) {
          showError(createUiAlert(
            '대화를 열 수 없습니다',
            '이 세션에 남아 있는 카드가 없습니다.',
            'Refresh board',
          ));
          return;
        }
        setArchivedSessionCards({ key, cards: fetched });
        setSelectedSession({
          key,
          status: fetched.some((card) => card.status === 'done') ? 'done' : 'complete',
        });
      })
      .catch((e: unknown) => {
        const message = e instanceof Error ? e.message : '세션 카드를 불러오지 못했습니다';
        showError(createUiAlert('대화를 열 수 없습니다', message, 'Refresh board'));
      });
  };

  const handleAssignAll = () => {
    setBulkAssignSessions(works.inbox);
  };

  /**
   * Assign one session from the Timeline. Reuses the assign-all modal with a
   * single session so triage looks the same wherever it is started from — the
   * Inbox entry carries the lineage and directory signals the modal ranks by.
   */
  /**
   * Assign a session addressed from the Timeline. The Inbox is the only source
   * of the DTO the assign modal needs, so a session that is not in it cannot be
   * assigned — and that is a real state (it was discarded, or another tab
   * assigned it since this grid was polled). It used to `return` silently, which
   * made the 배정 button look broken; the Timeline now hides the button for
   * discarded sessions, and anything left over says why.
   */
  const handleAssignSession = (sessionId: string) => {
    const session = works.inbox.find((entry) => entry.sessionId === sessionId);
    if (!session) {
      showError(createUiAlert(
        '세션을 배정할 수 없습니다',
        '이 세션은 Inbox에 없습니다 — 폐기됐거나 이미 다른 Work에 배정된 세션입니다.',
        'Refresh board',
      ));
      return;
    }
    setBulkAssignSessions([session]);
  };

  /**
   * Undo primitives for the two triage surfaces. Held here because the notice
   * itself is owned here — an assignment can unmount the panel that made it
   * (the row leaves the Inbox), and the undo has to outlive that.
   */
  const workAssignNotice: WorkAssignUndoActions = useMemo(() => ({
    notify: setWorkSessionNotice,
    deleteWork: works.deleteWork,
    unlinkSession: async (workId: string, sessionId: string) => {
      await works.unlinkSession(workId, sessionId);
    },
    restoreSession: works.restoreIgnoredSession,
  }), [works.deleteWork, works.unlinkSession, works.restoreIgnoredSession]);

  const handleCloseBulkAssign = () => {
    setBulkAssignSessions(null);
    void works.refreshInbox();
  };

  const handleQueueOpen = (card: KanbanCard) => {
    if (card.scheduledDispatch?.status === 'scheduled' || card.scheduledDispatch?.status === 'dispatching') {
      showError(createUiAlert('Queue unavailable', '예약된 카드는 먼저 예약을 취소해야 Queue에 넣을 수 있습니다.', 'Refresh board'));
      return;
    }
    handleOpenCard(card);
  };

  const handleSaveSchedule = async (cardId: string, scheduledAt: string) => {
    const updated = await scheduleCard(cardId, scheduledAt);
    setSelectedCard((prev) => prev?.id === updated.id ? updated : prev);
    return updated;
  };

  const handleCancelSchedule = async (cardId: string) => {
    const updated = await cancelCardSchedule(cardId);
    setSelectedCard((prev) => prev?.id === updated.id ? updated : prev);
    return updated;
  };

  return (
    <div className="app">
      <header
        className="app-header"
        inert={activeTab === 'board' && quickActionsOpen}
        aria-hidden={(activeTab === 'board' && quickActionsOpen) || undefined}
      >
        <div className="app-header-inner">
          <h1 className="app-title">Agent Kanban</h1>
          <AppTabs activeTab={activeTab} onActivate={setActiveTab} badges={{ works: works.inboxCount }} />
          {activeTab === 'board' && (
            <button
              type="button"
              className={`app-board-mobile-tools-toggle${showBoardTools ? ' is-active' : ''}`}
              aria-expanded={showBoardTools}
              aria-controls="app-board-tools"
              onClick={() => setShowBoardTools((open) => !open)}
            >
              {showBoardTools ? 'Board 도구 닫기' : '☰ Board 도구'}
            </button>
          )}
          {activeTab === 'board' && (
            <div
              className={`app-board-view-controls${showBoardTools ? ' is-mobile-open' : ''}`}
              id="app-board-tools"
            >
              {/* One toolbar for all three board views. The filter bar narrows
                  the Timeline's session rows too (`sessionFilter`), and the
                  session-grouping toggle keeps its state visible here even
                  though only the list/board layouts render grouped columns —
                  a control that vanished on one view read as a broken toolbar. */}
              <BoardFilterBar
                cards={cards}
                filters={boardFilters}
                onFiltersChange={setBoardFilters}
                onFiltersReset={() => setBoardFilters(DEFAULT_BOARD_FILTERS)}
              />
              <fieldset className="app-board-view-toggle">
                <legend className="app-board-view-toggle-legend">Board view mode</legend>
                {BOARD_VIEW_MODES.map(([viewMode, label]) => (
                  <button
                    key={viewMode}
                    type="button"
                    className={`app-board-view-toggle-btn${boardViewMode === viewMode ? ' is-active' : ''}`}
                    aria-pressed={boardViewMode === viewMode}
                    onClick={() => setBoardViewMode(viewMode)}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
              <button
                type="button"
                className={`app-board-session-toggle${groupCompleteSessions ? ' is-active' : ''}`}
                aria-pressed={groupCompleteSessions}
                title={timelineActive
                  ? '리스트·보드 뷰에서 complete 카드를 세션별로 묶습니다 (타임라인은 항상 세션 단위)'
                  : 'Group complete cards by session'}
                onClick={() => setGroupCompleteSessions((previous) => !previous)}
              >
                Session 모아보기
              </button>
            </div>
          )}
          {activeTab === 'board' && !timelineActive && (
            <div className={`app-board-subheader${showBoardTools ? ' is-mobile-open' : ''}`}>
              <div className="app-project-controls">
                <BoardProjectSwitcher
                  cards={cards}
                  selectedDirectory={boardFilters.directory}
                  onDirectoryChange={(directory) => {
                    setBoardFilters((previous) => ({ ...previous, directory }));
                  }}
                />
              </div>
            </div>
          )}
        </div>
      </header>

      <main
        className="app-main"
        id={PANEL_IDS[activeTab]}
        role="tabpanel"
        aria-labelledby={TAB_IDS[activeTab]}
      >
        {timelineActive ? (
          <TimelineView
            works={works.works}
            loading={works.loading}
            error={works.error}
            onOpenWork={(work: Work) => setOpenWorkId(work.id)}
            onUpdateWorkDates={works.updateWorkDates}
            onRefresh={works.refreshWorks}
            onClearError={works.clearError}
            onOpenCard={(cardId) => {
              void handleOpenCardById(cardId);
            }}
            onOpenSession={handleOpenWorkSession}
            onAssignSession={handleAssignSession}
            sessionFilter={boardFilters}
            // A bar-edge edit rewrites a stored date with no confirmation, so it
            // gets the same undo bar the Works session actions use. Owned here
            // because the notice has to outlive whatever opened it.
            onNotify={setWorkSessionNotice}
          />
        ) : activeTab === 'board' ? (
          <BoardWorkspace
            leadingPanelExpanded={quickActionsOpen}
            leadingPanel={(
              <QuickActionsDrawer
                open={quickActionsOpen}
                actions={quickActions.entries}
                scripts={scripts.entries}
                loading={quickActions.loading}
                error={quickActions.error}
                runningActionIds={quickActions.runningActionIds}
                onOpen={() => setQuickActionsOpen(true)}
                onClose={() => setQuickActionsOpen(false)}
                onCreate={quickActions.createEntry}
                onUpdate={quickActions.updateEntry}
                onDelete={quickActions.deleteEntry}
                onRun={async (id, parameterValues) => {
                  const result = await quickActions.runEntry(id, parameterValues);
                  await refreshCards();
                  return result;
                }}
                onRefresh={quickActions.refreshEntries}
                onClearError={quickActions.clearError}
              />
            )}
          >
            {error && (
              <ErrorAlert
                className="error-banner"
                title={error.title}
                message={error.message}
                actionLabel={error.actionLabel}
                onAction={() => {
                  void refreshCards();
                }}
                onDismiss={clearError}
              />
            )}

            {loading && cards.length === 0 ? (
              <div className="loading-spinner" role="status" aria-label="Loading..." />
            ) : (
              <BoardScreen
                cards={cards}
                onCardClick={handleOpenCard}
                onSessionOpen={handleOpenSession}
                onStatusChange={(card, status) => updateCard(card.id, { status })}
                onArchive={archiveCards}
                onArchiveCards={(groupCards) => archiveCards(groupCards.map((card) => card.id))}
                onCompleteAll={completeAllCards}
                onDispatch={(card) => dispatchCard(card.id)}
                onFavoriteToggle={handleToggleFavorite}
                onDelete={(card) => deleteCard(card.id)}
                onQueueOpen={handleQueueOpen}
                onUnqueue={(card) => { void handleUnqueueCard(card.id); }}
                onCreate={() => setShowCreateModal(true)}
                onReorder={(cardIds) => reorderCards(cardIds)}
                questions={questions}
                viewMode={boardViewMode === 'list' ? 'list' : 'board'}
                groupCompleteSessions={groupCompleteSessions}
                filters={boardFilters}
              />
            )}
          </BoardWorkspace>
        ) : activeTab === 'works' ? (
          <WorksView
            works={works.works}
            inbox={works.inbox}
            loading={works.loading}
            error={works.error}
            onCreateWorkFromSession={works.createWorkFromSession}
            onLinkSessionToWork={works.linkSessionToWork}
            onAssignSessionsToWork={works.assignSessionsToWork}
            onCreateWorkFromSessions={works.createWorkFromSessions}
            onIgnoreSession={works.ignoreSession}
            ignoredSessions={works.ignoredSessions}
            onRestoreIgnoredSession={works.restoreIgnoredSession}
            assignNotice={workAssignNotice}
            onCompleteWork={works.completeWork}
            onRefresh={works.refreshWorks}
            onClearError={works.clearError}
            onOpenCard={(cardId) => {
              void handleOpenCardById(cardId);
            }}
            onOpenWork={(work: Work) => setOpenWorkId(work.id)}
            onAssignAll={handleAssignAll}
            config={works.config}
            onSaveConfig={works.saveConfig}
          />
        ) : activeTab === 'wiki' ? (
          <Suspense fallback={<div className="loading-spinner" role="status" aria-label="Loading wiki..." />}>
            <WikiView />
          </Suspense>
        ) : activeTab === 'scheduler' ? (
          <SchedulerView
            entries={scheduler.entries}
            loading={scheduler.loading}
            error={scheduler.error}
            onCreateEntry={scheduler.createEntry}
            onUpdateEntry={scheduler.updateEntry}
            onDeleteEntry={scheduler.deleteEntry}
            onToggleEntry={scheduler.toggleEntry}
            onRunEntry={scheduler.runEntry}
            onRefresh={scheduler.refreshEntries}
            onClearError={scheduler.clearError}
            onOpenCard={(cardId) => {
              void handleOpenCardById(cardId);
            }}
          />
        ) : activeTab === 'capabilities' ? (
          <CapabilitiesView
            skills={skills.skills}
            skillsLoading={skills.loading}
            skillsSyncing={skills.syncing}
            onSyncSkills={skills.sync}
            onRefreshSkills={skills.refresh}
            scripts={scripts.entries}
            scriptsLoading={scripts.loading}
            onUpdateScript={scripts.updateEntry}
            onDeleteScript={scripts.deleteEntry}
            onRunScript={scripts.runEntry}
            onRefreshScripts={scripts.refreshEntries}
            onSyncScripts={scripts.syncEntries}
            skillRoots={skillRoots.roots}
            skillRootsLoading={skillRoots.loading}
            onAddRoot={skillRoots.add}
            onUpdateRoot={skillRoots.update}
            onRemoveRoot={skillRoots.remove}
            onRefreshRoots={skillRoots.refresh}
            commandsVersion={skills.version}
            lastSkillSync={skills.lastSyncedAt}
          />
        ) : (
          <SettingsView
            entries={settings.entries}
            loading={settings.loading}
            error={settings.error}
            onCreateEntry={settings.createEntry}
            onUpdateEntry={settings.updateEntry}
            onDeleteEntry={settings.deleteEntry}
            onRefresh={settings.refreshEntries}
            onClearError={settings.clearError}
          />
        )}
      </main>

      {showCreateModal && (
        <CreateCardDialog
          allCards={cards}
          onClose={() => setShowCreateModal(false)}
          onCreate={createCard}
          onDispatch={dispatchCard}
          onQueue={handleQueueCard}
          onClearBoardError={clearError}
          onReportBoardAlert={(title, message) => {
            showError(createUiAlert(title, message, 'Refresh board'));
          }}
        />
      )}

      {bulkAssignSessions && (
        <BulkAssignModal
          sessions={bulkAssignSessions}
          works={works.works}
          onClose={handleCloseBulkAssign}
          onCreateWorkFromSession={works.createWorkFromSession}
          onLinkSessionToWork={works.linkSessionToWork}
          onIgnoreSession={works.ignoreSession}
          onOpenCard={(cardId) => {
            void handleOpenCardById(cardId);
          }}
          assignNotice={workAssignNotice}
          suggestSessionChain={works.config?.assignSuggestResumeChain ?? true}
          preferSameDir={works.config?.assignPreferSameDir ?? true}
        />
      )}

      {openWork && (
        <WorkDetailDialog
          work={openWork}
          cards={cards}
          detail={workSessions.detail}
          detailLoading={workSessions.loading}
          detailError={workSessions.error}
          onClose={() => setOpenWorkId(null)}
          onComplete={works.completeWork}
          onDiscard={works.discardWork}
          // A reopen lifts the Work's cards out of the archive, so the board
          // has to be re-read — the 3s poll would get there eventually, but the
          // user pressed the button to see those cards come back.
          onReopen={(id) => works.reopenWork(id).then(async (outcome) => {
            if (outcome === 'done') {
              await refreshCards();
              setWorkSessionNotice({
                tone: 'success',
                message: '✓ Work를 다시 열고 archive된 카드를 보드로 되돌렸습니다.',
              });
            }
            return outcome;
          })}
          // The source survives as 병합됨, but it is no longer the Work being
          // worked on — so the dialog follows the sessions to the target.
          onMerge={(id, intoWorkId) => works.mergeWork(id, intoWorkId).then((result) => {
            setOpenWorkId(result.to.id);
            setWorkSessionNotice({
              tone: 'success',
              message: `✓ "${result.from.title}"의 세션 ${result.movedSessionIds.length}개를 "${result.to.title}"으로 병합했습니다.`,
            });
          })}
          onUpdateNotes={works.updateWorkNotes}
          onOpenSession={handleOpenWorkSession}
          onUpdateDates={works.updateWorkDates}
          onUpdateMeta={works.updateWorkMeta}
          onRegenerateSummary={(id) => works.generateSummary(id).then(() => {})}
          onDelete={works.deleteWork}
          onPruneSessions={works.pruneWorkSessions}
          sessionActions={{
            works: works.works,
            move: works.moveSession,
            moveToNewWork: works.moveSessionToNewWork,
            link: works.linkSessionToWork,
            unlink: works.unlinkSession,
            notify: setWorkSessionNotice,
          }}
        />
      )}

      {workSessionNotice && (
        <WorkSessionNotice
          notice={workSessionNotice}
          onDismiss={() => setWorkSessionNotice(null)}
        />
      )}

      {/* Rendered *after* WorkDetailDialog on purpose. Every DialogSkeleton
          overlay shares one z-index, so DOM order decides the stack — and 대화
          on a Work's session row opens this modal *from* that dialog, so it
          has to land on top. (Card detail still follows, since a card is opened
          from inside the conversation.) */}
      {selectedSession && selectedSessionGroup && (
        <SessionConversationModal
          group={selectedSessionGroup}
          status={selectedSession.status}
          onClose={() => {
            setSelectedSession(null);
            setArchivedSessionCards(null);
          }}
          onCreateFeedback={handleCreateFeedback}
        />
      )}

      {selectedCard && (
        <CardDetailDialog
          card={selectedCard}
          allCards={cards}
          onClose={() => {
            setSelectedCard(null);
            setSelectedCardArchived(false);
          }}
          onStatusChange={(id, status) => {
             return updateCard(id, { status })
               .then(() => {
                 setSelectedCard(prev => prev ? { ...prev, status } : null);
                 return true;
               })
               .catch(() => false);
          }}
          onDelete={(id) => {
            return deleteCard(id)
              .then(() => {
                setSelectedCard(null);
                return true;
              })
              .catch(() => false);
          }}
          onDispatch={(id) => dispatchCard(id).then(() => true).catch(() => false)}
          onScheduleSave={handleSaveSchedule}
          onCancelSchedule={handleCancelSchedule}
          onToggleFavorite={async (id) => {
            const current = cards.find((candidate) => candidate.id === id);
            if (!current) {
              return false;
            }
            await handleToggleFavorite(current);
            return true;
          }}
          onNavigateToCard={handleOpenCard}
          onQueue={handleQueueCard}
          onUnqueue={handleUnqueueCard}
          onSetResumeSession={async (cardId, sessionId) => {
            await setResumeSession(cardId, sessionId);
            setSelectedCard(prev => prev?.id === cardId ? { ...prev, resumeSessionId: sessionId } : prev);
          }}
          onClearResumeSession={async (cardId) => {
            await clearResumeSession(cardId);
            setSelectedCard(prev => prev?.id === cardId ? { ...prev, resumeSessionId: undefined } : prev);
          }}
           onUpdate={(id, updates) => {
             updateCard(id, updates);
             setSelectedCard(prev => (prev ? applyCardUpdates(prev, updates) : null));
           }}
          onCreateFeedback={handleCreateFeedback}
          question={selectedCard?.sessionId ? questions.find(q => q.sessionID === selectedCard.sessionId) : undefined}
          onAnswerQuestion={answerQuestionAndRefresh}
          onRejectQuestion={rejectQuestionAndRefresh}
          onScreenshotUploaded={(screenshot) => {
            setSelectedCard(prev => prev ? { ...prev, screenshots: [...(prev.screenshots || []), screenshot] } : null);
          }}
          onScreenshotDeleted={(screenshotId) => {
            setSelectedCard(prev => prev ? { ...prev, screenshots: prev.screenshots?.filter(s => s.id !== screenshotId) || [] } : null);
          }}
        />
      )}

      <footer
        className="app-footer"
        inert={activeTab === 'board' && quickActionsOpen}
        aria-hidden={(activeTab === 'board' && quickActionsOpen) || undefined}
      >
        <span>agent-kanban v0.1.0</span>
      </footer>

      <QuestionBanner
        questions={questions}
        onReply={answerQuestionAndRefresh}
        onReject={rejectQuestionAndRefresh}
      />
    </div>
  );
}
