import React, { useEffect, useState } from 'react';
import type { KanbanCard, KanbanStatus } from '../../../../src/core/types';
import { ActionSpinner } from './BoardCardSections';
import { primaryActionFor, type CardActionKind } from '../../constants/card-actions';

interface BoardListRowActionProps {
  card: KanbanCard;
  onStatusChange?: (card: KanbanCard, newStatus: KanbanStatus) => void;
  onDispatch?: (card: KanbanCard) => void | Promise<void>;
}

export interface RowActionConfig {
  kind: CardActionKind;
  label: string;
  run?: () => void | Promise<void>;
  styleClass: string;
}

const ROW_ACTION_STYLE: Record<CardActionKind, string> = {
  start: 'kv2-card-action--start',
  finish: 'kv2-card-action--finish',
  done: 'kv2-card-action--done',
  reopen: 'kv2-card-action--secondary',
};

/** The List row shows only the card's main action — same mapping as BoardCard and Card detail. */
export function getRowActionConfig(
  card: KanbanCard,
  onStatusChange?: (card: KanbanCard, newStatus: KanbanStatus) => void,
  onDispatch?: (card: KanbanCard) => void | Promise<void>,
): RowActionConfig | null {
  if (card.parentCardId) return null;

  const action = primaryActionFor(card.status, {
    scheduled: card.scheduledDispatch?.status === 'scheduled',
    surface: 'list',
  });
  const { target } = action;
  const run = target === 'dispatch'
    ? (onDispatch ? () => onDispatch(card) : undefined)
    : (onStatusChange ? () => onStatusChange(card, target) : undefined);

  return { kind: action.kind, label: action.label, run, styleClass: ROW_ACTION_STYLE[action.kind] };
}

export const BoardListRowAction: React.FC<BoardListRowActionProps> = ({
  card,
  onStatusChange,
  onDispatch,
}) => {
  const [pending, setPending] = useState(false);
  const action = getRowActionConfig(card, onStatusChange, onDispatch);
  const isStart = action?.kind === 'start';

  // Start only *initiates* a dispatch; the card flips to in_progress later via
  // polling. Hold the spinner until the status actually leaves `todo` so the
  // button doesn't flash back to "시작" in the gap. Status moves (finish/done/
  // reopen) update optimistically, so they reset as soon as run() resolves.
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
  const showSpinner = pending && isStart;

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
          // For start, keep the spinner until the status transitions (handled
          // by the effect above); other actions reset immediately.
          if (!isStart) setPending(false);
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
