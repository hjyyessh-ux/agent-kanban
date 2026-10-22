import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 8;
const ZOOM_STEP = 1.25;

/** One zoom step in or out from `current`, clamped to [MIN_ZOOM, MAX_ZOOM]. */
export function stepZoom(current: number, direction: 1 | -1): number {
  const next = direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(next * 100) / 100));
}

interface ImageLightboxProps {
  src: string;
  alt: string;
  onClose: () => void;
}

/**
 * Full-screen image preview with zoom. Opens fitted to the screen; `+`/`−`,
 * the wheel, or a double-click zoom in, and a zoomed image pans by dragging.
 *
 * Rendered into `document.body` so it covers the dialog that opened it, and it
 * swallows its own Esc — otherwise the surrounding `DialogSkeleton` would close
 * the whole dialog along with the preview.
 */
export const ImageLightbox: React.FC<ImageLightboxProps> = ({ src, alt, onClose }) => {
  // null = fitted to the screen; a number = that scale of the natural size.
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // Re-render once the natural size is known so the % readout is right.
  const [, setLoaded] = useState(false);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // The fitted scale, so the first zoom step starts from what is on screen.
  const currentScale = useCallback((): number => {
    if (zoom !== null) return zoom;
    const img = imgRef.current;
    if (!img || !img.naturalWidth) return 1;
    return img.clientWidth / img.naturalWidth;
  }, [zoom]);

  const zoomBy = useCallback((direction: 1 | -1) => {
    setZoom(stepZoom(currentScale(), direction));
  }, [currentScale]);

  const fit = useCallback(() => {
    setZoom(null);
    setOffset({ x: 0, y: 0 });
  }, []);

  // React registers wheel listeners as passive, so preventDefault (to keep the
  // page behind from scrolling) needs a native listener.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
  }, [zoomBy]);

  const handlePointerDown = (event: React.PointerEvent<HTMLImageElement>) => {
    if (zoom === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
    setDragging(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setOffset({ x: drag.ox + event.clientX - drag.x, y: drag.oy + event.clientY - drag.y });
  };

  const endDrag = () => {
    dragRef.current = null;
    setDragging(false);
  };

  const handleDoubleClick = () => {
    if (zoom === null) setZoom(Math.max(1, Math.min(MAX_ZOOM, currentScale() * 2)));
    else fit();
  };

  const img = imgRef.current;
  const imgStyle: React.CSSProperties | undefined =
    zoom !== null && img?.naturalWidth
      ? {
          width: img.naturalWidth * zoom,
          maxWidth: 'none',
          maxHeight: 'none',
          transform: `translate(${offset.x}px, ${offset.y}px)`,
          cursor: dragging ? 'grabbing' : 'grab',
        }
      : undefined;

  const percent = Math.round(currentScale() * 100);

  return createPortal(
    <div
      ref={rootRef}
      className="kv2-screenshot-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot preview"
      tabIndex={-1}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className="kv2-screenshot-lightbox-img"
        style={imgStyle}
        draggable={false}
        onLoad={() => setLoaded(true)}
        onDoubleClick={handleDoubleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      />
      <div className="kv2-screenshot-lightbox-toolbar" role="group" aria-label="Zoom">
        <button type="button" onClick={() => zoomBy(-1)} aria-label="Zoom out">−</button>
        <span className="kv2-screenshot-lightbox-zoom" aria-live="polite">{percent}%</span>
        <button type="button" onClick={() => zoomBy(1)} aria-label="Zoom in">+</button>
        <button type="button" onClick={fit} aria-pressed={zoom === null}>화면 맞춤</button>
        <button type="button" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }} aria-pressed={zoom === 1}>
          원본 100%
        </button>
      </div>
      <button type="button" className="kv2-screenshot-lightbox-close" onClick={onClose} aria-label="Close preview">
        ×
      </button>
    </div>,
    document.body,
  );
};
