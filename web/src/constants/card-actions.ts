import type { KanbanStatus } from '../../../src/core/types';
import { CARD_ACTION_COPY } from './copy';

/**
 * The status move behind a card's main button. `dispatch` starts a run (the
 * card flips to in_progress later via polling); the others are status writes.
 */
export type CardActionKind = 'start' | 'finish' | 'done' | 'reopen';

export interface CardActionSpec {
  kind: CardActionKind;
  label: string;
  /** `dispatch` for start, otherwise the status the card moves to. */
  target: 'dispatch' | KanbanStatus;
}

export interface CardActionContext {
  /** A pending scheduled dispatch turns `시작` into `지금 시작`. */
  scheduled?: boolean;
  /** Card detail spells the todo button out (`작업 시작`). */
  surface?: 'card' | 'list' | 'detail';
}

/**
 * The one mapping from status to main action, shared by BoardCard
 * (`CardActions`), the List row (`BoardListRowAction`) and Card detail.
 * `finish` (in_progress → complete) and `done` (complete → done) are separate
 * kinds with separate labels — the board used to print `DONE` for both, and
 * the List offered `REOPEN` on in_progress cards.
 */
export function primaryActionFor(status: KanbanStatus, context: CardActionContext = {}): CardActionSpec {
  switch (status) {
    case 'todo': {
      const label = context.scheduled
        ? CARD_ACTION_COPY.startNow
        : context.surface === 'detail' ? CARD_ACTION_COPY.startTask : CARD_ACTION_COPY.start;
      return { kind: 'start', label, target: 'dispatch' };
    }
    case 'in_progress':
      return { kind: 'finish', label: CARD_ACTION_COPY.finish, target: 'complete' };
    case 'complete':
      return { kind: 'done', label: CARD_ACTION_COPY.done, target: 'done' };
    case 'done':
      return { kind: 'reopen', label: CARD_ACTION_COPY.reopen, target: 'todo' };
  }
}

/** The `다시 열기` beside the main action — only while the card is mid-flight or awaiting review. */
export function secondaryActionFor(status: KanbanStatus): CardActionSpec | null {
  if (status === 'in_progress' || status === 'complete') {
    return { kind: 'reopen', label: CARD_ACTION_COPY.reopen, target: 'todo' };
  }
  return null;
}
