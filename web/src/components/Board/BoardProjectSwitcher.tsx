import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { dirAccentClass } from '../../utils/project-color';
import { useAnchoredPopover, MetaPopoverPortal } from '../Card/MetaDropdown';
import {
  buildDirectoryOptions,
  buildDirectoryTotals,
  filterDirectoryOptions,
  formatActivityAge,
  formatDirectoryCountBreakdown,
  splitDirectoryOptions,
  type DirectoryOption,
} from './directory-display';

interface BoardProjectSwitcherProps {
  cards: KanbanCard[];
  selectedDirectory: string;
  onDirectoryChange: (directory: string) => void;
}

interface ChipMeasurements {
  widths: number[];
  available: number;
  gap: number;
  moreWidth: number;
}

const UNMEASURED: ChipMeasurements = {
  widths: [],
  available: Number.POSITIVE_INFINITY,
  gap: 0,
  moreWidth: 0,
};

function chipTitle(option: DirectoryOption): string {
  return `${option.value}\n${formatDirectoryCountBreakdown(option)}`;
}

/**
 * The board's project bar: `All`, as many project chips as fit on one line,
 * and a `+N More ▾` search dropdown for the rest.
 *
 * Fitting is measured, not guessed: a hidden copy of every chip (and the More
 * trigger) is laid out off-screen, a `ResizeObserver` watches the bar, and the
 * pure `splitDirectoryOptions` decides the visible prefix. The selected chip
 * always stays on the bar.
 */
export const BoardProjectSwitcher: React.FC<BoardProjectSwitcherProps> = ({
  cards,
  selectedDirectory,
  onDirectoryChange,
}) => {
  const options = useMemo(() => buildDirectoryOptions(cards), [cards]);
  const totals = useMemo(() => buildDirectoryTotals(cards), [cards]);
  const navRef = useRef<HTMLElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [measurements, setMeasurements] = useState<ChipMeasurements>(UNMEASURED);

  useLayoutEffect(() => {
    const nav = navRef.current;
    const measure = measureRef.current;
    if (!nav || !measure) return;

    const update = () => {
      const style = getComputedStyle(nav);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const inner = nav.clientWidth
        - (Number.parseFloat(style.paddingLeft) || 0)
        - (Number.parseFloat(style.paddingRight) || 0);
      const widthOf = (selector: string) =>
        measure.querySelector<HTMLElement>(selector)?.getBoundingClientRect().width ?? 0;
      const widths = Array.from(
        measure.querySelectorAll<HTMLElement>('[data-measure="option"]'),
        (chip) => chip.getBoundingClientRect().width,
      );
      setMeasurements({
        widths,
        available: inner - widthOf('[data-measure="all"]'),
        gap,
        moreWidth: widthOf('[data-measure="more"]'),
      });
    };

    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [options]);

  const { visible, overflow } = useMemo(
    () => splitDirectoryOptions(options, { ...measurements, selected: selectedDirectory }),
    [options, measurements, selectedDirectory],
  );

  if (options.length === 0) {
    return null;
  }

  const allTitle = `All projects\n${formatDirectoryCountBreakdown(totals)}`;
  const renderChip = (option: DirectoryOption, measureOnly = false) => {
    const isSelected = selectedDirectory === option.value;
    return (
      <button
        key={option.value}
        type="button"
        className={`app-project-chip is-tinted ${dirAccentClass(option.value)}${isSelected ? ' is-selected' : ''}`}
        aria-pressed={measureOnly ? undefined : isSelected}
        title={chipTitle(option)}
        tabIndex={measureOnly ? -1 : undefined}
        data-measure={measureOnly ? 'option' : undefined}
        onClick={measureOnly ? undefined : () => onDirectoryChange(isSelected ? '' : option.value)}
      >
        <span className="app-project-chip-label">{option.label}</span>
        <span className="app-project-chip-count">{option.count}</span>
      </button>
    );
  };

  return (
    <nav ref={navRef} className="app-project-switcher" aria-label="Project directory quick switcher">
      <button
        type="button"
        className={`app-project-chip${selectedDirectory ? '' : ' is-active'}`}
        aria-pressed={!selectedDirectory}
        title={allTitle}
        onClick={() => onDirectoryChange('')}
      >
        <span className="app-project-chip-label">All</span>
        <span className="app-project-chip-count">{totals.count}</span>
      </button>
      {visible.map((option) => renderChip(option))}
      {overflow.length > 0 && (
        <ProjectMoreMenu
          options={overflow}
          onSelect={(directory) => onDirectoryChange(directory)}
        />
      )}

      <div ref={measureRef} className="app-project-switcher-measure" aria-hidden="true" inert>
        <button type="button" className="app-project-chip" tabIndex={-1} data-measure="all">
          <span className="app-project-chip-label">All</span>
          <span className="app-project-chip-count">{totals.count}</span>
        </button>
        {options.map((option) => renderChip(option, true))}
        <button type="button" className="app-project-chip app-project-more" tabIndex={-1} data-measure="more">
          +{options.length} More ▾
        </button>
      </div>
    </nav>
  );
};

interface ProjectMoreMenuProps {
  options: DirectoryOption[];
  onSelect: (directory: string) => void;
}

/**
 * `+N More ▾` — a combobox over the projects that did not fit. Typing filters
 * by name or path; ↑/↓/Home/End move the highlight, Enter picks it, Escape
 * closes and returns focus to the trigger. Positioning and outside-click close
 * come from `useAnchoredPopover`.
 */
function ProjectMoreMenu({ options, onSelect }: ProjectMoreMenuProps) {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle, updatePosition } = useAnchoredPopover(330);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const matches = useMemo(() => filterDirectoryOptions(options, query), [options, query]);
  const nowMs = Date.now();
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  useEffect(() => {
    if (open) return;
    setQuery('');
    setHighlight(0);
  }, [open]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  // The list shrinks as you type; re-measure so an upward popover stays anchored.
  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, matches.length, updatePosition]);

  // First frame is `visibility: hidden` until placed, and hidden inputs ignore focus().
  const placed = open && popoverStyle.visibility !== 'hidden';
  useEffect(() => {
    if (placed) inputRef.current?.focus();
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const node = listRef.current?.children[highlight];
    if (node instanceof HTMLElement) node.scrollIntoView?.({ block: 'nearest' });
  }, [open, highlight]);

  const choose = (option: DirectoryOption | undefined) => {
    if (!option) return;
    setOpen(false);
    onSelect(option.value);
    triggerRef.current?.focus();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      choose(matches[highlight]);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || matches.length === 0) return;
    event.preventDefault();
    const last = matches.length - 1;
    setHighlight((current) => {
      if (event.key === 'Home') return 0;
      if (event.key === 'End') return last;
      if (event.key === 'ArrowDown') return current >= last ? 0 : current + 1;
      return current <= 0 ? last : current - 1;
    });
  };

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className="app-project-chip app-project-more"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`${options.length} more projects`}
        onClick={() => setOpen((current) => !current)}
      >
        +{options.length} More ▾
      </button>

      {open && (
        <MetaPopoverPortal>
          <div
            ref={popoverRef}
            className="kv2-meta-dropdown-popover app-project-more-popover"
            style={popoverStyle}
          >
            <input
              ref={inputRef}
              type="text"
              className="kv2-input app-project-more-search"
              placeholder="프로젝트 검색…"
              role="combobox"
              aria-label="Search projects"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={matches[highlight] ? optionId(highlight) : undefined}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
            />
            <div ref={listRef} id={listId} className="app-project-more-list" role="listbox" aria-label="More projects">
              {matches.map((option, index) => (
                <div
                  key={option.value}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === highlight}
                  className={`app-project-more-item${index === highlight ? ' is-highlighted' : ''}`}
                  title={chipTitle(option)}
                  onPointerMove={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(option)}
                >
                  <span className={`works-dir-chip kv2-project-chip ${dirAccentClass(option.value)}`}>
                    {option.label}
                  </span>
                  <span className="app-project-more-meta">
                    {option.count} · {formatActivityAge(option.latestActivity, nowMs)}
                  </span>
                </div>
              ))}
              {matches.length === 0 && (
                <div className="app-project-more-empty">일치하는 프로젝트가 없습니다</div>
              )}
            </div>
            <div className="app-project-more-footer">선택 고정 · 최근 7일 활동 · 카드 수 순 정렬</div>
          </div>
        </MetaPopoverPortal>
      )}
    </>
  );
}
