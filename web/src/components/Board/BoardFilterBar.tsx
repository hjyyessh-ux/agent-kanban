import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { usePersistedDialogSize } from '../../hooks/usePersistedDialogSize';
import type { BoardFilters } from './board-filters';

type DateInputWithPicker = HTMLInputElement & { showPicker?: () => void };

interface FilterOptionItem {
  value: string;
  meta?: string;
}

interface BoardFilterBarProps {
  cards: KanbanCard[];
  filters: BoardFilters;
  onFiltersChange: (next: BoardFilters) => void;
  onFiltersReset: () => void;
}

function getCardRecency(card: KanbanCard): number {
  const updated = Date.parse(card.updatedAt);
  if (!Number.isNaN(updated)) {
    return updated;
  }

  const created = Date.parse(card.createdAt);
  if (!Number.isNaN(created)) {
    return created;
  }

  return 0;
}

function sortByRecencyThenLabel<T extends { value: string; recency: number }>(
  entries: T[],
): T[] {
  return entries
    .sort((left, right) => {
      if (right.recency !== left.recency) {
        return right.recency - left.recency;
      }

      return left.value.localeCompare(right.value);
    });
}

function formatFilterDateLabel(card: KanbanCard): string {
  const updated = Date.parse(card.updatedAt);
  if (!Number.isNaN(updated)) {
    return `Updated ${new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(updated)}`;
  }

  const created = Date.parse(card.createdAt);
  if (!Number.isNaN(created)) {
    return `Created ${new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(created)}`;
  }

  return 'Date unavailable';
}

function getLatestSessionIdOptions(cards: KanbanCard[]): FilterOptionItem[] {
  const bySessionId = new Map<string, number>();

  for (const card of cards) {
    const sessionId = card.sessionId?.trim();
    if (!sessionId) {
      continue;
    }

    const recency = getCardRecency(card);
    const current = bySessionId.get(sessionId) ?? -1;
    if (recency > current) {
      bySessionId.set(sessionId, recency);
    }
  }

  return sortByRecencyThenLabel(
    Array.from(bySessionId.entries(), ([value, recency]) => ({ value, recency })),
  ).map(({ value }) => ({ value }));
}

function getLatestSessionNameOptions(cards: KanbanCard[]): FilterOptionItem[] {
  const bySessionId = new Map<string, { value: string; recency: number; meta: string }>();
  const fallbackByName = new Map<string, { recency: number; meta: string }>();

  for (const card of cards) {
    const sessionTitle = card.sessionTitle?.trim();
    if (!sessionTitle) {
      continue;
    }

    const recency = getCardRecency(card);
    const sessionId = card.sessionId?.trim();

    if (sessionId) {
      const current = bySessionId.get(sessionId);
      if (!current || recency > current.recency) {
        bySessionId.set(sessionId, { value: sessionTitle, recency, meta: formatFilterDateLabel(card) });
      }
      continue;
    }

    const currentFallback = fallbackByName.get(sessionTitle);
    if (!currentFallback || recency > currentFallback.recency) {
      fallbackByName.set(sessionTitle, { recency, meta: formatFilterDateLabel(card) });
    }
  }

  const dedupedByName = new Map<string, { recency: number; meta: string }>();

  for (const entry of bySessionId.values()) {
    const current = dedupedByName.get(entry.value);
    if (!current || entry.recency > current.recency) {
      dedupedByName.set(entry.value, { recency: entry.recency, meta: entry.meta });
    }
  }

  for (const [value, entry] of fallbackByName.entries()) {
    const current = dedupedByName.get(value);
    if (!current || entry.recency > current.recency) {
      dedupedByName.set(value, entry);
    }
  }

  return sortByRecencyThenLabel(
    Array.from(dedupedByName.entries(), ([value, entry]) => ({ value, recency: entry.recency, meta: entry.meta })),
  ).map(({ value, meta }) => ({ value, meta }));
}

function getActiveFilterCount(filters: BoardFilters): number {
  return Object.entries(filters)
    .filter(([key]) => key !== 'directory')
    .filter(([, value]) => value.trim().length > 0)
    .length;
}

function renderOptionList(
  options: FilterOptionItem[],
  selectedValue: string,
  onSelect: (value: string) => void,
  emptyText: string,
) {
  if (options.length === 0) {
    return <div className="kv2-filter-empty">{emptyText}</div>;
  }

  return options.map((option) => (
    <button
      key={option.value}
      type="button"
      className={`kv2-filter-option${selectedValue === option.value ? ' is-selected' : ''}`}
      aria-pressed={selectedValue === option.value}
      title={option.meta ? `${option.value} · ${option.meta}` : option.value}
      onClick={() => onSelect(selectedValue === option.value ? '' : option.value)}
    >
      <span className="kv2-filter-option-text">{option.value}</span>
      {option.meta && <span className="kv2-filter-option-meta">{option.meta}</span>}
    </button>
  ));
}

export const BoardFilterBar: React.FC<BoardFilterBarProps> = ({
  cards,
  filters,
  onFiltersChange,
  onFiltersReset,
}) => {
  const [open, setOpen] = useState(false);
  const [sessionIdExpanded, setSessionIdExpanded] = useState(false);
  const anchorRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const activeCount = useMemo(() => getActiveFilterCount(filters), [filters]);
  const summary = activeCount === 0
    ? 'No filters applied'
    : `${activeCount} filter${activeCount > 1 ? 's' : ''} active`;

  usePersistedDialogSize(
    typeof window === 'undefined' ? undefined : 'kanban-board-filter-popover-size',
    panelRef,
    { width: 640, height: 620 },
  );

  const topLevelSessionCards = useMemo(
    () => cards.filter((card) => !card.parentCardId),
    [cards],
  );

  const sessionNameOptions = useMemo(
    () => getLatestSessionNameOptions(topLevelSessionCards),
    [topLevelSessionCards],
  );
  const sessionIdOptions = useMemo(
    () => getLatestSessionIdOptions(topLevelSessionCards),
    [topLevelSessionCards],
  );

  const update = <K extends keyof BoardFilters>(key: K, value: BoardFilters[K]) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const openDatePicker = (event: React.MouseEvent<HTMLInputElement>) => {
    const input = event.currentTarget as DateInputWithPicker;

    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker();
        return;
      } catch {
      }
    }
    input.focus();
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }

      if (anchorRef.current?.contains(target)) {
        return;
      }

      setOpen(false);
    };

    window.addEventListener('pointerdown', handlePointerDown);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [open]);

  const startResize = (
    direction: 'left' | 'right',
    event: React.MouseEvent<HTMLDivElement>,
  ) => {
    const panel = panelRef.current;
    if (!panel) return;

    event.preventDefault();

    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = panel.offsetWidth;
    const startHeight = panel.offsetHeight;

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const nextHeight = Math.max(320, startHeight + dy);

      if (direction === 'left') {
        const nextWidth = Math.max(360, startWidth - dx);
        panel.style.width = `${nextWidth}px`;
        panel.style.height = `${nextHeight}px`;
        return;
      }

      const nextWidth = Math.max(360, startWidth + dx);
      panel.style.width = `${nextWidth}px`;
      panel.style.height = `${nextHeight}px`;
    };

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  };

  return (
    <section ref={anchorRef} className="kv2-filter-anchor" aria-label="Board filters">
      <button
        type="button"
        className={`kv2-filter-trigger${open ? ' is-open' : ''}${activeCount > 0 ? ' is-active' : ''}`}
        aria-expanded={open}
        aria-controls="kv2-filter-panel"
        onClick={() => setOpen((previous) => !previous)}
      >
        <span className="kv2-filter-trigger-icon" aria-hidden="true">☰</span>
        <span>Filter{activeCount > 0 ? ` (${activeCount})` : ''}</span>
        {activeCount > 0 && <span className="kv2-filter-trigger-badge" aria-hidden="true">ON</span>}
      </button>

      {open && (
        <section
          id="kv2-filter-panel"
          ref={panelRef}
          className="kv2-filter-popover kv2-filter-popover--resizable"
          aria-label="Filter cards"
        >
          <div className="kv2-filter-popover-header">
            <div>
              <p className="kv2-filter-eyebrow">Board tools</p>
              <h3 className="kv2-filter-popover-title">Filter cards</h3>
            </div>
            <button type="button" className="kv2-filter-close" aria-label="Close filters" onClick={() => setOpen(false)}>
              ×
            </button>
          </div>

          <div className="kv2-filter-popover-body">
            <div className="kv2-filter-panel-grid">
              <section className="kv2-filter-card kv2-filter-card--search">
                <label className="kv2-filter-field" htmlFor="board-filter-search">
                  <span className="kv2-filter-label">Keyword</span>
                  <input
                    id="board-filter-search"
                    className="kv2-filter-input"
                    type="search"
                    aria-label="Search cards"
                    placeholder="Title, description, progress, result"
                    value={filters.search}
                    onChange={(event) => update('search', event.target.value)}
                  />
                </label>
              </section>

              <fieldset className="kv2-filter-section kv2-filter-card">
                <legend className="kv2-filter-label">Session Name</legend>
                <div className="kv2-filter-checklist">
                  {renderOptionList(
                    sessionNameOptions,
                    filters.sessionName,
                    (value) => update('sessionName', value),
                    'No session names available yet.',
                  )}
                </div>
              </fieldset>

              <section className="kv2-filter-section kv2-filter-card" aria-labelledby="board-filter-session-id-label">
                <div className="kv2-filter-section-header">
                  <span id="board-filter-session-id-label" className="kv2-filter-label">Session ID</span>
                  <button
                    type="button"
                    className="kv2-filter-section-toggle"
                    aria-expanded={sessionIdExpanded}
                    onClick={() => setSessionIdExpanded((previous) => !previous)}
                  >
                    {sessionIdExpanded ? '▾ hide' : '▸ show'}
                  </button>
                </div>
                {sessionIdExpanded && (
                  <div className="kv2-filter-checklist">
                    {renderOptionList(
                      sessionIdOptions,
                      filters.sessionId,
                      (value) => update('sessionId', value),
                      'No session IDs available yet.',
                    )}
                  </div>
                )}
              </section>

              <fieldset className="kv2-filter-section kv2-filter-card">
                <legend className="kv2-filter-label">Created</legend>
                <div className="kv2-filter-date-grid">
                  <label className="kv2-filter-field kv2-filter-date-field" htmlFor="board-filter-created-from">
                    <span className="kv2-filter-date-label">From</span>
                    <input
                      id="board-filter-created-from"
                      className="kv2-filter-input kv2-filter-date"
                      type="date"
                      aria-label="Filter created from date"
                      value={filters.createdFrom}
                      onClick={openDatePicker}
                      onChange={(event) => update('createdFrom', event.target.value)}
                    />
                  </label>
                  <label className="kv2-filter-field kv2-filter-date-field" htmlFor="board-filter-created-to">
                    <span className="kv2-filter-date-label">To</span>
                    <input
                      id="board-filter-created-to"
                      className="kv2-filter-input kv2-filter-date"
                      type="date"
                      aria-label="Filter created to date"
                      value={filters.createdTo}
                      onClick={openDatePicker}
                      onChange={(event) => update('createdTo', event.target.value)}
                    />
                  </label>
                </div>
              </fieldset>

              <fieldset className="kv2-filter-section kv2-filter-card">
                <legend className="kv2-filter-label">Updated</legend>
                <div className="kv2-filter-date-grid">
                  <label className="kv2-filter-field kv2-filter-date-field" htmlFor="board-filter-updated-from">
                    <span className="kv2-filter-date-label">From</span>
                    <input
                      id="board-filter-updated-from"
                      className="kv2-filter-input kv2-filter-date"
                      type="date"
                      aria-label="Filter updated from date"
                      value={filters.updatedFrom}
                      onClick={openDatePicker}
                      onChange={(event) => update('updatedFrom', event.target.value)}
                    />
                  </label>
                  <label className="kv2-filter-field kv2-filter-date-field" htmlFor="board-filter-updated-to">
                    <span className="kv2-filter-date-label">To</span>
                    <input
                      id="board-filter-updated-to"
                      className="kv2-filter-input kv2-filter-date"
                      type="date"
                      aria-label="Filter updated to date"
                      value={filters.updatedTo}
                      onClick={openDatePicker}
                      onChange={(event) => update('updatedTo', event.target.value)}
                    />
                  </label>
                </div>
              </fieldset>

              <div className="kv2-filter-actions kv2-filter-card kv2-filter-card--actions">
                <span className="kv2-filter-summary" aria-live="polite">{summary}</span>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--outline kv2-btn--small"
                  onClick={onFiltersReset}
                >
                  Reset filters
                </button>
              </div>
            </div>
          </div>

          <div
            className="kv2-filter-resize-handle kv2-filter-resize-handle--left"
            onMouseDown={(event) => startResize('left', event)}
            aria-hidden="true"
          />
          <div
            className="kv2-filter-resize-handle kv2-filter-resize-handle--right"
            onMouseDown={(event) => startResize('right', event)}
            aria-hidden="true"
          />
        </section>
      )}
    </section>
  );
};
