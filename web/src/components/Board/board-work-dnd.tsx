import type React from 'react';
import { createContext, useContext } from 'react';
import type { Work } from '../../../../src/core/types';
import {
  WORK_SESSION_DRAG_MIME,
  resolveWorkDrop,
  type WorkDragSource,
  type WorkDropAction,
  type WorkDropTarget,
} from './board-works';

/**
 * `GROUP: WORKS` drag & drop + `⋯ → Work로 이동`, shared by `BoardScreen` (which
 * owns the state and the tray) and the pieces that act as sources or targets:
 * `BoardSessionGroupCard`, `BoardCard` (via `BoardColumn`), `BoardWorkContainer`
 * and the UNASSIGNED zone. `null` outside works mode — consumers then render
 * no drag handlers and no menu, exactly as before.
 *
 * `DataTransfer` is unreadable during `dragover`, so the source lives here in
 * React state; the drag still carries `text/plain` (cardId, the board's
 * existing payload) and `WORK_SESSION_DRAG_MIME` for anything outside the app.
 */
export interface BoardWorkDnD {
  drag: WorkDragSource | null;
  /** Active Works, for the tray and the `⋯` menu. */
  works: readonly Work[];
  /** The active Work a session belongs to. */
  workForSession: (sessionId: string | undefined) => Work | undefined;
  startDrag: (source: WorkDragSource) => void;
  endDrag: () => void;
  /** Act on `target` for `source` — a drop, or a `⋯` menu choice. */
  run: (source: WorkDragSource, target: WorkDropTarget) => void;
}

export const BoardWorkDnDContext = createContext<BoardWorkDnD | null>(null);

export function useBoardWorkDnD(): BoardWorkDnD | null {
  return useContext(BoardWorkDnDContext);
}

/** Write the drag payload. Called synchronously in `dragstart`; the state flip is deferred by the caller. */
export function writeWorkDragData(dataTransfer: DataTransfer, source: WorkDragSource): void {
  dataTransfer.setData('text/plain', source.cardId);
  dataTransfer.setData(WORK_SESSION_DRAG_MIME, JSON.stringify(source));
  dataTransfer.effectAllowed = 'move';
}

const DROP_OVER_CLASS = 'is-drop-over';

/** Clears every drop-over highlight — on dragend, the drag may have left none behind cleanly. */
export function clearDropHighlights(): void {
  document.querySelectorAll(`.${DROP_OVER_CLASS}`).forEach((element) => element.classList.remove(DROP_OVER_CLASS));
}

/**
 * Handlers that make an element a Works drop target. A drop with no Works
 * meaning (`resolveWorkDrop` → null) is left alone: no `preventDefault`, so the
 * browser refuses it and the board's own handlers keep their meaning.
 * Highlighting toggles a class (no re-render, no layout: outline/overlay only).
 */
export function workDropTargetProps(
  dnd: BoardWorkDnD | null,
  target: WorkDropTarget,
): Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> {
  if (!dnd?.drag) return {};
  const source = dnd.drag;
  const action: WorkDropAction | null = resolveWorkDrop(source, target);
  if (!action) return {};

  return {
    onDragOver: (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      event.currentTarget.classList.add(DROP_OVER_CLASS);
    },
    onDragLeave: (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      event.currentTarget.classList.remove(DROP_OVER_CLASS);
    },
    onDrop: (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove(DROP_OVER_CLASS);
      dnd.run(source, target);
      dnd.endDrag();
    },
  };
}
