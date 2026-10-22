import React from 'react';
import type { KanbanCard, Work } from '../../../../src/core/types';
import { WorkPicker } from '../Works/WorkPicker';
import { BOARD_WORKS_COPY } from '../../constants/copy';
import { resolveWorkDrop, type WorkDragSource, type WorkDropTarget } from './board-works';
import { useBoardWorkField } from './board-work-dnd';

/**
 * The board's one Work field — on todo/in-progress cards and on every session
 * group (unassigned or inside a Work), in every group mode, so assigning a
 * Work looks and works the same everywhere (`docs/works.md` ⑦).
 *
 * Two cases, same `WorkPicker`:
 * - **No session yet** (a fresh TODO card): writes `card.plannedWorkId`
 *   through `onSetPlanned` — a plain card PATCH; `work-planned-link.ts` links
 *   it when dispatch gives the card a session.
 * - **Has a session**: resolves the same `link` / `move` / `unlink` (and
 *   `새 Work 만들기` → `create` / `moveToNew`, named from the search box) as
 *   drag & drop via `resolveWorkDrop` and hands it to `onDrop` —
 *   `BoardScreen`'s `runWorkAction` — so notices and undo match dragging.
 * - `새 Work 만들기` on a sessionless card creates an empty Work and reserves
 *   it (`BoardWorkFieldContext.createPlanned`).
 */
export interface BoardCardWorkFieldProps {
  card: Pick<KanbanCard, 'id' | 'sessionId' | 'projectDir' | 'plannedWorkId' | 'status' | 'title' | 'sessionTitle'>;
  /** Active Works — the picker never offers a closed one. */
  works: readonly Work[];
  /** The Work `card.sessionId` already belongs to, if any (`workForCard`/`worksIndex`). */
  linkedWork: Work | undefined;
  onSetPlanned: (cardId: string, workId: string | null) => void | Promise<unknown>;
  onDrop: (source: WorkDragSource, target: WorkDropTarget, title?: string) => void;
}

/** The `resolveWorkDrop` source for a card (or a session group's representative card). */
export function workSourceForCard(card: BoardCardWorkFieldProps['card'], linkedWork: Work | undefined): WorkDragSource {
  return {
    cardId: card.id,
    sessionId: card.sessionId,
    workId: linkedWork?.id,
    status: card.status,
    projectDir: card.projectDir,
    title: card.sessionTitle ?? card.title,
  };
}

/** What selecting `next` in the picker means to do — pure, so it's testable without rendering. */
export type WorkFieldChange =
  | { kind: 'setPlanned'; cardId: string; workId: string | null }
  | { kind: 'drop'; source: WorkDragSource; target: WorkDropTarget };

/**
 * Decides the change for picking `next` in the dropdown, or `null` for a
 * no-op (same value re-selected, or a resolved drop the picker never offers —
 * `create`/`moveToNew`, since "＋ 새 Work" is not one of its options).
 */
export function resolveWorkFieldChange(
  card: BoardCardWorkFieldProps['card'],
  linkedWork: Work | undefined,
  currentValue: string,
  next: string,
): WorkFieldChange | null {
  if (next === currentValue) return null;

  if (!card.sessionId) {
    return { kind: 'setPlanned', cardId: card.id, workId: next === '' ? null : next };
  }

  const source = workSourceForCard(card, linkedWork);
  const target: WorkDropTarget = next === '' ? { kind: 'unassigned' } : { kind: 'work', workId: next };
  const action = resolveWorkDrop(source, target);
  if (!action || action.kind === 'create' || action.kind === 'moveToNew') return null;
  return { kind: 'drop', source, target };
}

export const BoardCardWorkField: React.FC<BoardCardWorkFieldProps> = ({
  card,
  works,
  linkedWork,
  onSetPlanned,
  onDrop,
}) => {
  const planned = !linkedWork && card.plannedWorkId
    ? works.find((work) => work.id === card.plannedWorkId)
    : undefined;
  const current = linkedWork ?? planned;
  const value = current?.id ?? '';
  const isPlanned = !!planned;

  const hint = !current
    ? BOARD_WORKS_COPY.workFieldHintEmpty
    : isPlanned
      ? BOARD_WORKS_COPY.workFieldHintPlanned
      : BOARD_WORKS_COPY.workFieldHintLinked;

  const sessionSource = card.sessionId ? workSourceForCard(card, linkedWork) : null;
  const createPlanned = useBoardWorkField()?.createPlanned;
  const onCreateNew = sessionSource
    ? (name: string) => onDrop(sessionSource, { kind: 'new' }, name)
    : createPlanned
      ? (name: string) => createPlanned(card.id, name, card.projectDir)
      : undefined;

  return (
    <div className={`kv2-card-work-field${isPlanned ? ' is-planned' : ''}${current ? ' is-set' : ''}`}>
      <WorkPicker
        value={value}
        works={works}
        fallbackTitle={linkedWork?.title}
        planned={isPlanned}
        title={hint}
        onCreateNew={onCreateNew}
        onChange={(next) => {
          const change = resolveWorkFieldChange(card, linkedWork, value, next);
          if (!change) return;
          if (change.kind === 'setPlanned') onSetPlanned(change.cardId, change.workId);
          else onDrop(change.source, change.target);
        }}
      />
    </div>
  );
};
