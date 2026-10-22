import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Work } from '../../../../src/core/types';
import { MetaPopoverPortal, useAnchoredPopover } from '../Card/MetaDropdown';
import { WORK_PICKER_COPY } from '../../constants/copy';

/** Works matching the search query, in the given order (the picker adds `＋ 새 Work` and `Work 없음` above them). */
export function filterWorkPickerOptions(works: readonly Work[], query: string): Work[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...works];
  return works.filter((work) => work.title.toLowerCase().includes(needle));
}

/** Popover rows: `'__new'` (when the caller can create) · `''` (Work 없음) · each match. */
export function workPickerRows(matches: readonly Work[], canCreate: boolean): string[] {
  return [...(canCreate ? ['__new'] : []), '', ...matches.map((work) => work.id)];
}

/**
 * Where the keyboard cursor lands after typing: on the first match, or — with
 * none — on `새 Work 만들기` so Enter creates a Work by that name. Empty
 * search → `Work 없음`.
 */
export function workPickerActiveAfterQuery(works: readonly Work[], query: string, canCreate: boolean): number {
  const noneRow = canCreate ? 1 : 0;
  if (!query.trim()) return noneRow;
  if (filterWorkPickerOptions(works, query).length > 0) return noneRow + 1;
  return canCreate ? 0 : noneRow;
}

export type WorkPickerVariant = 'pill' | 'line' | 'input';

export interface WorkPickerProps {
  /** Selected Work id, `''` for none. */
  value: string;
  /** Active Works offered in the list. */
  works: readonly Work[];
  onChange: (workId: string) => void;
  /**
   * Shows `＋ 새 Work 만들기` at the top. Called with the search text as the new
   * Work's name; with an empty search the row asks for a name instead.
   */
  onCreateNew?: (name: string) => void;
  /** Title for a selected Work missing from `works` (e.g. a closed Work the session still belongs to). */
  fallbackTitle?: string;
  /** Reservation (no session yet) — dashed trigger + `예약` badge. */
  planned?: boolean;
  variant?: WorkPickerVariant;
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
  /** Popover boundary — `.kv2-dialog` inside a dialog. */
  boundarySelector?: string;
}

/**
 * The one Work chooser for every surface (board card, session group, card
 * detail's Work line, NEW TASK). Same trigger anatomy — `W` chip · title ·
 * `예약` badge · `▾` — in three sizes, and the same popover: search, then
 * `＋ 새 Work 만들기` (when the caller can create one), `Work 없음`, and the
 * active Works. Typing filters the list; picking a match assigns it, picking
 * `＋ 새 Work 만들기` creates a Work named after what was typed.
 */
export const WorkPicker: React.FC<WorkPickerProps> = ({
  value,
  works,
  onChange,
  onCreateNew,
  fallbackTitle,
  planned = false,
  variant = 'pill',
  ariaLabel = WORK_PICKER_COPY.ariaLabel,
  title,
  disabled = false,
  boundarySelector,
}) => {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle, updatePosition } =
    useAnchoredPopover(280, { boundarySelector });
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  // `＋ 새 Work 만들기` picked with nothing typed: ask for the name in the search box.
  const [askName, setAskName] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = value ? works.find((work) => work.id === value) : undefined;
  const label = selected?.title ?? (value ? fallbackTitle ?? value : WORK_PICKER_COPY.none);
  const isSet = !!value;

  const matches = useMemo(() => filterWorkPickerOptions(works, query), [works, query]);
  const name = query.trim();
  // Row model: '__new' · '' (none) · each match — keyboard index runs over it.
  const rows = useMemo(() => workPickerRows(matches, !!onCreateNew), [matches, onCreateNew]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setAskName(false);
    // Against the unfiltered rows: `rows` still reflects the previous search
    // here (the `setQuery('')` above lands next render), and its index would
    // point the cursor — and Enter — at a different Work.
    setActive(Math.max(0, workPickerRows(works, !!onCreateNew).indexOf(value)));
    // Only on open: re-running on `rows` would reset the cursor while typing.
  }, [open]);

  // The popover is `visibility: hidden` until it is positioned, and a hidden
  // input ignores focus() — so focus once it becomes visible.
  const popoverVisible = open && popoverStyle.visibility !== 'hidden';
  useEffect(() => {
    if (popoverVisible) inputRef.current?.focus();
  }, [popoverVisible]);

  useEffect(() => {
    if (open) updatePosition();
  }, [open, matches.length, updatePosition]);

  const choose = (row: string) => {
    if (row === '__new') {
      if (!name) {
        setAskName(true);
        inputRef.current?.focus();
        return;
      }
      setOpen(false);
      onCreateNew?.(name);
      return;
    }
    setOpen(false);
    if (row !== value) onChange(row);
  };

  // Escape is handled here, not by the popover hook's document listener: a
  // session group row stops keydown propagation (portal events bubble through
  // the React tree), and stopping it here keeps a surrounding dialog open.
  const onPopoverKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(rows.length - 1, index + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(0, index - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[active];
      if (row !== undefined) choose(row);
    }
  };

  const triggerClass = [
    'kv2-work-picker-trigger',
    `kv2-work-picker-trigger--${variant}`,
    isSet ? 'is-set' : '',
    planned ? 'is-planned' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={`kv2-work-picker kv2-work-picker--${variant}`}>
      <button
        type="button"
        ref={triggerRef}
        className={triggerClass}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="kv2-work-picker-icon" aria-hidden="true">W</span>
        <span className="kv2-work-picker-label">{label}</span>
        {planned && isSet && <span className="kv2-work-picker-state">{WORK_PICKER_COPY.planned}</span>}
        <span className="kv2-work-picker-arrow" aria-hidden="true">▾</span>
      </button>

      {open && (
        <MetaPopoverPortal>
          <div ref={popoverRef} className="kv2-work-picker-popover" style={popoverStyle} onKeyDown={onPopoverKeyDown}>
            <input
              ref={inputRef}
              className="kv2-input kv2-work-picker-search"
              value={query}
              placeholder={askName ? WORK_PICKER_COPY.namePlaceholder : WORK_PICKER_COPY.searchPlaceholder}
              aria-label={WORK_PICKER_COPY.searchPlaceholder}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(workPickerActiveAfterQuery(works, event.target.value, !!onCreateNew));
              }}
              onKeyDown={onKeyDown}
            />
            <div className="kv2-work-picker-list" role="listbox" aria-label={ariaLabel}>
              {rows.map((row, index) => {
                if (row === '__new') {
                  return (
                    <React.Fragment key="__new">
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        className={`kv2-work-picker-option kv2-work-picker-option--new${index === active ? ' is-active' : ''}${askName && !name ? ' is-asking' : ''}`}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(row)}
                      >
                        <span className="kv2-work-picker-check" aria-hidden="true">＋</span>
                        <span className="kv2-work-picker-option-title">
                          {name ? WORK_PICKER_COPY.createNamed(name) : askName ? WORK_PICKER_COPY.createAsk : WORK_PICKER_COPY.createNew}
                        </span>
                      </button>
                      <div className="kv2-work-picker-sep" aria-hidden="true" />
                    </React.Fragment>
                  );
                }
                const work = row ? works.find((candidate) => candidate.id === row) : undefined;
                const isSelected = row === value;
                return (
                  <button
                    key={row || '__none'}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`kv2-work-picker-option${isSelected ? ' is-selected' : ''}${index === active ? ' is-active' : ''}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(row)}
                  >
                    <span className="kv2-work-picker-check" aria-hidden="true">{isSelected ? '✓' : ''}</span>
                    <span className="kv2-work-picker-option-title">{work ? work.title : WORK_PICKER_COPY.none}</span>
                    {work && (
                      <span className="kv2-work-picker-count">{WORK_PICKER_COPY.sessionCount(work.sessionLinks.length)}</span>
                    )}
                  </button>
                );
              })}
              {query.trim() && matches.length === 0 && (
                <div className="kv2-work-picker-empty">{WORK_PICKER_COPY.noMatch}</div>
              )}
            </div>
          </div>
        </MetaPopoverPortal>
      )}
    </div>
  );
};
