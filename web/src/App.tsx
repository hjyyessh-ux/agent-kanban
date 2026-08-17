import React, { Suspense, useEffect, useMemo, useState } from 'react';
import { BoardFilterBar } from './components/Board/BoardFilterBar';
import { BoardProjectSwitcher } from './components/Board/BoardProjectSwitcher';
import { BoardScreen } from './components/Board/BoardScreen';
import { groupCompleteCardsBySession } from './components/Board/BoardCompleteSessionView';
import type { CompleteSessionGroup } from './components/Board/BoardCompleteSessionView';
import { SessionConversationModal } from './components/Board/SessionConversationModal';
import { CardDetailDialog } from './components/Card/CardDetailDialog';
import { CreateCardDialog } from './components/Card/CreateCardDialog';
import { SchedulerView } from './components/Scheduler/SchedulerView';
import { SettingsView } from './components/Settings/SettingsView';
import { ErrorAlert } from './components/shared/ErrorAlert';
import { AppTabs, PANEL_IDS, TAB_IDS, type MainTab } from './components/shared/AppTabs';
import { applyCardUpdates } from './utils/cardUpdate';
import { useSettings } from './hooks/useSettings';
import { useKanbanBoard } from './hooks/useKanbanBoard';
import { useScheduler } from './hooks/useScheduler';
import { CapabilitiesView } from './components/Capabilities/CapabilitiesView';
import { useScripts } from './hooks/useScripts';
import { useSkills } from './hooks/useSkills';
import { useSkillRoots } from './hooks/useSkillRoots';
import type { KanbanCard } from '../../src/core/types';
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
import { fetchCard, uploadScreenshot } from './hooks/useKanbanApi';
import { useQuickActions } from './hooks/useQuickActions';
import { QuickActionsDialog } from './components/QuickActions/QuickActionsDialog';

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

function getStoredBoardViewMode(): 'board' | 'list' {
  if (typeof localStorage === 'undefined') return 'board';

  const stored = localStorage.getItem(BOARD_VIEW_MODE_STORAGE_KEY);
  return stored === 'list' ? 'list' : 'board';
}

function getStoredCompleteSessionView(): boolean {
  if (typeof localStorage === 'undefined') return false;

  return localStorage.getItem(COMPLETE_SESSION_VIEW_STORAGE_KEY) === 'true';
}

export default function App() {
  const { cards, loading, error, updateCard, deleteCard, refreshCards, archiveCards, completeAllCards, dispatchCard, createCard, queueCard, unqueueCard, scheduleCard, cancelCardSchedule, reorderCards, setResumeSession, clearResumeSession, markCompletionSeen, clearError, showError } = useKanbanBoard();
  const [activeTab, setActiveTab] = useState<MainTab>('board');
  const [boardViewMode, setBoardViewMode] = useState<'board' | 'list'>(getStoredBoardViewMode);
  const [groupCompleteSessions, setGroupCompleteSessions] = useState(getStoredCompleteSessionView);
  const [boardFilters, setBoardFilters] = useState<BoardFilters>(DEFAULT_BOARD_FILTERS);
  const [showBoardTools, setShowBoardTools] = useState(false);
  const scheduler = useScheduler(activeTab === 'scheduler');
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
  const [selectedSession, setSelectedSession] = useState<{ key: string; status: 'complete' | 'done' } | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showQuickActions, setShowQuickActions] = useState(false);
  useEffect(() => {
    setSelectedCard((prev) => {
      if (!prev) return prev;
      return cards.find((card) => card.id === prev.id) ?? null;
    });
  }, [cards]);

  useEffect(() => {
    if (activeTab !== 'board') setShowQuickActions(false);
  }, [activeTab]);

  // 객체가 아닌 key만 보관하고, 매 렌더마다 최신 카드 목록에서 세션 그룹을 다시 만든다.
  // 폴링으로 카드가 갱신되어도 모달이 최신 turn을 반영하도록 보장한다.
  const selectedSessionGroup = useMemo(() => {
    if (!selectedSession) return null;
    const statusCards = cards.filter((card) => card.status === selectedSession.status);
    return groupCompleteCardsBySession(statusCards).find((group) => group.key === selectedSession.key) ?? null;
  }, [cards, selectedSession]);

  // 세션이 사라지면(전부 archive/이동 등) 모달을 닫는다.
  useEffect(() => {
    if (selectedSession && !selectedSessionGroup) {
      setSelectedSession(null);
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

  const handleOpenCard = (card: KanbanCard) => {
    setSelectedCard(card);

    if (!hasUnreadCompletion(card)) return;

    void markCompletionSeen(card.id)
      .then((updated) => {
        setSelectedCard((prev) => prev?.id === updated.id ? updated : prev);
      })
      .catch(() => {
        // The board hook already surfaces the error banner.
      });
  };

  const handleOpenCardById = async (cardId: string) => {
    const existing = cards.find((card) => card.id === cardId);
    if (existing) {
      handleOpenCard(existing);
      return;
    }

    const fetchedCard = await fetchCard(cardId);
    handleOpenCard(fetchedCard);
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
      <header className="app-header">
        <div className="app-header-inner">
          <h1 className="app-title">Agent Kanban</h1>
          <AppTabs activeTab={activeTab} onActivate={setActiveTab} />
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
              <BoardFilterBar
                cards={cards}
                filters={boardFilters}
                onFiltersChange={setBoardFilters}
                onFiltersReset={() => setBoardFilters(DEFAULT_BOARD_FILTERS)}
              />
              <fieldset className="app-board-view-toggle">
                <legend className="app-board-view-toggle-legend">Board view mode</legend>
                <button
                  type="button"
                  className={`app-board-view-toggle-btn${boardViewMode === 'board' ? ' is-active' : ''}`}
                  aria-pressed={boardViewMode === 'board'}
                  onClick={() => setBoardViewMode('board')}
                >
                  Board
                </button>
                <button
                  type="button"
                  className={`app-board-view-toggle-btn${boardViewMode === 'list' ? ' is-active' : ''}`}
                  aria-pressed={boardViewMode === 'list'}
                  onClick={() => setBoardViewMode('list')}
                >
                  List
                </button>
              </fieldset>
              <button
                type="button"
                className={`app-board-session-toggle${groupCompleteSessions ? ' is-active' : ''}`}
                aria-pressed={groupCompleteSessions}
                title="Group complete cards by session"
                onClick={() => setGroupCompleteSessions((previous) => !previous)}
              >
                Session 모아보기
              </button>
            </div>
          )}
          {activeTab === 'board' && (
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
        className={`app-main${activeTab === 'board' ? ' app-main--with-quick-actions' : ''}`}
        id={PANEL_IDS[activeTab]}
        role="tabpanel"
        aria-labelledby={TAB_IDS[activeTab]}
      >
        {activeTab === 'board' ? (
          <>
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
                viewMode={boardViewMode}
                groupCompleteSessions={groupCompleteSessions}
                filters={boardFilters}
              />
            )}
          </>
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

      {selectedSession && selectedSessionGroup && (
        <SessionConversationModal
          group={selectedSessionGroup}
          status={selectedSession.status}
          onClose={() => setSelectedSession(null)}
          onCreateFeedback={handleCreateFeedback}
        />
      )}

      {selectedCard && (
        <CardDetailDialog
          card={selectedCard}
          allCards={cards}
          onClose={() => setSelectedCard(null)}
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

      {activeTab === 'board' && (
        <button
          type="button"
          className="kv2-btn kv2-btn--primary kv2-quick-actions-launcher"
          aria-label="Quick Actions"
          aria-haspopup="dialog"
          aria-expanded={showQuickActions}
          onClick={() => setShowQuickActions(true)}
        >
          <span aria-hidden="true">⚡</span>
          <span className="kv2-quick-actions-launcher-label">Quick Actions</span>
        </button>
      )}

      {showQuickActions && (
        <QuickActionsDialog
          actions={quickActions.entries}
          scripts={scripts.entries}
          loading={quickActions.loading}
          error={quickActions.error}
          runningActionIds={quickActions.runningActionIds}
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
          onClose={() => setShowQuickActions(false)}
        />
      )}

      <footer className="app-footer">
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
