import type React from 'react';
import { createContext, useContext, useSyncExternalStore } from 'react';
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
  /** Active Works, for the tray. */
  works: readonly Work[];
  /** The active Work a session belongs to. */
  workForSession: (sessionId: string | undefined) => Work | undefined;
  startDrag: (source: WorkDragSource) => void;
  endDrag: () => void;
  /** Act on `target` for `source` — a drop, or a Work field choice. `title` names a `new` target up front (else a name dialog asks). */
  run: (source: WorkDragSource, target: WorkDropTarget, title?: string) => void;
}

export const BoardWorkDnDContext = createContext<BoardWorkDnD | null>(null);

/**
 * What a session group's Work field needs, in **every** group mode (the DnD
 * context above exists only in `GROUP: WORKS`). `null` until Works load or
 * without `workMutations` — the field is then not drawn.
 */
export interface BoardWorkField {
  works: readonly Work[];
  workForSession: (sessionId: string | undefined) => Work | undefined;
  run: (source: WorkDragSource, target: WorkDropTarget, title?: string) => void;
  /** Sessionless card: create an empty Work named `title` and reserve it (`plannedWorkId`). */
  createPlanned: (cardId: string, title: string, projectDir: string | undefined) => void;
}

export const BoardWorkFieldContext = createContext<BoardWorkField | null>(null);

export function useBoardWorkField(): BoardWorkField | null {
  return useContext(BoardWorkFieldContext);
}

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

/**
 * The drop target under the pointer, for the tray's `놓으면 → …` label. A tiny
 * external store so only the tray re-renders while a drag moves — the board
 * itself must not (see the class-toggle highlight below).
 */
let hoveredTarget: WorkDropTarget | null = null;
const hoverListeners = new Set<() => void>();

export function dropTargetKey(target: WorkDropTarget): string {
  if (target.kind === 'work') return `work:${target.workId}:${target.status ?? ''}`;
  if (target.kind === 'unassigned') return `unassigned:${target.status ?? ''}`;
  return 'new';
}

export function setDropHover(target: WorkDropTarget | null): void {
  if (target === hoveredTarget) return;
  if (target && hoveredTarget && dropTargetKey(target) === dropTargetKey(hoveredTarget)) return;
  hoveredTarget = target;
  hoverListeners.forEach((listener) => listener());
}

/** Clears the hover only if `target` is still the one under the pointer — a leave can arrive after the next target's dragover. */
export function clearDropHover(target: WorkDropTarget): void {
  if (hoveredTarget && dropTargetKey(hoveredTarget) === dropTargetKey(target)) setDropHover(null);
}

export function getDropHover(): WorkDropTarget | null {
  return hoveredTarget;
}

function subscribeDropHover(listener: () => void): () => void {
  hoverListeners.add(listener);
  return () => hoverListeners.delete(listener);
}

export function useDropHover(): WorkDropTarget | null {
  return useSyncExternalStore(subscribeDropHover, getDropHover, getDropHover);
}

/** Clears every drop-over highlight — on dragend, the drag may have left none behind cleanly. */
export function clearDropHighlights(): void {
  document.querySelectorAll(`.${DROP_OVER_CLASS}`).forEach((element) => element.classList.remove(DROP_OVER_CLASS));
  setDropHover(null);
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
      setDropHover(target);
    },
    onDragLeave: (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      event.currentTarget.classList.remove(DROP_OVER_CLASS);
      clearDropHover(target);
    },
    onDrop: (event) => {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.classList.remove(DROP_OVER_CLASS);
      setDropHover(null);
      dnd.run(source, target);
      dnd.endDrag();
    },
  };
}
