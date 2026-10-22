import React from 'react';
import type { CreateWorkInput, KanbanCard, UpdateCardInput, Work } from '../../../../src/core/types';
import { WorkPicker } from '../Works/WorkPicker';
import { CARD_WORK_COPY } from '../../constants/copy';

export interface CardWorkLineProps {
  card: Pick<KanbanCard, 'id' | 'sessionId' | 'plannedWorkId'> & { projectDir?: string };
  /** Every Work (any status) — a session may belong to one that has since closed. */
  works: readonly Work[];
  isTodo: boolean;
  canEdit: boolean;
  onUpdate?: (id: string, updates: UpdateCardInput) => void;
  /** `새 Work 만들기` in the picker: create a Work named after the search text, then reserve it. */
  onCreateWork?: (input: CreateWorkInput) => Promise<Work>;
}

export type CardWorkLineState =
  | { kind: 'planned-editable'; value: string }
  | { kind: 'linked'; work: Work }
  | { kind: 'none' };

/**
 * What the line shows. Editable only before dispatch (todo, no session):
 * that is when `plannedWorkId` is a plain card field. Once a session exists
 * its Work follows the session — changed from the board's Work field, where
 * link / move / unlink run with notices and undo.
 */
export function resolveCardWorkLine(
  card: CardWorkLineProps['card'],
  works: readonly Work[],
  isTodo: boolean,
  canEdit: boolean,
): CardWorkLineState {
  if (card.sessionId) {
    const linked = works.find((work) => work.sessionLinks.some((link) => link.sessionId === card.sessionId));
    return linked ? { kind: 'linked', work: linked } : { kind: 'none' };
  }
  if (isTodo && canEdit) return { kind: 'planned-editable', value: card.plannedWorkId ?? '' };
  return { kind: 'none' };
}

/**
 * Card detail's "belongs to" line, directly under the title. Work is the
 * card's context, not one of its run settings, so it sits above the
 * RUNTIME / MODEL / PERMISSION / DIRECTORY tiles instead of among them.
 */
export const CardWorkLine: React.FC<CardWorkLineProps> = ({ card, works, isTodo, canEdit, onUpdate, onCreateWork }) => {
  const state = resolveCardWorkLine(card, works, isTodo, canEdit);
  const activeWorks = works.filter((work) => work.status === 'active');

  return (
    <div className="kv2-detail-work-line">
      {state.kind === 'planned-editable' ? (
        <WorkPicker
          variant="line"
          value={state.value}
          fallbackTitle={works.find((work) => work.id === state.value)?.title}
          works={activeWorks}
          planned
          boundarySelector=".kv2-dialog"
          title={state.value ? CARD_WORK_COPY.plannedHint : CARD_WORK_COPY.emptyHint}
          onChange={(next) => onUpdate?.(card.id, { plannedWorkId: next || null })}
          onCreateNew={onCreateWork && onUpdate
            ? (name) => {
              // A failed create is already on the Works error alert; the line just stays as it was.
              onCreateWork({ title: name, projectDir: card.projectDir || undefined })
                .then((work) => onUpdate(card.id, { plannedWorkId: work.id }))
                .catch(() => undefined);
            }
            : undefined}
        />
      ) : (
        <WorkPicker
          variant="line"
          value={state.kind === 'linked' ? state.work.id : ''}
          fallbackTitle={state.kind === 'linked' ? state.work.title : undefined}
          works={activeWorks}
          disabled
          title={state.kind === 'linked' ? CARD_WORK_COPY.linkedHint : CARD_WORK_COPY.readOnlyHint}
          onChange={() => undefined}
        />
      )}
    </div>
  );
};
