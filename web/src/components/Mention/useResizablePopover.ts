import React, { useCallback, useRef, useState } from 'react';

/**
 * `@` 팝오버 오른쪽 아래 리사이즈 핸들.
 *
 * 네이티브 `resize: both`를 쓰지 않는 이유: 팝오버 루트가 textarea 포커스를
 * 지키려고 `mousedown`을 `preventDefault`하는데, 그러면 브라우저 리사이즈 그립도
 * 같이 죽는다. 그래서 포인터 이벤트로 직접 잰다(포인터 캡처라 팝오버 밖으로
 * 끌어도 놓치지 않는다).
 *
 * 크기는 localStorage에 남긴다 — 팝오버는 열 때마다 새로 마운트되므로, 기억하지
 * 않으면 매번 520px로 돌아온다. 핸들 더블클릭은 기본 크기로 되돌린다.
 */

const STORAGE_KEY = 'kanban-mention-popover-size';
const MIN_WIDTH = 360;
const MIN_HEIGHT = 220;
/** 뷰포트 가장자리 여백 — 끌어서 화면 밖으로 내보내지 못하게. */
const VIEWPORT_MARGIN = 8;

export interface PopoverSize {
  width: number;
  height: number;
}

function readSize(): PopoverSize | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PopoverSize>;
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return {
        width: Math.max(MIN_WIDTH, Math.min(parsed.width, window.innerWidth - 2 * VIEWPORT_MARGIN)),
        height: Math.max(MIN_HEIGHT, Math.min(parsed.height, window.innerHeight - 2 * VIEWPORT_MARGIN)),
      };
    }
  } catch { /* 손상된 값은 기본 크기로 */ }
  return null;
}

function writeSize(size: PopoverSize | null): void {
  try {
    if (size) localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* quota 등 — 기억 못 해도 동작은 한다 */ }
}

export interface ResizablePopover {
  /** null이면 CSS 기본 크기(520px · 내용 높이). */
  size: PopoverSize | null;
  handleProps: {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => void;
    onDoubleClick: () => void;
  };
}

export function useResizablePopover(
  popoverRef: React.RefObject<HTMLDivElement | null>,
): ResizablePopover {
  const [size, setSize] = useState<PopoverSize | null>(() =>
    typeof window === 'undefined' ? null : readSize(),
  );
  const drag = useRef<{ x: number; y: number; width: number; height: number; left: number; top: number } | null>(null);
  const latest = useRef<PopoverSize | null>(size);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const element = popoverRef.current;
    if (!element || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = element.getBoundingClientRect();
    drag.current = { x: e.clientX, y: e.clientY, width: rect.width, height: rect.height, left: rect.left, top: rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [popoverRef]);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLElement>) => {
    const start = drag.current;
    if (!start) return;
    const maxWidth = window.innerWidth - start.left - VIEWPORT_MARGIN;
    const maxHeight = window.innerHeight - start.top - VIEWPORT_MARGIN;
    const next = {
      width: Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, start.width + e.clientX - start.x))),
      height: Math.round(Math.max(MIN_HEIGHT, Math.min(maxHeight, start.height + e.clientY - start.y))),
    };
    latest.current = next;
    setSize(next);
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLElement>) => {
    if (!drag.current) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    writeSize(latest.current);
  }, []);

  const onDoubleClick = useCallback(() => {
    latest.current = null;
    setSize(null);
    writeSize(null);
  }, []);

  return {
    size,
    handleProps: { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onDoubleClick },
  };
}
