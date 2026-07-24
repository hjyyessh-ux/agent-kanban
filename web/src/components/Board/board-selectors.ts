import type { AgentRuntime, CardOriginChannel, KanbanCard, KanbanStatus, QueueSessionMode, ScheduledDispatchStatus } from '../../../../src/core/types';
import type { QuestionRequest } from '../../../../src/plugin/question-monitor';
import { getAgentConfig } from '../../constants/agents';
import { formatAgentTypeLabel } from '../../utils/agent-label';
import { formatScheduledKstLabel } from '../shared/ScheduledDispatchUi';
import { groupCardsByParent, sortCardsForColumn } from './board-utils';
import type { CardWithChildren } from './board-utils';

export interface ChildItem {
  id: string;
  title: string;
  status: KanbanStatus;
  agentType?: string;
  linkKind?: 'subagent' | 'nested' | 'worker';
}

export interface V2CardViewModel {
  id: string;
  title: string;
  boardSummary: string;
  status: KanbanStatus;
  agentLabel: string | null;
  agentColor: string;
  agentEmoji: string | null;
  agentRuntime: AgentRuntime;
  hasChildren: boolean;
  childCount: number;
  childTodoCount: number;
  childInProgressCount: number;
  childDoneCount: number;
  isChild: boolean;
  linkKind: 'subagent' | 'nested' | 'worker' | undefined;
  nestedChildren: ChildItem[];
  workerChildCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | undefined;
  completedAt: string | undefined;
  durationMs: number | undefined;
  sessionId: string | undefined;
  projectDir: string | undefined;
  hasQuestion: boolean;
  queuedAfterCardId: string | undefined;
  queuePosition: number | undefined;
  queueSessionMode: QueueSessionMode | undefined;
  queueTargetTitle: string | undefined;
  parentCardId: string | undefined;
  sourceContext: string | undefined;
  originChannel: CardOriginChannel | undefined;
  schedulerName: string | undefined;
  telegramMessageId: string | undefined;
  telegramChatId: number | undefined;
  telegramReplyStatus: 'pending' | 'sent' | 'failed' | 'skipped' | undefined;
  telegramReplyMessageId: number | undefined;
  telegramReplyError: string | undefined;
  favorite: boolean;
  hasUnreadCompletion: boolean;
  hasScheduledBadge: boolean;
  scheduledStatus: ScheduledDispatchStatus | undefined;
  scheduledAt: string | undefined;
  scheduledAtLabel: string | undefined;
  scheduledBadgeLabel: string | undefined;
  scheduledFailureReason: string | undefined;
  scheduledDispatchedAtLabel: string | undefined;
}

export interface V2ColumnViewModel {
  status: KanbanStatus;
  label: string;
  cards: V2CardViewModel[];
  count: number;
}

const STATUS_LABELS: Record<KanbanStatus, string> = {
  todo: 'To Do',
  in_progress: 'In Progress',
  complete: 'Complete',
  done: 'Done',
};

const DEFAULT_AGENT_COLOR = 'var(--kv2-agent-default)';

function normalizeBoardText(value: string | undefined): string {
  return value?.replace(/\s+/g, ' ').trim() ?? '';
}

function getBoardSummary(card: KanbanCard): string {
  const description = normalizeBoardText(card.description);
  const progressSummary = normalizeBoardText(card.progressSummary);
  const result = normalizeBoardText(card.result);

  return description || progressSummary || result || 'Open details';
}

function hasUnreadCompletion(card: KanbanCard): boolean {
  if (card.status !== 'complete') return false;
  const completionTime = card.responseAt ?? card.completedAt ?? card.updatedAt;
  if (!completionTime) return false;
  return !card.completedSeenAt || card.completedSeenAt < completionTime;
}

function toCardViewModel(
  card: CardWithChildren,
  allGrouped: CardWithChildren[],
  questions?: QuestionRequest[],
): V2CardViewModel {
  const agentConfig = getAgentConfig(card.agentType);
  const children = card.childCards ?? [];
  const queueTarget = card.queuedAfterCardId
    ? allGrouped.find((candidate) => candidate.id === card.queuedAfterCardId)
    : undefined;

  const childTodoCount = children.filter((child) => child.status === 'todo').length;
  const childInProgressCount = children.filter((child) => child.status === 'in_progress').length;
  const childDoneCount = children.filter(
    (child) => child.status === 'complete' || child.status === 'done',
  ).length;
  const nestedChildren: ChildItem[] = children
    .filter((c) => c.linkKind === 'nested')
    .map((c) => ({ id: c.id, title: c.title, status: c.status, agentType: c.agentType, linkKind: c.linkKind }));
  const workerChildCount = children.filter((c) => c.linkKind === 'worker').length;

  return {
    id: card.id,
    title: card.title,
    boardSummary: getBoardSummary(card),
    status: card.status,
    agentLabel: formatAgentTypeLabel(card.agentType),
    agentColor: agentConfig?.color ?? DEFAULT_AGENT_COLOR,
    agentEmoji: agentConfig?.emoji ?? null,
    agentRuntime: card.agentRuntime ?? 'opencode',
    hasChildren: children.length > 0,
    childCount: children.length,
    childTodoCount,
    childInProgressCount,
    childDoneCount,
    isChild: !!card.parentCardId,
    linkKind: card.linkKind,
    nestedChildren,
    workerChildCount,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    startedAt: card.startedAt,
    completedAt: card.completedAt,
    durationMs: card.durationMs,
    sessionId: card.sessionId,
    projectDir: card.projectDir,
    hasQuestion: !!(questions && card.sessionId && questions.some(q => q.sessionID === card.sessionId)),
    queuedAfterCardId: card.queuedAfterCardId,
    queuePosition: card.queuePosition,
    queueSessionMode: card.queueSessionMode,
    queueTargetTitle: queueTarget?.title,
    parentCardId: card.parentCardId,
    sourceContext: card.sourceContext,
    originChannel: card.originChannel,
    schedulerName: card.schedulerName,
    telegramMessageId: card.telegramMessageId,
    telegramChatId: card.telegramChatId,
    telegramReplyStatus: card.telegramReplyStatus,
    telegramReplyMessageId: card.telegramReplyMessageId,
    telegramReplyError: card.telegramReplyError,
    favorite: !!card.favorite,
    hasUnreadCompletion: hasUnreadCompletion(card),
    hasScheduledBadge: card.scheduledDispatch?.status === 'scheduled',
    scheduledStatus: card.scheduledDispatch?.status,
    scheduledAt: card.scheduledDispatch?.scheduledAt,
    scheduledAtLabel: card.scheduledDispatch?.scheduledAt
      ? formatScheduledKstLabel(card.scheduledDispatch.scheduledAt)
      : undefined,
    scheduledBadgeLabel: card.scheduledDispatch?.status === 'scheduled' && card.scheduledDispatch.scheduledAt
      ? `예약됨 · ${formatScheduledKstLabel(card.scheduledDispatch.scheduledAt)}`
      : undefined,
    scheduledFailureReason: card.scheduledDispatch?.error,
    scheduledDispatchedAtLabel: card.scheduledDispatch?.dispatchedAt
      ? formatScheduledKstLabel(card.scheduledDispatch.dispatchedAt)
      : undefined,
  };
}

export function selectColumns(
  cards: KanbanCard[],
  questions?: QuestionRequest[],
): V2ColumnViewModel[] {
  const statuses: KanbanStatus[] = ['todo', 'in_progress', 'complete', 'done'];
  const grouped = groupCardsByParent(cards);

  return statuses.map(status => {
    const columnCards = sortCardsForColumn(
      status,
      grouped.filter(c => c.status === status),
    ).map(c => toCardViewModel(c, grouped, questions));

    return {
      status,
      label: STATUS_LABELS[status],
      cards: columnCards,
      count: columnCards.length,
    };
  });
}

export function selectCardById(cards: KanbanCard[], id: string): KanbanCard | undefined {
  return cards.find(c => c.id === id);
}
