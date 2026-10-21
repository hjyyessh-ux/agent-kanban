import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import type { Work, WorkInboxSession, WorkSessionRole } from '../../../../src/core/types';
import { MetaPopoverPortal, useAnchoredPopover } from '../Card/MetaDropdown';
import {
  DEFAULT_SESSION_ROLE,
  NEW_WORK_OPTION,
  ROLE_LABELS,
  ROLE_OPTIONS,
  assignOptionKeys,
  assignTargetForQuery,
  filterAssignRecommendations,
  groupAssignRecommendations,
  newWorkTitleFor,
  recommendWorksForSession,
  stepAssignTarget,
  suggestWorkAssignments,
  suggestWorkTitle,
  daysSince,
  type WorkRecommendation,
} from './worksAssign';
import { dirAccentClass } from './worksAffinity';
import { WorkAffinityMarks } from './WorkAffinityMarks';
import { WorksOverflowMenu } from './WorksOverflowMenu';

/** What the panel would do if it were submitted right now. */
export interface AssignSelection {
  mode: 'new' | 'existing';
  /** Target Work id — only set in `existing` mode. */
  workId: string | null;
  role: WorkSessionRole;
}

/**
 * Move mode: the same combobox, aimed at a session that already belongs to a
 * Work. Exactly four things change — a "현재:" line, the current Work dropping
 * out of the recommendations, an impact preview under the list, and the list
 * rendering inline (always open) because the dialog has the room a row does not.
 */
export interface AssignMoveMode {
  currentWork: Work;
  /** Impact preview under the list, recomputed for each selection. */
  renderPreview: (selection: AssignSelection) => ReactNode;
}

/**
 * Bulk mode: one target for a whole Inbox selection. Nothing about *where* the
 * sessions go changes — only the copy — so the ranking, the title suggestion and
 * the submit flow stay the single implementation shared with single assignment
 * and the move dialog. The representative session comes from
 * `mergeSessionsForAssign`.
 */
export interface AssignBulkMode {
  /** How many sessions the submit applies to (>= 2 in practice). */
  count: number;
}

interface WorkAssignInlineProps {
  session: WorkInboxSession;
  works: Work[];
  onCreateWork: (title: string, role?: WorkSessionRole) => Promise<void>;
  onLinkToWork: (workId: string, role?: WorkSessionRole) => Promise<void>;
  /**
   * The one action that is not "assign" — Inbox: `폐기`, move: `⤺ Inbox로
   * 되돌리기`. It lives in the `⋯` menu beside 배정, never as a button next to
   * it: a red 무시 one pixel from the commit was the easiest wrong click on the
   * screen. Omit it (the bulk bar) and there is no `⋯`.
   */
  secondary?: { label: string; run: () => Promise<void>; tone?: 'danger' | 'neutral' };
  /** Present only in the move dialog; absent means plain Inbox assignment. */
  move?: AssignMoveMode;
  /** Present only for a multi-session Inbox selection; changes copy only. */
  bulk?: AssignBulkMode;
  /**
   * Works holding a session this one continues (`chainedWorkIds`). They rank
   * first and are marked 🔗. Omit where the lineage is unknown (the move dialog
   * rebuilds its session from links, which carry none) — the ranking then falls
   * back to same-directory-first.
   */
  chained?: ReadonlySet<string>;
  /**
   * `works.assign_prefer_same_dir`. `false` stops same-directory Works from
   * being pulled to the top; the 같은 디렉토리 mark still shows. Defaults to the
   * documented `true` so a panel rendered before the config lands ranks the way
   * the setting's default says it should.
   */
  preferSameDir?: boolean;
  /** Pre-selected role — the link's existing role when moving. */
  initialRole?: WorkSessionRole;
  /** Told when the popup opens/closes, so the row can hide its own suggestions. */
  onOpenChange?: (open: boolean) => void;
}

/**
 * Submit copy. Short on purpose — the old button named its whole target
 * (`"X"에 연결`) and was truncated on every long Work title. The combobox right
 * beside it already shows the target, so the button only says the verb, plus
 * the count in bulk mode because the batch is the one thing the input does not
 * show.
 */
function submitLabel(move?: AssignMoveMode, bulk?: AssignBulkMode): string {
  if (move) return '이동';
  if (bulk) return `${bulk.count}개 배정`;
  return '배정';
}

/** Option clicks must not steal focus from the input — the popup would blur shut. */
const keepInputFocus = (event: MouseEvent) => {
  if (event.target instanceof HTMLSelectElement) return;
  event.preventDefault();
};

/**
 * "이 세션을 어디에 붙일까" as one line: `[🔍 combobox ▾][배정][⋯]`.
 *
 * There is no "새로 만들기 / 기존에 연결" mode switch. `＋ 새 Work 만들기` is the
 * first option of the list, and typing does both jobs at once — it filters the
 * Works by title/directory, and it is the title a new Work would get. The
 * default selection is the row's 1순위 추천 (`suggestWorkAssignments`), so when
 * the suggestion is right the whole job is one press of 배정.
 *
 * Used three ways — under every Inbox row, in the Inbox's sticky selection bar
 * (`bulk`), and inside MoveSessionDialog (`move`) — all sharing the ranking and
 * title helpers in worksAssign.ts and this one submit flow, so an assignment and
 * a move can never disagree about which Works are recommended or what a role
 * selection means.
 *
 * The popup is portalled (`useAnchoredPopover`): the Inbox rows scroll inside a
 * capped container, and an absolutely positioned list under the last row was
 * clipped by it. It is also the *only* scroller — the list used to be a 280px
 * scroll box inside the 480px Inbox scroll box.
 */
export function WorkAssignInline({
  session,
  works,
  onCreateWork,
  onLinkToWork,
  secondary,
  move,
  bulk,
  chained,
  preferSameDir = true,
  initialRole,
  onOpenChange,
}: WorkAssignInlineProps) {
  const recommendations = useMemo(
    () => recommendWorksForSession(session, works, move?.currentWork.id, chained, {
      preferSameDir,
    }),
    [session, works, move?.currentWork.id, chained, preferSameDir],
  );
  const suggestedTitle = useMemo(() => suggestWorkTitle(session), [session]);

  // What the *row* would have suggested, so plain 배정 lands on the same Work
  // the row was offering. The list stays grouped by lineage/directory (that is
  // the browse order), but the thing the button would commit must not disagree
  // with the thing the Inbox just recommended.
  const topSuggestionId = useMemo(
    () => suggestWorkAssignments(session, works, {
      excludeWorkId: move?.currentWork.id,
      chained,
      preferSameDir,
      limit: 1,
    })[0]?.work.id,
    [session, works, move?.currentWork.id, chained, preferSameDir],
  );

  const [query, setQuery] = useState('');
  // An explicit pick (↑/↓, a click) — `null` means "whatever the input implies"
  // (`assignTargetForQuery`). Deriving instead of seeding once matters on the
  // Inbox: the combobox mounts with its row, which can be before the Works poll
  // has landed, and a seeded default would stay "새 Work" for good.
  const [picked, setPicked] = useState<string | null>(null);
  const derivedTarget = assignTargetForQuery(query, recommendations, topSuggestionId);
  const target = picked ?? derivedTarget;
  const [role, setRole] = useState<WorkSessionRole>(initialRole ?? DEFAULT_SESSION_ROLE);
  const [busy, setBusy] = useState(false);

  const inline = Boolean(move);
  const {
    open: popupOpen,
    setOpen: setPopupOpen,
    triggerRef: comboRef,
    popoverRef,
    popoverStyle,
    updatePosition,
  } = useAnchoredPopover<HTMLDivElement>(320);
  const open = inline || popupOpen;
  const inputRef = useRef<HTMLInputElement>(null);
  /** The selection the popup opened with — what Esc goes back to. */
  const openedWithRef = useRef<string | null>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);

  // Generated, not hardcoded: this panel renders under every Inbox row, in the
  // bulk bar and inside MoveSessionDialog at once, and fixed ids collided the
  // moment two were mounted, pointing a <label> at the wrong control.
  const fieldId = useId();
  const listId = `${fieldId}-list`;
  const roleId = `${fieldId}-role`;
  const optionId = (key: string) => `${fieldId}-opt-${key}`;

  const filtered = useMemo(
    () => filterAssignRecommendations(recommendations, query),
    [recommendations, query],
  );
  const groups = useMemo(
    () => groupAssignRecommendations(filtered, preferSameDir),
    [filtered, preferSameDir],
  );
  const keys = useMemo(() => assignOptionKeys(filtered), [filtered]);
  const searching = query.trim() !== '';
  const newTitle = newWorkTitleFor(query, suggestedTitle);
  const isNew = target === NEW_WORK_OPTION;

  // `selectedWork`, not the bare id: the list is rebuilt from a 10s poll, so the
  // Work behind a held id can complete and drop out while this is open. Trusting
  // the id let 배정 stay enabled and POST a session onto a finished Work (the
  // server now answers 409, and this keeps the button from offering it at all).
  const selectedWork = isNew
    ? undefined
    : recommendations.find(({ work }) => work.id === target)?.work;
  const canSubmit = isNew ? newTitle.trim().length > 0 : Boolean(selectedWork);

  // …but once the untouched default lands on a Work, hold it. Otherwise a Work
  // that completes on the next poll would silently hand 배정 to the runner-up
  // (or to "새 Work") — the user saw one target and would commit another.
  useEffect(() => {
    if (picked === null && query.trim() === '' && derivedTarget !== NEW_WORK_OPTION) {
      setPicked(derivedTarget);
    }
  }, [picked, query, derivedTarget]);

  useEffect(() => {
    onOpenChange?.(popupOpen);
    // A Work picked through a search keeps its selection but drops the search,
    // so the closed input shows the Work, not the fragment that found it. A new
    // Work keeps the text — there it is the title.
    if (!popupOpen && target !== NEW_WORK_OPTION) {
      setPicked(target);
      setQuery('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [popupOpen]);

  // Filtering changes the popup's height; open/scroll/resize alone never re-measure.
  useEffect(() => {
    if (popupOpen) updatePosition();
  }, [popupOpen, filtered.length, updatePosition]);

  // Keep the highlighted option inside the list's own scroll.
  useEffect(() => {
    if (!open) return;
    document.getElementById(optionId(target))?.scrollIntoView?.({ block: 'nearest' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);

  const runAction = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch {
      // Every caller reports its own failure (the Works error banner, the move
      // dialog's inline error); the panel only has to stay usable for a retry.
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (!canSubmit || busy) return;
    setPopupOpen(false);
    if (isNew) void runAction(() => onCreateWork(newTitle.trim(), role));
    else if (selectedWork) void runAction(() => onLinkToWork(selectedWork.id, role));
  };

  const choose = (key: string) => {
    setPicked(key);
    if (!inline) setPopupOpen(false);
  };

  /** Every way of opening goes through here, so Esc knows what to go back to. */
  const openPopup = () => {
    if (popupOpen) return;
    openedWithRef.current = target;
    setPopupOpen(true);
  };

  const cancelPopup = () => {
    setQuery('');
    setPicked(openedWithRef.current);
    setPopupOpen(false);
  };

  const handleQueryChange = (value: string) => {
    openPopup();
    setQuery(value);
    setPicked(null);
  };

  /** Close when focus leaves the input + popup pair (Tab away, click elsewhere). */
  const handleBlur = (event: FocusEvent) => {
    if (inline) return;
    const next = event.relatedTarget as Node | null;
    if (next && (comboRef.current?.contains(next) || popoverRef.current?.contains(next))) return;
    setPopupOpen(false);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          openPopup();
          return;
        }
        setPicked(stepAssignTarget(keys, target, event.key === 'ArrowDown' ? 1 : -1));
        return;
      case 'Enter':
        // ⏎ settles on the highlighted option; ⌘⏎ (above) is the one that assigns.
        event.preventDefault();
        if (inline) return;
        if (popupOpen) setPopupOpen(false);
        else openPopup();
        return;
      case 'Escape':
        // Only swallowed while there is a popup to close — in the move dialog
        // the list is inline, and Escape belongs to the dialog.
        // Esc is "never mind": a typed search is dropped and the selection goes
        // back to what it was when the popup opened.
        if (!popupOpen) return;
        event.preventDefault();
        event.stopPropagation();
        cancelPopup();
        return;
      case 'Tab':
        // The role select lives in the portalled popup, outside the tab order —
        // walk into it explicitly so it is reachable without a pointer.
        if (popupOpen && !event.shiftKey) {
          event.preventDefault();
          roleRef.current?.focus();
        }
        return;
      default:
    }
  };

  const handleRoleKeyDown = (event: KeyboardEvent<HTMLSelectElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
      return;
    }
    if (!popupOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancelPopup();
      inputRef.current?.focus();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey) {
        inputRef.current?.focus();
      } else {
        setPopupOpen(false);
        submitRef.current?.focus();
      }
    }
  };

  const preview = move?.renderPreview({
    mode: isNew ? 'new' : 'existing',
    workId: isNew ? null : target,
    role,
  });

  const comboLabel = move ? '옮길 Work' : bulk ? `세션 ${bulk.count}개를 배정할 Work` : '배정할 Work';
  // Shown as the placeholder while closed: the input holds only what was typed,
  // so an untouched combobox reads as its current selection.
  const selectionText = isNew ? newTitle : selectedWork?.title ?? '';

  const renderWork = ({ work, sameDirectory, chained: isChained, keywords }: WorkRecommendation) => {
    const selected = work.id === target;
    return (
      <div
        key={work.id}
        id={optionId(work.id)}
        role="option"
        aria-selected={selected}
        className={`works-assign-work-item ${dirAccentClass(work.projectDir)}${selected ? ' is-selected' : ''}${isChained ? ' is-chained' : ''}`}
        onMouseDown={keepInputFocus}
        onClick={() => choose(work.id)}
      >
        <span className="works-assign-work-bar" />
        <span className="works-assign-work-title">{work.title}</span>
        <span className="works-assign-work-ago">
          <WorkAffinityMarks
            projectDir={work.projectDir}
            sameDirectory={sameDirectory}
            chained={isChained}
            keywords={keywords}
            extra={`${daysSince(work.startedAt) + 1}일째`}
          />
        </span>
      </div>
    );
  };

  const listbox = (
    <div id={listId} role="listbox" aria-label={comboLabel} className="works-assign-listbox">
      <div
        id={optionId(NEW_WORK_OPTION)}
        role="option"
        aria-selected={isNew}
        className={`works-assign-create${isNew ? ' is-selected' : ''}`}
        onMouseDown={keepInputFocus}
        onClick={() => choose(NEW_WORK_OPTION)}
      >
        <span className="works-assign-create-label">＋ 새 Work 만들기</span>
        <span className="works-assign-create-title">"{newTitle}"</span>
        <kbd className="works-assign-create-key" aria-hidden="true">⏎</kbd>
      </div>
      {recommendations.length === 0 ? (
        <div role="presentation" className="works-assign-empty">
          연결할 수 있는 진행 중 Work가 없습니다
        </div>
      ) : searching ? (
        <div role="group" aria-labelledby={`${fieldId}-results`}>
          <div id={`${fieldId}-results`} role="presentation" className="works-assign-group-label">
            검색 결과 ({filtered.length})
          </div>
          {filtered.length === 0 ? (
            <div role="presentation" className="works-assign-empty">
              "{query.trim()}"와 일치하는 Work가 없습니다 — 배정하면 이 제목으로 새 Work를 만듭니다
            </div>
          ) : filtered.map(renderWork)}
        </div>
      ) : (
        <>
          <div role="presentation" className="works-assign-order">
            {preferSameDir ? '같은 폴더에서 나온 Work를 먼저 보여줍니다' : '최근에 움직인 Work부터 보여줍니다'}
          </div>
          {groups.map((group) => (
            <div key={group.key} role="group" aria-labelledby={`${fieldId}-group-${group.key}`}>
              <div
                id={`${fieldId}-group-${group.key}`}
                role="presentation"
                className="works-assign-group-label"
              >
                {group.label} ({group.items.length})
              </div>
              {group.items.map(renderWork)}
            </div>
          ))}
        </>
      )}
    </div>
  );

  // One role select for the whole panel, in the popup footer next to the keys
  // it answers to. A sibling <label htmlFor>, not a wrapping one: Chrome folds a
  // wrapped <select>'s selected option into the accessible name, so the control
  // answered to "역할 개발" instead of "역할".
  const footer = (
    <div className="works-assign-footer">
      <label className="kv2-label" htmlFor={roleId}>
        {bulk ? `세션 ${bulk.count}개 역할` : '역할'}
      </label>
      <select
        id={roleId}
        ref={roleRef}
        className="kv2-select"
        value={role}
        onChange={(event) => setRole(event.target.value as WorkSessionRole)}
        onKeyDown={handleRoleKeyDown}
        onBlur={handleBlur}
      >
        {ROLE_OPTIONS.map((option) => (
          <option key={option} value={option}>{ROLE_LABELS[option]}</option>
        ))}
      </select>
      <span className="works-assign-keys" aria-hidden="true">
        {inline ? '↑↓ 이동 · ⌘⏎ 바로 이동' : '↑↓ 이동 · ⏎ 선택 · ⌘⏎ 바로 배정 · Esc'}
      </span>
    </div>
  );

  return (
    <div className={`works-assign-inline${move ? ' works-assign-inline--move' : ''}${bulk ? ' works-assign-inline--bulk' : ''}`}>
      {move && (
        <div className="works-assign-current">
          현재:
          <span className="works-assign-current-dot" aria-hidden="true" />
          <b>{move.currentWork.title}</b>
        </div>
      )}

      <div className="works-assign-bar">
        <div
          ref={comboRef}
          className={`works-assign-combo${open ? ' is-open' : ''}${isNew ? ' is-new' : ''}`}
        >
          <span className="works-assign-combo-icon" aria-hidden="true">🔍</span>
          {isNew && !open && <span className="works-assign-combo-tag">＋ 새 Work</span>}
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            className="works-assign-combo-input"
            aria-label={comboLabel}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open ? optionId(target) : undefined}
            value={query}
            placeholder={open ? 'Work 검색 또는 새 Work 제목' : selectionText}
            disabled={busy}
            onChange={(event) => handleQueryChange(event.target.value)}
            onClick={openPopup}
            onKeyDown={handleInputKeyDown}
            onBlur={handleBlur}
          />
          {!inline && (
            <button
              type="button"
              tabIndex={-1}
              className="works-assign-combo-caret"
              aria-label={popupOpen ? '목록 닫기' : '목록 열기'}
              disabled={busy}
              onMouseDown={keepInputFocus}
              onClick={() => {
                if (popupOpen) setPopupOpen(false);
                else openPopup();
                inputRef.current?.focus();
              }}
            >
              ▾
            </button>
          )}
        </div>
        <button
          ref={submitRef}
          type="button"
          className="kv2-btn kv2-btn--small kv2-btn--primary works-assign-submit"
          disabled={!canSubmit || busy}
          title={isNew ? `새 Work "${newTitle}" 만들기` : selectedWork ? `"${selectedWork.title}"` : undefined}
          onClick={submit}
        >
          {submitLabel(move, bulk)}
        </button>
        {secondary && (
          <WorksOverflowMenu
            label={move ? '세션 이동 메뉴' : '세션 메뉴'}
            disabled={busy}
            boundarySelector={move ? '.kv2-dialog' : undefined}
            items={[{
              id: 'secondary',
              label: secondary.label,
              tone: secondary.tone === 'neutral' ? undefined : 'danger',
              onSelect: () => { void runAction(secondary.run); },
            }]}
          />
        )}
      </div>

      {inline && (
        <div className="works-assign-popup works-assign-popup--inline">
          {listbox}
          {footer}
        </div>
      )}
      {!inline && popupOpen && (
        <MetaPopoverPortal>
          <div
            ref={popoverRef}
            className="works-assign-popup"
            style={popoverStyle}
            onMouseDown={keepInputFocus}
          >
            {listbox}
            {footer}
          </div>
        </MetaPopoverPortal>
      )}

      {preview}
    </div>
  );
}
