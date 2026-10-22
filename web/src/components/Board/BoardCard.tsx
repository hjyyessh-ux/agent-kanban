import React from 'react';
import type { KanbanStatus } from '../../../../src/core/types';
import type { V2CardViewModel } from './board-selectors';
import { CardActions, ExecutionTypeBadge, FavoriteToggleButton, NestedChildAccordion, OriginExecutionBadges, ScheduledMetaBadge, SchedulerBadge, TelegramBadge } from './BoardCardSections';
import { getDirectoryProjectName } from './directory-display';
import { formatDuration, formatElapsedKo, formatRelativeTime, resolveRunDurationMs } from '../../utils/format-duration';
import { dirAccentClass } from '../../utils/project-color';
import { IdChip } from '../shared/IdChip';
import { useNowTick } from '../../hooks/useNowTick';

export interface BoardCardProps {
  vm: V2CardViewModel;
  onClick: () => void;
  draggable: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onStatusChange?: (newStatus: KanbanStatus) => void;
  onDispatch?: () => void | Promise<void>;
  onQueueOpen?: () => void;
  onUnqueue?: () => void;
  onDelete?: () => void;
  onFavoriteToggle?: () => void;
  /** `BoardCardWorkField` — the Work picker footer row. Every group mode, once Works have loaded. */
  workField?: React.ReactNode;
}

export const STATUS_ACCENT: Record<KanbanStatus, string> = {
  todo: 'var(--kv2-status-todo-accent)',
  in_progress: 'var(--kv2-status-in-progress-accent)',
  complete: 'var(--kv2-status-complete-accent)',
  done: 'var(--kv2-status-done-accent)',
};

export const DELETE_CARD_CONFIRM_MESSAGE = 'Move this card to trash? You can restore it later.';

export function confirmBoardCardDelete(): boolean {
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') {
    return false;
  }
  return window.confirm(DELETE_CARD_CONFIRM_MESSAGE);
}

function formatExactTimestamp(iso: string): string {
  if (!iso) return '';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

type CardTimeFields = Pick<
  V2CardViewModel,
  'status' | 'createdAt' | 'updatedAt' | 'startedAt' | 'completedAt' | 'durationMs'
>;

/**
 * The card's time line, beside the runtime badge:
 * - todo → `27d ago`
 * - in_progress → `● 12분 34초째 실행 중`, ticking from `startedAt` (falls back
 *   to `Updated …` when the run has no start stamp)
 * - complete / done → `⏱ {run length} · {time since it ended}`
 *
 * Its own component on purpose: `useNowTick` re-renders only this leaf once a
 * second, and only while the card is running, so a live clock never repaints
 * the column or the board.
 */
export const BoardCardTimeMeta: React.FC<{ vm: CardTimeFields }> = ({ vm }) => {
  const live = vm.status === 'in_progress' && Boolean(vm.startedAt);
  const now = useNowTick(live);
  const exactTitle = `Created ${formatExactTimestamp(vm.createdAt)} · Updated ${formatExactTimestamp(vm.updatedAt)}`;

  if (live && vm.startedAt) {
    const startedMs = new Date(vm.startedAt).getTime();
    return (
      <span
        className="kv2-card-time kv2-card-time--live"
        title={`Started ${formatExactTimestamp(vm.startedAt)}`}
      >
        <span className="kv2-card-live-dot" aria-hidden="true" />
        {formatElapsedKo(now - startedMs)}째 실행 중
      </span>
    );
  }

  if (vm.status === 'complete' || vm.status === 'done') {
    const durationMs = resolveRunDurationMs(vm);
    const endedAt = vm.completedAt ?? vm.updatedAt;
    const parts = [
      durationMs === null ? null : `⏱ ${formatDuration(durationMs)}`,
      formatRelativeTime(endedAt),
    ].filter(Boolean);
    return (
      <span className="kv2-card-time" title={`${exactTitle}${vm.completedAt ? ` · Completed ${formatExactTimestamp(vm.completedAt)}` : ''}`}>
        {parts.join(' · ')}
      </span>
    );
  }

  const label = formatRelativeTime(vm.updatedAt);
  return (
    <span className="kv2-card-time" title={exactTitle}>
      {vm.status === 'in_progress' ? `Updated ${label}` : label}
    </span>
  );
};

export const BoardCard: React.FC<BoardCardProps> = ({
  vm,
  onClick,
  draggable,
  onDragStart,
  onDragEnd,
  onStatusChange,
  onDispatch,
  onQueueOpen,
  onUnqueue,
  onDelete,
  onFavoriteToggle,
  workField,
}) => {
  const projectName = getDirectoryProjectName(vm.projectDir);
  const cls = [
    'kv2-card',
    vm.hasQuestion ? 'kv2-card--has-question' : '',
    vm.isChild ? 'kv2-card--child' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      data-id={vm.id}
      draggable={draggable}
      onDragStart={draggable ? onDragStart : undefined}
      onDragEnd={draggable ? onDragEnd : undefined}
    >
      <div
        className="kv2-card-accent"
        style={{ '--kv2-status-accent': STATUS_ACCENT[vm.status] } as React.CSSProperties}
      />

      {/* Visual affordance only — the whole card (not just this icon) is the drag source. */}
      {draggable && (
        <span className="kv2-card-drag-handle" aria-hidden="true">⋮⋮</span>
      )}

      {/* Row 1: project chip (shrinks, truncates) ··· right group (never shrinks).
          Sits above the click layer so the chip's title and the right-group
          controls stay hoverable; a click on the chip still opens the card. */}
      <div className="kv2-card-top" onClick={onClick}>
        {projectName ? (
          <span
            className={`works-dir-chip kv2-project-chip kv2-card-project ${dirAccentClass(vm.projectDir)}`.trim()}
            title={vm.projectDir}
          >
            {projectName}
          </span>
        ) : (
          <span className="kv2-card-project-spacer" aria-hidden="true" />
        )}
        <div className="kv2-card-header-meta">
          {vm.hasUnreadCompletion && (
            <span
              className="kv2-card-unread-dot"
              title="Unread completion"
              aria-label="Unread completion"
            />
          )}
          {vm.originChannel === 'scheduler' && (
            <SchedulerBadge title={vm.schedulerName ? `Scheduler origin · ${vm.schedulerName}` : 'Scheduler origin'} />
          )}
          {vm.originChannel === 'telegram' && <TelegramBadge />}
          <OriginExecutionBadges
            originChannel={vm.originChannel}
            quickActionId={vm.quickActionId}
          />
          {onFavoriteToggle && (
            <FavoriteToggleButton
              active={vm.favorite}
              onToggle={onFavoriteToggle}
              className="kv2-favorite-toggle--board"
            />
          )}
          <IdChip id={vm.id} kind="card" />
        </div>
      </div>

      <div className="kv2-card-surface">
        <div className="kv2-card-title">{vm.title}</div>
        {/* Always shown, even when it repeats the title — hiding it made
            "no prompt" and "same as title" look identical. */}
        <div className="kv2-card-summary kv2-card-prompt">{vm.boardSummary}</div>
      </div>

      {vm.nestedChildren.length > 0 && (
        <NestedChildAccordion items={vm.nestedChildren} />
      )}

      <button
        type="button"
        className="kv2-card-click-layer"
        onClick={onClick}
        aria-label={`Open details for ${vm.title}`}
      />

      <div className="kv2-card-divider" aria-hidden="true" />

      <div className="kv2-card-meta-row">
        <ExecutionTypeBadge
          runtime={vm.agentRuntime}
          executionKind={vm.executionKind}
          scriptName={vm.scriptName}
        />
        <BoardCardTimeMeta vm={vm} />
      </div>

      {workField && (
        <div className="kv2-card-work-row" onClick={(event) => event.stopPropagation()}>
          {workField}
        </div>
      )}

      {vm.hasScheduledBadge && (
        <div className="kv2-card-scheduled-row">
          <ScheduledMetaBadge vm={vm} />
        </div>
      )}

      <div className="kv2-card-footer">
        <div className="kv2-card-actions-wrapper">
          <CardActions
            vm={vm}
            onStatusChange={onStatusChange}
            onDispatch={onDispatch}
            onQueueOpen={onQueueOpen}
            onUnqueue={onUnqueue}
          />
          {onDelete && (
            <button
              type="button"
              className="kv2-card-icon-action kv2-card-icon-action--danger"
              onClick={(e) => {
                e.stopPropagation();
                if (confirmBoardCardDelete()) {
                  onDelete();
                }
              }}
              aria-label="Delete card"
              title="Delete card"
            >
              ✕
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
