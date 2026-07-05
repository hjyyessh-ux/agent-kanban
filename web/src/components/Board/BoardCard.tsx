import React from 'react';
import type { KanbanStatus } from '../../../../src/core/types';
import type { V2CardViewModel } from './board-selectors';
import { CardActions, FavoriteToggleButton, NestedChildAccordion, RuntimeBadge, TelegramBadge } from './BoardCardSections';
import { getDirectoryProjectName } from './directory-display';
import { formatDuration } from '../../utils/format-duration';
import { buildResumeCommand } from '../../utils/resume-command';

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
}) => {
  const cardId = `#${vm.id.slice(0, 6)}`;
  const projectName = getDirectoryProjectName(vm.projectDir);
  const resumeCommand = vm.sessionId
    ? buildResumeCommand(vm.agentRuntime, vm.sessionId, vm.projectDir)
    : null;
  const cls = [
    'kv2-card',
    vm.hasQuestion ? 'kv2-card--has-question' : '',
    vm.isChild ? 'kv2-card--child' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const durationLabel = typeof vm.durationMs === 'number'
    ? formatDuration(vm.durationMs)
    : (vm.startedAt && vm.completedAt
        ? formatDuration(new Date(vm.completedAt).getTime() - new Date(vm.startedAt).getTime())
        : null);

  return (
    <div
      className={cls}
      data-id={vm.id}
      draggable={draggable}
    >
      <div
        className="kv2-card-accent"
        style={{ '--kv2-status-accent': STATUS_ACCENT[vm.status] } as React.CSSProperties}
      />

      {draggable && (
        <button
          type="button"
          className="kv2-card-drag-handle"
          draggable
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          ⋮⋮
        </button>
      )}

      <div className="kv2-card-surface">
        <div className="kv2-card-header">
          <div className="kv2-card-runtime-row">
            <RuntimeBadge runtime={vm.agentRuntime} />
          </div>
        </div>

        <div className="kv2-card-title">{vm.title}</div>
        <div className="kv2-card-section-label">Prompt</div>

        <div className="kv2-card-prompt-shell">
          <div className="kv2-card-prompt-accent" />
          <div className="kv2-card-summary kv2-card-prompt">{vm.boardSummary}</div>
        </div>
      </div>

      {vm.nestedChildren.length > 0 && (
        <NestedChildAccordion items={vm.nestedChildren} />
      )}

      <div className="kv2-card-header-meta kv2-card-header-meta--floating">
        {vm.hasUnreadCompletion && (
          <span
            className="kv2-card-unread-dot"
            title="Unread completion"
            aria-label="Unread completion"
          />
        )}
        {vm.originChannel === 'telegram' && <TelegramBadge />}
        {onFavoriteToggle && (
          <FavoriteToggleButton
            active={vm.favorite}
            onToggle={onFavoriteToggle}
            className="kv2-favorite-toggle--board"
          />
        )}
        <button
          type="button"
          className="kv2-card-id kv2-card-id--copyable"
          onClick={(e) => {
            e.stopPropagation();
            navigator.clipboard.writeText(vm.id);
          }}
          title="Click to copy full ID"
        >
          {cardId}
        </button>
      </div>

      <button
        type="button"
        className="kv2-card-click-layer"
        onClick={onClick}
        aria-label={`Open details for ${vm.title}`}
      />

      <div className="kv2-card-divider" aria-hidden="true" />

      {projectName && (
        <div className="kv2-card-directory" title={vm.projectDir}>
          <span className="kv2-card-directory-label">Proj:</span>
          <span className="kv2-card-directory-name">{projectName}</span>
        </div>
      )}

      {vm.sessionId && resumeCommand && (
        <button
          type="button"
          className="kv2-card-session-command"
          title={`Copy resume command: ${resumeCommand}`}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(resumeCommand);
          }}
        >
          <span className="kv2-card-session-label">Session:</span>
          <code>{vm.sessionId}</code>
        </button>
      )}

      <div className="kv2-card-footer">
        <div className="kv2-card-footer-meta">
          <div>
            <span className="kv2-card-timestamp">Created {formatExactTimestamp(vm.createdAt)}</span>
            {durationLabel && (
              <span className="kv2-card-timestamp kv2-card-timestamp--duration">⏱ {durationLabel}</span>
            )}
            <span className="kv2-card-timestamp kv2-card-timestamp--updated">Updated {formatExactTimestamp(vm.updatedAt)}</span>
          </div>
        </div>

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
