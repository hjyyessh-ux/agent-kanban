import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KanbanCard } from '../../../../src/core/types';
import { splitFeedbackHeader } from '../../../../src/core/mention-search';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { FeedbackPanel } from '../Card/FeedbackPanel';
import { CardMarkdown } from '../Card/CardMarkdown';
import { PhaseAside, PhaseBody } from '../Card/CardPhases';
import { splitCardResult } from '../Card/card-result';
import { ExecutionTypeBadge } from './BoardCardSections';
import { getDirectoryProjectName } from './directory-display';
import { buildResumeCommand } from '../../utils/resume-command';
import { dirAccentClass } from '../../utils/project-color';
import { getScreenshotUrl } from '../../hooks/useKanbanApi';
import { useCopyFeedback } from '../../hooks/useCopyFeedback';
import { COPIED_LABEL, IdChip, ResumeCopyButton } from '../shared/IdChip';
import { ImageLightbox } from '../shared/ImageLightbox';
import { formatDuration, resolveRunDurationMs } from '../../utils/format-duration';
import { applyTextHighlight, clearTextHighlight } from '../../utils/text-highlight';
import type { CompleteSessionGroup } from './BoardCompleteSessionView';
import { groupCardsByParent, type CardWithChildren } from './board-utils';

interface SessionConversationModalProps {
  group: CompleteSessionGroup;
  status: 'complete' | 'done';
  onClose: () => void;
  onCreateFeedback: (
    cardId: string,
    feedback: string,
    shouldDispatch: boolean,
    screenshots?: File[],
  ) => Promise<void>;
}

// ── 보기 설정: 모두 localStorage에 남아 다음에 열 때도 같은 모양으로 열린다 ──
const TURN_ORDER_STORAGE_KEY = 'kanban-session-turn-order';
const EXPAND_MODE_STORAGE_KEY = 'kanban-session-turn-expand';
const OUTLINE_STORAGE_KEY = 'kanban-session-outline-collapsed';
const DOCK_HEIGHT_STORAGE_KEY = 'kanban-session-feedback-dock-height';

type TurnOrder = 'newest' | 'oldest';
/** recent = 최근 RECENT_OPEN_COUNT개만 펼침(기본) / all / none */
export type ExpandMode = 'recent' | 'all' | 'none';
export const RECENT_OPEN_COUNT = 2;

const DOCK_MIN_HEIGHT = 140;
const DOCK_MAX_RATIO = 0.75;
const DOCK_KEY_STEP = 24;
const PREVIEW_MAX_CHARS = 160;
/** `::highlight(session-search)` 이름 — conversation.css와 짝 */
const SEARCH_HIGHLIGHT = 'session-search';

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback;
  const value = localStorage.getItem(key);
  return allowed.find((option) => option === value) ?? fallback;
}

function writeStored(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // quota — the in-memory state still applies for this session
  }
}

function readDockHeight(): number | null {
  if (typeof localStorage === 'undefined') return null;
  const value = Number(localStorage.getItem(DOCK_HEIGHT_STORAGE_KEY));
  return Number.isFinite(value) && value >= DOCK_MIN_HEIGHT ? value : null;
}

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '-';

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';

  const pad = (value: number) => value.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatShortTimestamp(iso: string | undefined): string {
  const full = formatTimestamp(iso);
  return full === '-' ? full : full.slice(5);
}

function getTimestampMs(value: string | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function cardDurationMs(card: KanbanCard): number {
  return Math.max(0, resolveRunDurationMs(card) ?? 0);
}

/** 0이면 표시하지 않는다(아직 끝나지 않은 turn). */
function formatDurationMs(ms: number): string | null {
  return ms > 0 ? formatDuration(ms) : null;
}

function compareOldestCardFirst(a: KanbanCard, b: KanbanCard): number {
  const createdDiff = getTimestampMs(a.createdAt) - getTimestampMs(b.createdAt);
  if (createdDiff !== 0) return createdDiff;

  const updatedDiff = getTimestampMs(a.updatedAt) - getTimestampMs(b.updatedAt);
  if (updatedDiff !== 0) return updatedDiff;

  return a.id.localeCompare(b.id);
}

/**
 * 접힌 turn 밑에 보여줄 결과 한 줄 — 마크다운 기호를 걷어낸 첫 비어있지 않은 줄.
 * 접어둔 turn도 "무엇으로 끝났는지"는 펼치지 않고 읽힌다.
 */
export function previewLine(text: string | undefined): string {
  if (!text) return '';
  const line = text
    .split('\n')
    .map((raw) => raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*|\d+\.\s+)/, '').replace(/[*_`]/g, '').trim())
    .find((raw) => raw.length > 0 && !/^[-=|:\s]+$/.test(raw));
  if (!line) return '';
  return line.length > PREVIEW_MAX_CHARS ? `${line.slice(0, PREVIEW_MAX_CHARS)}…` : line;
}

/** 세션 내 검색 — 제목·프롬프트·결과·subagent 지시/응답까지 대소문자 무시 부분 일치. */
export function turnMatchesQuery(card: CardWithChildren, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystacks = [card.title, card.description, card.result];
  for (const child of card.childCards ?? []) haystacks.push(child.description, child.result);
  return haystacks.some((text) => text?.toLowerCase().includes(needle));
}

/** 이 turn이 펼쳐져 있는가. 검색에 걸린 turn은 항상 펼친다. */
export function isTurnOpen(
  turnNumber: number,
  turnCount: number,
  mode: ExpandMode,
  override: boolean | undefined,
  searchHit: boolean,
): boolean {
  if (searchHit) return true;
  if (override !== undefined) return override;
  if (mode === 'all') return true;
  if (mode === 'none') return false;
  return turnNumber > turnCount - RECENT_OPEN_COUNT;
}

// 한 subagent(자식 카드)를 렌더한다: 메인이 내린 지시(description) +
// 그 subagent의 응답(result) + 캡처된 inter-agent 메시지(agentMessages).
const SubagentTurn: React.FC<{ child: KanbanCard }> = ({ child }) => {
  const [collapsed, setCollapsed] = useState(true);
  const speaker = child.agentType?.trim() || 'subagent';
  const instruction = child.description?.trim();
  const response = child.result?.trim();

  return (
    <div className="session-conversation-subagent">
      <button
        type="button"
        className="session-conversation-subagent-header"
        onClick={() => setCollapsed((value) => !value)}
        aria-expanded={!collapsed}
      >
        <span className="session-conversation-subagent-speaker">{speaker}</span>
        <span className="session-conversation-subagent-flow">main → {speaker}</span>
        <span className="session-conversation-subagent-toggle">
          {collapsed ? 'show ▾' : 'hide ▴'}
        </span>
      </button>
      {!collapsed && (
        <div className="session-conversation-subagent-body">
          <div className="session-conversation-subagent-part">
            <span className="session-conversation-partLabel" data-highlight-skip>지시 (main → {speaker})</span>
            {instruction ? <CardMarkdown text={instruction} /> : <p>(no instruction)</p>}
          </div>
          {response && (
            <div className="session-conversation-subagent-part">
              <span className="session-conversation-partLabel" data-highlight-skip>응답 ({speaker})</span>
              <CardMarkdown text={response} />
            </div>
          )}
          {child.agentMessages && child.agentMessages.length > 0 && (
            <ul className="kv2-agent-msgs">
              {child.agentMessages.map((m, i) => (
                <li key={i} className={`kv2-agent-msg kv2-agent-msg--${m.direction}`}>
                  <span className="kv2-agent-msg-dir" aria-hidden="true">
                    {m.direction === 'out' ? '→' : '←'}
                  </span>
                  <span className="kv2-agent-msg-peer">
                    {m.direction === 'out' ? (m.to ?? 'main') : (m.from ?? 'main')}
                  </span>
                  <span className="kv2-agent-msg-body">{m.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};

interface SessionConversationTurnProps {
  card: CardWithChildren;
  turnNumber: number;
  isLatest: boolean;
  open: boolean;
  /** 검색에 걸린 turn — 접힌 Prompt도 펼쳐서 하이라이트가 보이게 한다. */
  searchHit: boolean;
  onToggle: () => void;
  onPreviewImage: (url: string) => void;
}

const SessionConversationTurn: React.FC<SessionConversationTurnProps> = ({
  card,
  turnNumber,
  isLatest,
  open,
  searchHit,
  onToggle,
  onPreviewImage,
}) => {
  const [promptClamped, setPromptCollapsed] = useState(true);
  const promptCollapsed = promptClamped && !searchHit;
  const [earlierOpen, setEarlierOpen] = useState(false);
  const [headerOpen, setHeaderOpen] = useState(false);
  const { copied, copy } = useCopyFeedback(card.id);
  const duration = formatDurationMs(cardDurationMs(card));
  const { earlier, final } = splitCardResult(card);
  const result = final.trim();
  const { header: feedbackHeader, body: promptBody } = splitFeedbackHeader(card.description ?? '');
  const prompt = promptBody.trim();
  const preview = previewLine(result) || previewLine(prompt);
  const subagents = card.childCards ? [...card.childCards].sort(compareOldestCardFirst) : [];
  const screenshots = card.screenshots ?? [];
  const isRunning = card.status === 'in_progress';
  const bodyId = `session-turn-body-${card.id}`;

  return (
    <article
      data-turn={turnNumber}
      className={`session-conversation-turn${isLatest ? ' is-latest' : ''}${open ? ' is-open' : ''}`}
    >
      <button
        type="button"
        className="session-conversation-turnHead"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="session-conversation-turnCaret" aria-hidden="true">▸</span>
        <span className="session-conversation-turnNo" data-highlight-skip>T{turnNumber}</span>
        {isLatest && <span className="session-conversation-turnLatestTag" data-highlight-skip>latest</span>}
        {isRunning && <span className="session-conversation-turnRunning" data-highlight-skip>실행 중</span>}
        <span className="session-conversation-turnTitle">{card.title || '(untitled)'}</span>
        <span className="session-conversation-turnTime" data-highlight-skip>{formatShortTimestamp(card.startedAt ?? card.createdAt)}</span>
        {duration && <span className="session-conversation-turnDuration" data-highlight-skip>{duration}</span>}
      </button>

      {!open && preview && <p className="session-conversation-turnPreview">{preview}</p>}

      {open && (
        <div id={bodyId} className="session-conversation-turnBody">
          {/* 대화 순서 그대로: 요청(Prompt) → 결과(Result). 긴 Prompt는 클램프로 줄인다. */}
          <section className="session-conversation-part session-conversation-part--prompt">
            <div className="session-conversation-partHead" data-highlight-skip>
              <span className="session-conversation-partName">Prompt</span>
              {!promptClamped && (
                <button
                  type="button"
                  className="kv2-btn kv2-btn--ghost kv2-btn--small session-conversation-partAction"
                  onClick={() => setPromptCollapsed(true)}
                >
                  접기 ▴
                </button>
              )}
            </div>
            {feedbackHeader && (
              <PhaseAside
                text={feedbackHeader}
                showLabel="Show feedback header ▾"
                hideLabel="Hide feedback header ▴"
                open={headerOpen}
                onToggle={() => setHeaderOpen((value) => !value)}
              />
            )}
            <PhaseBody collapsed={promptCollapsed} onExpand={() => setPromptCollapsed(false)}>
              {prompt ? <CardMarkdown text={prompt} /> : <p>(no prompt)</p>}
            </PhaseBody>
          </section>

          {result ? (
            <section className="session-conversation-part session-conversation-part--result">
              <div className="session-conversation-partHead" data-highlight-skip>
                <span className="session-conversation-partName">Result</span>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--ghost kv2-btn--small session-conversation-partAction"
                  onClick={() => copy(result)}
                >
                  {copied ? COPIED_LABEL : '⧉ 복사'}
                </button>
              </div>
              {earlier && (
                <PhaseAside
                  text={earlier}
                  showLabel="Show earlier output ▾"
                  hideLabel="Hide earlier output ▴"
                  open={earlierOpen}
                  onToggle={() => setEarlierOpen((value) => !value)}
                />
              )}
              <div className="kv2-phase-content kv2-phase-content--markdown">
                <CardMarkdown text={result} />
              </div>
            </section>
          ) : (
            <p className="session-conversation-noResult">{isRunning ? '실행 중 — 아직 결과가 없습니다.' : '결과가 없습니다.'}</p>
          )}

          {screenshots.length > 0 && (
            <div className="session-conversation-shots" aria-label={`Screenshots (${screenshots.length})`}>
              {screenshots.map((shot) => (
                <button
                  key={shot.id}
                  type="button"
                  className="session-conversation-shot"
                  onClick={() => onPreviewImage(getScreenshotUrl(shot.filename))}
                  title={shot.originalName || shot.filename}
                >
                  <img src={getScreenshotUrl(shot.filename)} alt={shot.originalName || shot.filename} />
                </button>
              ))}
            </div>
          )}

          {subagents.length > 0 && (
            <div className="session-conversation-subagents">
              <div className="session-conversation-subagents-label">
                Subagents ({subagents.length})
              </div>
              {subagents.map((child) => (
                <SubagentTurn key={child.id} child={child} />
              ))}
            </div>
          )}
        </div>
      )}
    </article>
  );
};

export const SessionConversationModal: React.FC<SessionConversationModalProps> = ({
  group,
  status,
  onClose,
  onCreateFeedback,
}) => {
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [turnOrder, setTurnOrder] = useState<TurnOrder>(() =>
    readStored(TURN_ORDER_STORAGE_KEY, ['newest', 'oldest'] as const, 'newest'),
  );
  const [expandMode, setExpandMode] = useState<ExpandMode>(() =>
    readStored(EXPAND_MODE_STORAGE_KEY, ['recent', 'all', 'none'] as const, 'recent'),
  );
  // 개별 turn을 손으로 펼치고 접은 기록. 펼침 모드를 바꾸면 초기화된다.
  const [openOverrides, setOpenOverrides] = useState<Record<string, boolean>>({});
  const [outlineCollapsed, setOutlineCollapsed] = useState(
    () => readStored(OUTLINE_STORAGE_KEY, ['1', '0'] as const, '0') === '1',
  );
  const [query, setQuery] = useState('');
  const [dockHeight, setDockHeight] = useState<number | null>(readDockHeight);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const newestFirst = turnOrder === 'newest';
  const scrollRef = useRef<HTMLDivElement>(null);
  const outlineRef = useRef<HTMLElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // group.cards는 최신순(index 0 = 최신)이며 subagent 자식 카드도 섞여 있다.
  // groupCardsByParent로 자식을 부모 턴의 childCards로 접어 넣어 top-level 턴만 남긴다
  // (유령 턴 제거). Turn 번호는 항상 과거→최신 기준(1 = 첫 턴)이고, 표시 순서만
  // turnOrder로 뒤집는다 — 기본은 최신순(최신 turn이 맨 위).
  const orderedTurns = useMemo(
    () => groupCardsByParent(group.cards).sort(compareOldestCardFirst),
    [group.cards],
  );

  const turnCount = orderedTurns.length;
  const trimmedQuery = query.trim();
  const showOutline = turnCount > 1 && !outlineCollapsed;
  const showOutlineRail = turnCount > 1 && outlineCollapsed;
  const displayTurns = useMemo(
    () =>
      orderedTurns
        .map((card, index) => ({
          card,
          turnNumber: index + 1,
          hit: trimmedQuery ? turnMatchesQuery(card, trimmedQuery) : false,
        }))
        .filter((turn) => !trimmedQuery || turn.hit)
        .sort((a, b) => (newestFirst ? b.turnNumber - a.turnNumber : a.turnNumber - b.turnNumber)),
    [orderedTurns, newestFirst, trimmedQuery],
  );
  const visibleKey = displayTurns.map((turn) => turn.turnNumber).join(',');

  const stats = useMemo(() => {
    const totalMs = orderedTurns.reduce((sum, card) => sum + cardDurationMs(card), 0);
    const subagentCount = orderedTurns.reduce((sum, card) => sum + (card.childCards?.length ?? 0), 0);
    const first = orderedTurns[0];
    const last = orderedTurns[turnCount - 1];
    return {
      total: formatDurationMs(totalMs),
      subagentCount,
      from: first ? first.startedAt ?? first.createdAt : group.startedAt,
      to: last ? last.completedAt ?? last.updatedAt : group.lastUpdatedAt,
    };
  }, [orderedTurns, turnCount, group.startedAt, group.lastUpdatedAt]);

  // 처음 보이는 turn(맨 위)을 활성으로 시작한다.
  const [activeTurn, setActiveTurn] = useState(() => (newestFirst ? turnCount : 1));

  // 목차/레일 점프 직후엔 scrollspy가 활성 turn을 덮어쓰지 않게 잠근다 — 사용자가 직접 스크롤하면 풀린다.
  const jumpLockRef = useRef(false);

  const scrollToTurn = useCallback((n: number) => {
    const root = scrollRef.current;
    const el = root?.querySelector<HTMLElement>(`[data-turn="${n}"]`);
    if (!root || !el) return;
    jumpLockRef.current = true;
    setActiveTurn(n);
    const top = root.scrollTop + el.getBoundingClientRect().top - root.getBoundingClientRect().top - 8;
    root.scrollTo({ top, behavior: 'smooth' });
  }, []);

  const changeOrder = useCallback((next: TurnOrder) => {
    setTurnOrder(next);
    writeStored(TURN_ORDER_STORAGE_KEY, next);
    setActiveTurn(next === 'newest' ? turnCount : 1);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [turnCount]);

  const changeExpandMode = useCallback((next: ExpandMode) => {
    setExpandMode(next);
    setOpenOverrides({});
    writeStored(EXPAND_MODE_STORAGE_KEY, next);
  }, []);

  const toggleOutline = useCallback(() => {
    setOutlineCollapsed((value) => {
      writeStored(OUTLINE_STORAGE_KEY, value ? '0' : '1');
      return !value;
    });
  }, []);

  // 스크롤 위치에 따라 현재 turn을 추적(scrollspy) — 화면 상단 30% 밴드에서 가장 위의 turn을 활성화.
  // (목차/레일에서 점프하면 그 turn이 맨 위에 오므로 클릭한 항목이 그대로 활성으로 남는다.)
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || turnCount <= 1) return;
    const turnEls = Array.from(root.querySelectorAll<HTMLElement>('[data-turn]'));
    if (turnEls.length === 0) return;

    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const n = Number((entry.target as HTMLElement).dataset.turn);
          if (entry.isIntersecting) visible.add(n);
          else visible.delete(n);
        }
        // 화면상 가장 위에 있는 turn — 최신순이면 번호가 가장 큰 쪽이다.
        if (jumpLockRef.current || visible.size === 0) return;
        setActiveTurn(newestFirst ? Math.max(...visible) : Math.min(...visible));
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    turnEls.forEach((el) => observer.observe(el));
    const unlock = () => {
      jumpLockRef.current = false;
    };
    const userScrollEvents = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
    userScrollEvents.forEach((type) => root.addEventListener(type, unlock, { passive: true }));
    return () => {
      observer.disconnect();
      userScrollEvents.forEach((type) => root.removeEventListener(type, unlock));
    };
  }, [turnCount, newestFirst, visibleKey]);

  // 검색어 하이라이트 — 본문(마크다운 포함)과 목차 제목 모두. 렌더된 DOM이 바뀌면
  // (turn 펼침, earlier output 열기, 폴링 갱신) 다시 칠한다.
  useEffect(() => {
    const roots = () => [scrollRef.current, outlineRef.current];
    if (!trimmedQuery) {
      clearTextHighlight(SEARCH_HIGHLIGHT);
      return;
    }
    let frame = 0;
    const paint = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => applyTextHighlight(SEARCH_HIGHLIGHT, roots(), trimmedQuery));
    };
    paint();
    const observer = new MutationObserver(paint);
    for (const root of roots()) {
      if (root) observer.observe(root, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [trimmedQuery, showOutline]);

  useEffect(() => () => clearTextHighlight(SEARCH_HIGHLIGHT), []);

  // 활성 항목이 목차 안에 보이도록(목차만 스크롤, 본문은 건드리지 않음).
  useEffect(() => {
    const item = outlineRef.current?.querySelector<HTMLElement>(`[data-outline-turn="${activeTurn}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [activeTurn, outlineCollapsed]);

  // 피드백 attach 대상: 세션의 마지막(가장 최신) complete top-level 카드.
  // group.cards가 최신순이므로 첫 매칭이 곧 최신 complete top-level 카드다.
  const feedbackTarget = useMemo(
    () => group.cards.find((card) => card.status === 'complete' && !card.parentCardId),
    [group.cards],
  );
  const feedbackTargetTurn = feedbackTarget
    ? orderedTurns.findIndex((card) => card.id === feedbackTarget.id) + 1
    : 0;

  // ── 피드백 독 높이: 위 경계선을 끌어 조절, 더블클릭이면 기본 높이로 ──
  const dockDragRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const clampDock = useCallback((height: number) => {
    const bodyHeight = bodyRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    return Math.round(Math.min(bodyHeight * DOCK_MAX_RATIO, Math.max(DOCK_MIN_HEIGHT, height)));
  }, []);
  const commitDock = useCallback((height: number | null) => {
    setDockHeight(height);
    writeStored(DOCK_HEIGHT_STORAGE_KEY, height === null ? null : String(height));
  }, []);
  const currentDockHeight = (handle: HTMLElement) => handle.parentElement?.offsetHeight ?? DOCK_MIN_HEIGHT;

  const resumeCommand = group.sessionId
    ? buildResumeCommand(group.agentRuntime, group.sessionId, group.projectDir)
    : '';

  return (
    <DialogSkeleton
      onClose={onClose}
      className={`session-conversation-dialog session-conversation-dialog--${status}`}
      persistSizeKey="session-conversation-dialog"
      defaultSize={{ width: 1040, height: 880 }}
    >
      <header className="session-conversation-stickyHeader">
        <div className="session-conversation-stickyTopRow">
          {group.projectDir && (
            <span
              className={`works-dir-chip kv2-project-chip session-conversation-stickyProject ${dirAccentClass(group.projectDir)}`.trim()}
              title={group.projectDir}
            >
              {getDirectoryProjectName(group.projectDir)}
            </span>
          )}
          <ExecutionTypeBadge
            runtime={group.agentRuntime}
            executionKind={group.executionKind}
            scriptName={group.scriptName}
          />
          {group.sessionId && (
            <span className="session-conversation-ids">
              <IdChip id={group.sessionId} kind="session" showKind />
              {resumeCommand && <ResumeCopyButton command={resumeCommand} />}
            </span>
          )}
        </div>
        <h2 className="session-conversation-stickyTitle">{group.title}</h2>
        <div className="session-conversation-stats">
          <span><b>{turnCount}</b> turns</span>
          {stats.total && <span>총 <b>{stats.total}</b></span>}
          <span className="session-conversation-stickyRange">
            {formatTimestamp(stats.from)} → {formatTimestamp(stats.to)}
          </span>
          {stats.subagentCount > 0 && <span>subagent <b>{stats.subagentCount}</b></span>}
        </div>
        {turnCount > 1 && (
          <div className="session-conversation-toolbar">
            <div className="session-conversation-seg" role="group" aria-label="정렬">
              <button type="button" aria-pressed={newestFirst} onClick={() => changeOrder('newest')}>
                ↓ 최신순
              </button>
              <button type="button" aria-pressed={!newestFirst} onClick={() => changeOrder('oldest')}>
                ↑ 오래된순
              </button>
            </div>
            <div className="session-conversation-seg" role="group" aria-label="펼침">
              <button type="button" aria-pressed={expandMode === 'recent'} onClick={() => changeExpandMode('recent')}>
                최근 {RECENT_OPEN_COUNT}개
              </button>
              <button type="button" aria-pressed={expandMode === 'all'} onClick={() => changeExpandMode('all')}>
                모두 펼침
              </button>
              <button type="button" aria-pressed={expandMode === 'none'} onClick={() => changeExpandMode('none')}>
                모두 접기
              </button>
            </div>
            <label className="session-conversation-search">
              <span aria-hidden="true">🔍</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="세션 내 검색 (prompt·result)"
                aria-label="세션 내 검색"
              />
              {trimmedQuery && (
                <span className="session-conversation-searchCount" aria-live="polite">
                  {displayTurns.length}/{turnCount}
                </span>
              )}
            </label>
            <button
              type="button"
              className="kv2-btn kv2-btn--small session-conversation-toolBtn"
              onClick={() => scrollToTurn(turnCount)}
            >
              최신 turn으로
            </button>
          </div>
        )}
      </header>

      <div
        ref={bodyRef}
        className={`session-conversation-body${showOutline ? ' has-outline' : ''}${showOutlineRail ? ' has-outline-rail' : ''}`}
      >
        {showOutlineRail && (
          // 접힌 목차: » 로 다시 열고, 그 아래 T# 만 남겨 접힌 상태에서도 바로 이동한다.
          <nav ref={outlineRef} className="session-conversation-outlineRail" aria-label="Turn 목차 (접힘)" data-highlight-skip>
            <button
              type="button"
              className="session-conversation-outlineToggle"
              onClick={toggleOutline}
              aria-expanded={false}
              aria-controls="session-conversation-outline"
              aria-label="목차 열기"
              title="목차 열기"
            >
              »
            </button>
            {displayTurns.map(({ card, turnNumber }) => (
              <button
                key={card.id}
                type="button"
                data-outline-turn={turnNumber}
                aria-current={turnNumber === activeTurn ? 'true' : undefined}
                className={`session-conversation-railItem${turnNumber === activeTurn ? ' is-active' : ''}${turnNumber === turnCount ? ' is-latest' : ''}`}
                title={card.title || '(untitled)'}
                onClick={() => scrollToTurn(turnNumber)}
              >
                T{turnNumber}
              </button>
            ))}
          </nav>
        )}
        {showOutline && (
          <nav
            ref={outlineRef}
            id="session-conversation-outline"
            className="session-conversation-outline"
            aria-label="Turn 목차"
          >
            <div className="session-conversation-outlineHead" data-highlight-skip>
              <span>Turns <b>{trimmedQuery ? `${displayTurns.length}/${turnCount}` : turnCount}</b></span>
              <button
                type="button"
                className="session-conversation-outlineToggle"
                onClick={toggleOutline}
                aria-expanded
                aria-controls="session-conversation-outline"
                aria-label="목차 닫기"
                title="목차 닫기"
              >
                «
              </button>
            </div>
            {displayTurns.map(({ card, turnNumber }) => {
              const isActive = turnNumber === activeTurn;
              const duration = formatDurationMs(cardDurationMs(card));
              return (
                <button
                  key={card.id}
                  type="button"
                  data-outline-turn={turnNumber}
                  aria-current={isActive ? 'true' : undefined}
                  className={`session-conversation-outlineItem${isActive ? ' is-active' : ''}${turnNumber === turnCount ? ' is-latest' : ''}`}
                  title={card.title}
                  onClick={() => scrollToTurn(turnNumber)}
                >
                  <span className="session-conversation-outlineNo" data-highlight-skip>T{turnNumber}</span>
                  <span className="session-conversation-outlineTitle">{card.title || '(untitled)'}</span>
                  <span className="session-conversation-outlineMeta" data-highlight-skip>
                    {formatShortTimestamp(card.startedAt ?? card.createdAt)}
                    {duration && ` · ${duration}`}
                  </span>
                </button>
              );
            })}
          </nav>
        )}

        <div ref={scrollRef} className="session-conversation-scroll">
          <div className="session-conversation-turns">
            {displayTurns.map(({ card, turnNumber, hit }) => (
              <SessionConversationTurn
                key={card.id}
                card={card}
                turnNumber={turnNumber}
                isLatest={turnNumber === turnCount}
                open={isTurnOpen(turnNumber, turnCount, expandMode, openOverrides[card.id], hit)}
                searchHit={hit}
                onToggle={() =>
                  setOpenOverrides((prev) => ({
                    ...prev,
                    [card.id]: !isTurnOpen(turnNumber, turnCount, expandMode, prev[card.id], hit),
                  }))
                }
                onPreviewImage={setPreviewUrl}
              />
            ))}
            {trimmedQuery && displayTurns.length === 0 && (
              <p className="session-conversation-empty">"{trimmedQuery}"와 일치하는 turn이 없습니다.</p>
            )}
          </div>
        </div>
      </div>

      <div
        className="session-conversation-feedbackDock"
        style={dockHeight === null ? undefined : { height: dockHeight }}
      >
        <div
          className="session-conversation-dockHandle"
          role="separator"
          aria-orientation="horizontal"
          aria-label="피드백 영역 높이 조절 (더블클릭하면 기본 높이)"
          tabIndex={0}
          onPointerDown={(event) => {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            dockDragRef.current = { startY: event.clientY, startHeight: currentDockHeight(event.currentTarget) };
          }}
          onPointerMove={(event) => {
            const drag = dockDragRef.current;
            if (!drag) return;
            setDockHeight(clampDock(drag.startHeight + drag.startY - event.clientY));
          }}
          onPointerUp={(event) => {
            if (!dockDragRef.current) return;
            dockDragRef.current = null;
            commitDock(clampDock(currentDockHeight(event.currentTarget)));
          }}
          onPointerCancel={() => {
            dockDragRef.current = null;
          }}
          onDoubleClick={() => commitDock(null)}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const delta = event.key === 'ArrowUp' ? DOCK_KEY_STEP : -DOCK_KEY_STEP;
            commitDock(clampDock(currentDockHeight(event.currentTarget) + delta));
          }}
        />
        {feedbackTarget ? (
          <FeedbackPanel
            cardId={feedbackTarget.id}
            isSubmittingFeedback={isSubmittingFeedback}
            setIsSubmittingFeedback={setIsSubmittingFeedback}
            onCreateFeedback={onCreateFeedback}
            onClose={onClose}
            projectDir={feedbackTarget.projectDir ?? group.projectDir}
            // 지금 읽고 있는 바로 그 세션이다 — 자기 참조는 후보에서 막는다.
            excludeSessionIds={group.sessionId ? [group.sessionId] : undefined}
            // 세션 단위 초안: 새 turn이 끝나 대상 카드가 바뀌어도 쓰던 내용은 남는다.
            draftKey={group.sessionId ? `session:${group.sessionId}` : undefined}
            targetLabel={feedbackTargetTurn > 0 ? `→ T${feedbackTargetTurn}에 이어붙임` : undefined}
          />
        ) : (
          <p className="session-conversation-feedbackDisabled">
            이 세션에는 피드백을 이어 붙일 수 있는 완료된 카드가 없습니다.
          </p>
        )}
      </div>

      {previewUrl && <ImageLightbox src={previewUrl} alt="Screenshot preview" onClose={() => setPreviewUrl(null)} />}
    </DialogSkeleton>
  );
};
