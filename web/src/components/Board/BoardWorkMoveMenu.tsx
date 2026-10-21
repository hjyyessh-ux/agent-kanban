import React from 'react';
import { BoardColumnMenu, type BoardColumnMenuItem } from './BoardColumnMenu';
import { useBoardWorkDnD } from './board-work-dnd';
import { resolveWorkDrop, type WorkDragSource, type WorkDropTarget } from './board-works';
import { BOARD_WORKS_COPY } from '../../constants/copy';

/**
 * `⋯ → Work로 이동` — the keyboard path for everything the drag does: every
 * other active Work, `＋ 새 Work 만들어 넣기…`, `⊘ Work에서 빼기`. Built on
 * `BoardColumnMenu` (WorkSessionMenu's keyboard pattern). Items come from the
 * same `resolveWorkDrop`, minus the column rule — a menu has no column.
 *
 * Wrapped so its clicks and keys never reach the session header / card behind
 * it: React bubbles portal events through the component tree.
 */
export const BoardWorkMoveMenu: React.FC<{ source: WorkDragSource }> = ({ source }) => {
  const dnd = useBoardWorkDnD();
  if (!dnd || !source.sessionId) return null;

  const items: BoardColumnMenuItem[] = [];
  const add = (id: string, label: string, target: WorkDropTarget) => {
    if (resolveWorkDrop(source, target)) items.push({ id, label, onSelect: () => dnd.run(source, target) });
  };
  for (const work of dnd.works) add(`work-${work.id}`, BOARD_WORKS_COPY.moveTo(work.title), { kind: 'work', workId: work.id });
  add('new', BOARD_WORKS_COPY.moveNew, { kind: 'new' });
  add('out', BOARD_WORKS_COPY.moveOut, { kind: 'unassigned' });

  return (
    <span
      className="kv2-work-move-menu"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <BoardColumnMenu
        columnLabel={source.title}
        menuLabel={BOARD_WORKS_COPY.moveMenuLabel(source.title)}
        items={items}
      />
    </span>
  );
};
