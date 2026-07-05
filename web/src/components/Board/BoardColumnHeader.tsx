import React from 'react';
import type { KanbanStatus } from '../../../../src/core/types';

const WIP_LIMIT = 3;

interface BoardColumnHeaderProps {
  status: KanbanStatus;
  label: string;
  count: number;
  actionableCount?: number;
  hideAllSessionsLabel?: string;
  onHideAllSessions?: () => void;
  onCompleteAll?: () => void;
  onArchive?: () => void;
}

export const BoardColumnHeader: React.FC<BoardColumnHeaderProps> = ({
  status,
  label,
  count,
  actionableCount,
  hideAllSessionsLabel = 'Hide All',
  onHideAllSessions,
  onCompleteAll,
  onArchive,
}) => {
  const isWipOver = status === 'in_progress' && count > WIP_LIMIT;
  const isWipWarning = status === 'in_progress' && count === WIP_LIMIT;
  const bulkActionCount = actionableCount ?? count;

  return (
    <div className="kv2-column-header" data-status={status}>
      <div className="kv2-column-header-left">
        <span className="kv2-column-label">{label}</span>
        <span className="kv2-column-count">{count}</span>
        {status === 'in_progress' && (
          <span
            className={`kv2-wip${isWipOver ? ' kv2-wip--over' : isWipWarning ? ' kv2-wip--warning' : ''}`}
          >
            {count}/{WIP_LIMIT}
          </span>
        )}
      </div>
      <div className="kv2-column-header-right">
        {status === 'complete' && onHideAllSessions && count > 0 && (
          <button
            type="button"
            className="kv2-column-action"
            onClick={() => {
              onHideAllSessions();
            }}
          >
            {hideAllSessionsLabel}
          </button>
        )}
        {status === 'complete' && onCompleteAll && bulkActionCount > 0 && (
          <button
            type="button"
            className="kv2-column-action"
            onClick={() => {
              onCompleteAll();
            }}
          >
            Done All
          </button>
        )}
        {status === 'done' && onArchive && bulkActionCount > 0 && (
          <button
            type="button"
            className="kv2-column-action"
            onClick={() => {
              onArchive();
            }}
          >
            Archive All
          </button>
        )}
      </div>
    </div>
  );
};
