import React, { useEffect, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import { ActionSpinner } from './BoardCardSections';

interface BoardListRowActionProps {
  card: KanbanCard;
  onStatusChange?: (card: KanbanCard, newStatus: KanbanStatus) => void;
  onDispatch?: (card: KanbanCard) => void | Promise<void>;
}

export interface RowActionConfig {
  label: 'START' | 'REOPEN' | 'DONE';
  run?: () => void | Promise<void>;
  styleClass: string;
}

export function getRowActionConfig(
  card: KanbanCard,
  onStatusChange?: (card: KanbanCard, newStatus: KanbanStatus) => void,
  onDispatch?: (card: KanbanCard) => void | Promise<void>,
): RowActionConfig | null {
  if (card.parentCardId) return null;

  if (card.status === 'todo') {
    return {
      label: 'START',
      run: onDispatch ? () => onDispatch(card) : undefined,
      styleClass: 'kv2-card-action--start',
    };
  }

  if (card.status === 'in_progress') {
    return {
      label: 'REOPEN',
      run: onStatusChange ? () => onStatusChange(card, 'todo') : undefined,
      styleClass: 'kv2-card-action--secondary',
    };
  }

  if (card.status === 'complete') {
    return {
      label: 'DONE',
      run: onStatusChange ? () => onStatusChange(card, 'done') : undefined,
      styleClass: 'kv2-card-action--done',
    };
  }

  return {
    label: 'REOPEN',
    run: onStatusChange ? () => onStatusChange(card, 'todo') : undefined,
    styleClass: 'kv2-card-action--secondary',
  };
}

export const BoardListRowAction: React.FC<BoardListRowActionProps> = ({
  card,
  onStatusChange,
  onDispatch,
}) => {
  const [pending, setPending] = useState(false);
  const action = getRowActionConfig(card, onStatusChange, onDispatch);
  const isStart = action?.label === 'START';

  // START only *initiates* a dispatch; the card flips to in_progress later via
  // polling. Hold the spinner until the status actually leaves `todo` so the
  // button doesn't flash back to "START" in the gap. Other actions (REOPEN/
  // DONE) update optimistically, so they reset as soon as run() resolves.
  useEffect(() => {
    if (!pending || !isStart) return;
    if (card.status !== 'todo') {
      setPending(false);
      return;
    }
    const timer = setTimeout(() => setPending(false), 30000);
    return () => clearTimeout(timer);
  }, [pending, isStart, card.status]);

  if (!action) return null;

  const run = action.run;
  const showSpinner = pending && action.label === 'START';

  return (
    <button
      type="button"
      className={`kv2-card-action kv2-list-action-btn ${action.styleClass}`}
      onClick={async (event) => {
        event.stopPropagation();
        if (pending || !run) return;
        setPending(true);
        try {
          await run();
          // For START, keep the spinner until the status transitions (handled
          // by the effect above); other actions reset immediately.
          if (action.label !== 'START') setPending(false);
        } catch {
          setPending(false);
        }
      }}
      disabled={!run || pending}
      aria-busy={pending}
    >
      {showSpinner ? (
        <>
          <ActionSpinner /> {action.label}
        </>
      ) : (
        action.label
      )}
    </button>
  );
};
