import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  CardWikiState,
  KanbanCard,
  WikiArchiveCardStatusFilter,
  WikiConfigDto,
  WikiConfigInput,
  WikiDocType,
  WikiWorkerStatus,
} from '../../../../src/core/types';
import {
  fetchWikiArchive,
  fetchWikiArchiveCards,
  fetchWikiConfig,
  fetchWikiStatus,
  reprocessWikiCards,
  restartWikiWorker,
  runWikiBackfill,
  saveWikiConfig,
} from '../../hooks/useWikiApi';
import { WikiConfigPanel } from './WikiConfigPanel';
import { WikiCardDialog } from './WikiCardDialog';
import { WikiGraph } from './WikiGraph';
import { SessionConversationModal } from '../Board/SessionConversationModal';
import {
  groupCompleteCardsBySession,
  type CompleteSessionGroup,
} from '../Board/BoardCompleteSessionView';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { getDirectoryProjectName } from '../Board/directory-display';
import './Wiki.css';

const POLL_INTERVAL_MS = 10_000;
const ARCHIVE_CARDS_PAGE_SIZE = 100;

/** Visual order + labels for the five fixed wiki document types (kanban columns). */
const DOC_TYPES: { key: WikiDocType; label: string }[] = [
  { key: 'troubleshooting', label: 'Trouble' },
  { key: 'howto', label: 'How-to' },
  { key: 'decision', label: 'Decision' },
  { key: 'concept', label: 'Concept' },
  { key: 'reference', label: 'Reference' },
];

type DecisionFilter = 'kept' | 'skipped' | 'failed' | 'unprocessed' | 'pending';
type WikiMode = 'documents' | 'cards' | 'archive';
type WikiViewMode = 'graph' | 'board' | 'list';

function defaultViewMode(mode: WikiMode, filter?: DecisionFilter | null): WikiViewMode {
  if (mode === 'documents') return 'graph';
  if (filter === 'kept') return 'board';
  return 'list';
}

function matchesDecision(wiki: CardWikiState | undefined, filter: DecisionFilter): boolean {
  if (filter === 'kept') return wiki?.decision === 'kept';
  if (filter === 'unprocessed') return !wiki;
  if (!wiki) return false;
  if (filter === 'pending') return wiki.status === 'pending';
  if (filter === 'failed') return wiki.status === 'failed';
  if (filter === 'skipped') return wiki.decision === 'skipped';
  return true;
}

function formatDate(iso?: string): string {
  return iso ? iso.slice(0, 10) : '';
}

function formatTime(iso?: string): string {
  return iso ? iso.slice(11, 19) : '';
}

/** First non-empty line of a multi-line string, for compact prompt previews. */
function firstLine(value?: string): string {
  return value?.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

function statusLabel(status: WikiWorkerStatus | null): string {
  if (!status) return '...';
  if (!status.enabled) return 'Disabled';
  if (status.running) return 'Processing';
  return 'Idle';
}

function statusClass(status: WikiWorkerStatus | null): string {
  if (!status || !status.enabled) return 'wiki-status--idle';
  if (status.running) return 'wiki-status--running';
  return 'wiki-status--idle';
}

function routeLabel(route?: WikiWorkerStatus['route'] | WikiConfigDto['route'], model?: string): string {
  const resolved = route ?? (model ? (model.startsWith('gpt') ? 'codex' : 'claude') : undefined);
  if (resolved === 'codex') return 'Codex CLI';
  if (resolved === 'claude') return 'Claude CLI';
  return '—';
}

/**
 * A rendered wiki tile. Kept cards that share the same generated document
 * (one session → many cards → one doc) collapse into a single tile, so the
 * board/list show one entry per document instead of N duplicates.
 */
export interface WikiTile {
  /** Representative card (most recently processed in the group). */
  card: KanbanCard;
  /** All card ids collapsed into this tile (≥1) — used to re-queue the whole group. */
  cardIds: string[];
  count: number;
}

/**
 * Collapse cards by their kept docPath while preserving first-seen order.
 * Cards without a kept document (skipped/failed/pending/unprocessed) never
 * collapse — each keeps its own tile.
 */
function collapseByDoc(cards: KanbanCard[]): WikiTile[] {
  const byDoc = new Map<string, WikiTile>();
  const tiles: WikiTile[] = [];
  for (const card of cards) {
    const docPath = card.wiki?.decision === 'kept' ? card.wiki.docPath : undefined;
    if (!docPath) {
      tiles.push({ card, cardIds: [card.id], count: 1 });
      continue;
    }
    const existing = byDoc.get(docPath);
    if (existing) {
      existing.cardIds.push(card.id);
      existing.count += 1;
      if ((card.wiki?.processedAt ?? '') > (existing.card.wiki?.processedAt ?? '')) {
        existing.card = card;
      }
    } else {
      const tile: WikiTile = { card, cardIds: [card.id], count: 1 };
      byDoc.set(docPath, tile);
      tiles.push(tile);
    }
  }
  return tiles;
}

export function WikiView() {
  const [status, setStatus] = useState<WikiWorkerStatus | null>(null);
  const [config, setConfig] = useState<WikiConfigDto | null>(null);
  const [loadedMonths, setLoadedMonths] = useState<string[]>([]);
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<WikiMode>('documents');
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('kept');
  const [archiveCards, setArchiveCards] = useState<KanbanCard[]>([]);
  const [archiveCursor, setArchiveCursor] = useState<string | null>(null);
  const [archiveStatusFilter, setArchiveStatusFilter] = useState<WikiArchiveCardStatusFilter>('all');
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveLoadingMore, setArchiveLoadingMore] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [viewMode, setViewMode] = useState<WikiViewMode>('graph');
  const [selectedCard, setSelectedCard] = useState<KanbanCard | null>(null);
  const [archiveSession, setArchiveSession] = useState<CompleteSessionGroup | null>(null);
  const wasRunning = useRef(false);
  const archiveRequestSeq = useRef(0);

  const refreshStatus = useCallback(async () => {
    try {
      const next = await fetchWikiStatus();
      setStatus(next);
      return next;
    } catch {
      setStatus(null);
      return null;
    }
  }, []);

  const refreshConfig = useCallback(async () => {
    try {
      const next = await fetchWikiConfig();
      setConfig(next);
      return next;
    } catch {
      setConfig(null);
      return null;
    }
  }, []);

  const handleSaveConfig = useCallback(async (input: WikiConfigInput) => {
    setError(null);
    try {
      const next = await saveWikiConfig(input);
      setConfig(next);
      await refreshStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save wiki config');
      throw err;
    }
  }, [refreshStatus]);

  const reloadLoadedMonths = useCallback(async (monthsToLoad: string[]) => {
    setLoading(true);
    try {
      const responses = await Promise.all(monthsToLoad.map(m => fetchWikiArchive(m)));
      setCards(responses.flatMap(r => r.cards));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wiki archive');
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadArchiveCards = useCallback(async () => {
    const requestId = archiveRequestSeq.current + 1;
    archiveRequestSeq.current = requestId;
    setArchiveLoading(true);
    setArchiveError(null);
    try {
      const response = await fetchWikiArchiveCards({
        limit: ARCHIVE_CARDS_PAGE_SIZE,
        status: archiveStatusFilter,
        q: query,
      });
      if (archiveRequestSeq.current !== requestId) return;
      setArchiveCards(response.cards);
      setArchiveCursor(response.nextCursor);
    } catch (err) {
      if (archiveRequestSeq.current !== requestId) return;
      setArchiveError(err instanceof Error ? err.message : 'Failed to load archive cards');
      setArchiveCards([]);
      setArchiveCursor(null);
    } finally {
      if (archiveRequestSeq.current === requestId) setArchiveLoading(false);
    }
  }, [archiveStatusFilter, query]);

  // Initial load: worker status + every archive month up front, so the graph
  // view always renders the full dataset instead of only the latest month.
  useEffect(() => {
    let cancelled = false;
    void refreshStatus();
    void refreshConfig();
    setLoading(true);
    fetchWikiArchive()
      .then(async (res) => {
        if (cancelled) return;
        if (res.months.length === 0) {
          setCards(res.cards);
          setLoadedMonths(res.month ? [res.month] : []);
          return;
        }
        await reloadLoadedMonths(res.months);
        if (!cancelled) setLoadedMonths(res.months);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load wiki archive');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshStatus, refreshConfig, reloadLoadedMonths]);

  useEffect(() => {
    if (mode === 'archive') {
      void reloadArchiveCards();
    }
  }, [mode, reloadArchiveCards]);

  useEffect(() => {
    if (config && !config.configured) {
      setShowOptions(true);
    }
  }, [config]);

  // Status polling — refresh the list when a processing run finishes.
  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshStatus().then((next) => {
        if (!next) return;
        if (wasRunning.current && !next.running && loadedMonths.length > 0) {
          void reloadLoadedMonths(loadedMonths);
          if (mode === 'archive') void reloadArchiveCards();
        }
        wasRunning.current = next.running;
      });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshStatus, reloadLoadedMonths, reloadArchiveCards, loadedMonths, mode]);

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshStatus();
      if (loadedMonths.length > 0) await reloadLoadedMonths(loadedMonths);
      if (mode === 'archive') await reloadArchiveCards();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const handleBackfill = () => withBusy(async () => { await runWikiBackfill(); });
  const handleReprocess = (cardIds: string[]) => withBusy(async () => { await reprocessWikiCards(cardIds); });
  const handleRestart = () => withBusy(async () => { setStatus(await restartWikiWorker()); });
  const handleSelectStat = (targetMode: WikiMode, filter?: DecisionFilter | null) => {
    setMode(targetMode);
    if (filter) setDecisionFilter(filter);
    if (targetMode === 'archive') setArchiveStatusFilter('all');
    setViewMode(defaultViewMode(targetMode, filter));
  };
  const handleReprocessAllFailed = () => withBusy(async () => {
    const cardIds: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await fetchWikiArchiveCards({
        limit: 200,
        cursor,
        status: 'failed',
      });
      cardIds.push(...response.cards.map((card) => card.id));
      cursor = response.nextCursor;
    } while (cursor);

    if (cardIds.length > 0) {
      await reprocessWikiCards(cardIds);
    }
  });

  const handleLoadMoreArchiveCards = async () => {
    if (!archiveCursor || archiveLoadingMore) return;
    setArchiveLoadingMore(true);
    setArchiveError(null);
    try {
      const response = await fetchWikiArchiveCards({
        limit: ARCHIVE_CARDS_PAGE_SIZE,
        cursor: archiveCursor,
        status: archiveStatusFilter,
        q: query,
      });
      setArchiveCards((prev) => [...prev, ...response.cards]);
      setArchiveCursor(response.nextCursor);
    } catch (err) {
      setArchiveError(err instanceof Error ? err.message : 'Failed to load more archive cards');
    } finally {
      setArchiveLoadingMore(false);
    }
  };

  // Collapse loaded archive cards into one row per session (same as the board's
  // "SESSION 모아보기"), so repeated turns of one session stop duplicating.
  // Clicking a row reuses the SessionConversationModal turn timeline.
  const archiveGroups = useMemo(
    () => groupCompleteCardsBySession(archiveCards),
    [archiveCards],
  );

  const stats = status?.stats;
  const activeDecisionFilter = mode === 'documents' ? 'kept' : decisionFilter;

  // Client-side filter over the months loaded so far.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return cards.filter((card) => {
      if (!matchesDecision(card.wiki, activeDecisionFilter)) return false;
      if (q) {
        const haystack = [
          card.title, card.wiki?.docTitle, card.wiki?.docPath, ...(card.wiki?.topics ?? []),
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [cards, activeDecisionFilter, query]);

  // Collapse cards sharing one generated document into a single tile.
  const tiles = useMemo(() => collapseByDoc(filtered), [filtered]);

  const supportsGraph = mode === 'documents';
  const supportsBoard = mode === 'documents' || (mode === 'cards' && decisionFilter === 'kept');
  const effectiveViewMode: WikiViewMode = supportsGraph || viewMode !== 'graph'
    ? viewMode
    : defaultViewMode(mode, decisionFilter);
  const isColumns = mode !== 'archive' && effectiveViewMode === 'board' && supportsBoard;
  const columns = useMemo(() => {
    const map: Record<WikiDocType, WikiTile[]> = {
      troubleshooting: [], howto: [], decision: [], concept: [], reference: [],
    };
    if (isColumns) {
      for (const tile of tiles) {
        const t = tile.card.wiki?.docType;
        if (t) map[t].push(tile);
      }
    }
    return map;
  }, [tiles, isColumns]);

  const range = loadedMonths.length > 0 ? `${loadedMonths[loadedMonths.length - 1]} ~ ${loadedMonths[0]}` : '';

  function reprocessButton(tile: WikiTile) {
    const pending = tile.card.wiki?.status === 'pending';
    const tip = pending
      ? '이미 처리 대기 중입니다'
      : tile.count > 1
        ? `다시 처리 — 이 문서로 묶인 카드 ${tile.count}장을 모두 다시 분류·재생성합니다`
        : '다시 처리 — 이 카드를 위키 분류 파이프라인에 다시 넣어 문서를 재생성합니다';
    return (
      <button
        type="button"
        className="neo-button neo-button--sm neo-button--ghost wiki-reprocess"
        onClick={(e) => { e.stopPropagation(); void handleReprocess(tile.cardIds); }}
        disabled={busy || pending}
        title={tip}
        aria-label={tip}
        data-tip={tip}
      >↻</button>
    );
  }

  return (
    <div className="wiki-view">
      {/* ─── Page hero + collapsed options entry ──────────────────── */}
      <section className="wiki-hero">
        <div className="wiki-hero-copy">
          <span className="wiki-hero-kicker">LLM Wiki</span>
          <h2 className="wiki-hero-title">Done 카드가 Obsidian 지식 문서가 됩니다</h2>
          <p className="wiki-hero-desc">
            완료된 작업 기록을 읽고 보존할 내용만 선별해 troubleshooting, how-to, decision, concept, reference 문서로 정리합니다.
          </p>
          <div className="wiki-pipeline" aria-label="LLM Wiki 처리 흐름">
            <span>Done Archive</span>
            <span>LLM Triage</span>
            <span>Type 분류</span>
            <span>Obsidian 저장</span>
          </div>
        </div>

        <div className="wiki-hero-control">
          <div className="wiki-hero-status-card">
            <span className={`wiki-status ${statusClass(status)}`}>
              {statusLabel(status)}
              {status?.running && status.totalInRun > 0 && ` ${status.processedInRun}/${status.totalInRun}`}
            </span>
            <div className="wiki-hero-metrics">
              <span><strong>{stats?.pending ?? status?.pendingCount ?? 0}</strong> pending</span>
              <span><strong>{stats?.failed ?? 0}</strong> failed</span>
              {status?.lastFinishedAt && !status.running && (
                <span title="마지막 처리 완료 시각"><strong>{formatTime(status.lastFinishedAt)}</strong> last</span>
              )}
            </div>
          </div>
          <button
            type="button"
            className={`wiki-options-trigger ${showOptions ? 'is-active' : ''}`}
            onClick={() => setShowOptions(v => !v)}
            aria-expanded={showOptions}
            aria-controls="wiki-options-panel"
            title="Wiki options"
          >
            <span aria-hidden="true">⚙</span>
            <span>Options</span>
          </button>
        </div>
      </section>

      {/* ─── Options drawer: config, worker actions, logs ─────────── */}
      {showOptions && (
        <section className="wiki-options-panel" id="wiki-options-panel">
          <div className="wiki-options-section wiki-options-section--unified">
            <div className="wiki-options-section-head">
              <h3>Settings</h3>
              <span>
                {config ? routeLabel(config.route, config.model) : '—'}
                {status ? ` · ${statusLabel(status)} · prompt v${status.promptVersion}` : ''}
              </span>
            </div>
            {config && (
              <WikiConfigPanel config={config} busy={busy} onSave={handleSaveConfig} />
            )}

            <div className="wiki-worker-actions">
              <div className="wiki-backfill-note">
                <strong>Backfill 최신 500</strong>
                <span>
                  미처리, 실패, 오래된 프롬프트 버전의 아카이브 카드 후보를 최신 updatedAt 순으로 최대 500개만 pending 큐에 넣습니다.
                </span>
              </div>
              <div className="wiki-options-actions">
                <button
                  type="button"
                  className="neo-button neo-button--secondary"
                  onClick={() => setShowLogs(v => !v)}
                  title="워커 활동 로그 보기"
                >
                  Logs {showLogs ? '▴' : '▾'}
                </button>
                <button
                  type="button"
                  className="neo-button neo-button--secondary"
                  onClick={() => { void handleRestart(); }}
                  disabled={busy}
                  title="워커 상태를 리셋하고 타이머를 재시작합니다"
                >
                  Restart
                </button>
                <button
                  type="button"
                  className="neo-button neo-button--primary"
                  onClick={() => { void handleBackfill(); }}
                  disabled={busy || !status?.enabled}
                  title="가장 최근 500장까지만 큐잉합니다 (토큰 보호)"
                >
                  Backfill (최신 500)
                </button>
              </div>
            </div>
          </div>

          {showLogs && (
            <div className="wiki-logs">
              {status && status.recentLogs.length > 0 ? (
                <ul className="wiki-log-list">
                  {[...status.recentLogs].reverse().map((log, i) => (
                    <li key={`${log.at}-${i}`} className={`wiki-log wiki-log--${log.level}`}>
                      <span className="wiki-log-time">{formatTime(log.at)}</span>
                      <span className="wiki-log-level">{log.level}</span>
                      {log.route && (
                        <span className="wiki-log-meta">{log.route}/{log.model ?? 'model'} · {log.effort ?? 'effort'}</span>
                      )}
                      <span className="wiki-log-msg">{log.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="wiki-log-empty">아직 워커 활동 로그가 없습니다.</p>
              )}
            </div>
          )}
        </section>
      )}

      {/* ─── Stat cards (clickable filters) ───────────────────────── */}
      {stats && (
        <div className="wiki-stat-cards">
          {([
            ['documents', null, stats.docCount, '문서', 'docs'],
            ['archive', null, stats.total, 'Archive Cards', 'archive'],
            ['cards', 'failed', stats.failed, 'Failed', 'failed'],
            ['cards', 'pending', stats.pending, 'Pending', 'pending'],
            ['cards', 'skipped', stats.skipped, 'Skipped', 'skipped'],
            ['cards', 'unprocessed', stats.unprocessed, '미처리', 'unprocessed'],
          ] as [WikiMode, DecisionFilter | null, number, string, string][]).map(([targetMode, filter, num, label, accent]) => {
            const active = targetMode === 'documents'
              ? mode === 'documents'
              : targetMode === 'archive'
                ? mode === 'archive'
                : mode === 'cards' && decisionFilter === filter;
            return (
            <button
              key={accent}
              type="button"
              className={`wiki-stat wiki-stat--${accent} ${active ? 'is-active' : ''} ${filter === 'pending' && status?.running ? 'is-running' : ''}`}
              onClick={() => handleSelectStat(targetMode, filter)}
            >
              <span className="wiki-stat-num">{num}</span>
              <span className="wiki-stat-label">{label}</span>
            </button>
            );
          })}
        </div>
      )}

      {status?.lastError && <p className="wiki-error">Last error: {status.lastError}</p>}
      {error && <p className="wiki-error" role="alert">{error}</p>}

      {/* ─── Search bar + view toggle ─────────────────────────────── */}
      <div className="wiki-filterbar">
        <input
          type="search"
          className="wiki-search"
          placeholder={mode === 'archive' ? '제목·프롬프트·프로젝트 검색' : '제목·문서·토픽 검색'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {mode === 'archive' ? null : (
          <div className="wiki-viewtoggle" role="group" aria-label="보기 방식">
            {supportsGraph && (
              <button
                type="button"
                className={`wiki-viewbtn ${effectiveViewMode === 'graph' ? 'is-active' : ''}`}
                onClick={() => setViewMode('graph')}
                title="문서·프로젝트·토픽 관계를 그래프로 보기"
              >◉ 그래프</button>
            )}
            {supportsBoard && (
              <button
                type="button"
                className={`wiki-viewbtn ${effectiveViewMode === 'board' ? 'is-active' : ''}`}
                onClick={() => setViewMode('board')}
                title="분류(type)별 칸반 컬럼 보기"
              >▦ 보드</button>
            )}
            <button
              type="button"
              className={`wiki-viewbtn ${effectiveViewMode === 'list' ? 'is-active' : ''}`}
              onClick={() => setViewMode('list')}
              title="한 줄씩 나열된 리스트 보기"
            >☰ 리스트</button>
          </div>
        )}
        {mode === 'cards' && decisionFilter === 'failed' && (stats?.failed ?? 0) > 0 && (
          <button
            type="button"
            className="neo-button neo-button--sm neo-button--primary wiki-retry-failed"
            onClick={() => { void handleReprocessAllFailed(); }}
            disabled={busy}
            title={`Archive 전체에서 Failed 카드 ${stats?.failed ?? 0}장을 모두 다시 처리 대기열에 넣습니다`}
          >
            전체 Failed 재시도 ({stats?.failed ?? 0})
          </button>
        )}
        <span className="wiki-filter-summary">
          {mode === 'archive' ? (
            <>
              세션 {archiveGroups.length}개 · 카드 {archiveCards.length}건 로드
              {archiveCursor ? ' · 더 있음' : ''}
            </>
          ) : (
            <>
              {range && `${range} · `}
              {tiles.length}건 표시
            </>
          )}
          {query && (
            <button type="button" className="wiki-clear" onClick={() => setQuery('')}>검색 해제</button>
          )}
        </span>
      </div>

      {/* ─── Body: graph (default) / kanban columns (kept) / list ─── */}
      {mode === 'archive' ? (
        <div className="wiki-archive-panel">
          {archiveError && <p className="wiki-error" role="alert">Archive Cards error: {archiveError}</p>}
          {archiveLoading && archiveCards.length === 0 ? (
            <div className="wiki-empty">Archive Cards를 불러오는 중…</div>
          ) : archiveCards.length === 0 ? (
            <div className="wiki-empty">
              {archiveError ? 'Archive Cards를 불러오지 못했습니다.' : '조건에 맞는 아카이브 카드가 없습니다.'}
            </div>
          ) : (
            <ul className="wiki-list wiki-list--archive">
              {archiveGroups.map((group) => {
                // group.cards is newest-first; the oldest turn carries the
                // original request, matching the session title.
                const firstTurn = group.cards[group.cards.length - 1];
                const prompt = firstLine(firstTurn?.description);
                return (
                  <li
                    key={group.key}
                    className="wiki-item wiki-item--clickable wiki-item--archive"
                    role="button"
                    tabIndex={0}
                    onClick={() => setArchiveSession(group)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setArchiveSession(group); } }}
                    title="클릭하면 이 세션 대화를 Turn별로 봅니다"
                  >
                    <div className="wiki-archive-title-row">
                      <span className="wiki-archive-title" title={group.title}>{group.title}</span>
                      {group.cards.length > 1 && (
                        <span className="wiki-archive-turns" title={`이 세션에 묶인 카드(턴) ${group.cards.length}개`}>
                          {group.cards.length} turns
                        </span>
                      )}
                    </div>
                    {prompt && <p className="wiki-archive-desc">{prompt}</p>}
                    <div className="wiki-archive-meta">
                      <RuntimeBadge runtime={group.agentRuntime} />
                      {group.projectDir && (
                        <span className="wiki-archive-project" title={group.projectDir}>
                          {getDirectoryProjectName(group.projectDir)}
                        </span>
                      )}
                      <span className="wiki-archive-date" title="세션 마지막 업데이트">
                        updated {formatDate(group.lastUpdatedAt)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="wiki-footer">
            <button
              type="button"
              className="neo-button neo-button--secondary"
              onClick={() => { void handleLoadMoreArchiveCards(); }}
              disabled={!archiveCursor || archiveLoading || archiveLoadingMore}
            >
              {archiveLoadingMore ? 'Loading…' : archiveCursor ? 'Load more' : 'No more cards'}
            </button>
          </div>
        </div>
      ) : effectiveViewMode === 'graph' && supportsGraph ? (
        <WikiGraph tiles={tiles} onSelect={setSelectedCard} />
      ) : isColumns ? (
        <div className="wiki-board">
          {DOC_TYPES.map((t) => (
            <div key={t.key} className={`wiki-col wiki-col--${t.key}`}>
              <div className="wiki-col-header">
                <span className="wiki-col-name">{t.label}</span>
                <span className="wiki-col-count">{columns[t.key].length}</span>
              </div>
              <div className="wiki-col-body">
                {columns[t.key].length === 0 ? (
                  <div className="wiki-col-empty">—</div>
                ) : (
                  columns[t.key].map((tile) => {
                    const card = tile.card;
                    return (
                    <div
                      key={card.wiki?.docPath ?? card.id}
                      className="wiki-card wiki-card--clickable"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedCard(card)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedCard(card); } }}
                      title="클릭하면 상세·생성된 문서를 봅니다"
                    >
                      <div className="wiki-card-top">
                        <span className="wiki-card-title" title={card.wiki?.docTitle ?? card.title}>
                          {card.wiki?.docTitle ?? card.title}
                        </span>
                        {tile.count > 1 && (
                          <span className="wiki-card-count" title={`이 문서로 묶인 카드 ${tile.count}장`}>
                            {tile.count}개 카드
                          </span>
                        )}
                        {reprocessButton(tile)}
                      </div>
                      {card.wiki?.docPath && (
                        <code className="wiki-card-path" title={card.wiki.docPath}>{card.wiki.docPath}</code>
                      )}
                      {(card.wiki?.topics?.length ?? 0) > 0 && (
                        <div className="wiki-topics">
                          {card.wiki!.topics!.map(tp => <span key={tp} className="wiki-topic">#{tp}</span>)}
                        </div>
                      )}
                      <span className="wiki-card-date" title="위키 문서로 분류·처리된 날짜">
                        처리됨 {formatDate(card.wiki?.processedAt)}
                      </span>
                    </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      ) : tiles.length === 0 && !loading ? (
        <div className="wiki-empty">해당 상태의 카드가 없습니다.</div>
      ) : (
        <ul className="wiki-list">
          {tiles.map((tile) => {
            const card = tile.card;
            const w = card.wiki;
            const kept = w?.decision === 'kept';
            const badgeLabel = kept && w?.docType
              ? w.docType
              : w?.decision === 'skipped'
                ? 'skipped'
                : w?.status === 'failed'
                  ? 'failed'
                  : w?.status === 'pending'
                    ? 'pending'
                    : 'unprocessed';
            const badgeClass = kept && w?.docType
              ? `wiki-type-badge--${w.docType}`
              : `wiki-state-badge--${badgeLabel}`;
            return (
              <li
                key={kept && w?.docPath ? w.docPath : card.id}
                className="wiki-item wiki-item--clickable"
                role="button"
                tabIndex={0}
                onClick={() => setSelectedCard(card)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedCard(card); } }}
                title="클릭하면 상세·생성된 문서를 봅니다"
              >
                <div className="wiki-item-head">
                  <span className={`neo-badge wiki-list-badge ${badgeClass}`}>{badgeLabel}</span>
                  <span className="wiki-item-title" title={w?.docTitle ?? card.title}>{w?.docTitle ?? card.title}</span>
                  {tile.count > 1 && (
                    <span className="wiki-card-count" title={`이 문서로 묶인 카드 ${tile.count}장`}>
                      {tile.count}개 카드
                    </span>
                  )}
                  <span className="wiki-item-date" title="위키 처리 날짜">
                    {w?.processedAt ? `처리됨 ${formatDate(w.processedAt)}` : ''}
                  </span>
                  {reprocessButton(tile)}
                </div>
                <div className="wiki-item-body">
                  {kept ? (
                    <>
                      {w?.docPath && <code className="wiki-card-path" title={w.docPath}>{w.docPath}</code>}
                      {(w?.topics?.length ?? 0) > 0 && (
                        <span className="wiki-topics">
                          {w!.topics!.map(tp => <span key={tp} className="wiki-topic">#{tp}</span>)}
                        </span>
                      )}
                    </>
                  ) : w?.decision === 'skipped' ? (
                    <span className="wiki-skip-reason">skip: {w.skipReason}</span>
                  ) : w?.status === 'failed' ? (
                    <span className="wiki-fail-reason">error: {w.error}</span>
                  ) : w?.status === 'pending' ? (
                    <span className="wiki-skip-reason">처리 대기 중…</span>
                  ) : (
                    <span className="wiki-skip-reason">아직 위키 처리 안 됨</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {selectedCard && (
        <WikiCardDialog
          card={selectedCard}
          vaultDir={status?.vaultDir ?? ''}
          busy={busy}
          onReprocess={(id) => {
            // Re-queue the whole document group, not just the clicked card, so the
            // doc regenerates from the full session instead of shrinking to one card.
            const dp = selectedCard.wiki?.decision === 'kept' ? selectedCard.wiki.docPath : undefined;
            const sourceCards = mode === 'archive' ? archiveCards : cards;
            const groupIds = dp
              ? sourceCards.filter(c => c.wiki?.decision === 'kept' && c.wiki?.docPath === dp).map(c => c.id)
              : [id];
            void handleReprocess(groupIds.length > 0 ? groupIds : [id]);
            setSelectedCard(null);
          }}
          onClose={() => setSelectedCard(null)}
        />
      )}

      {archiveSession && (
        <SessionConversationModal
          group={archiveSession}
          status="done"
          onClose={() => setArchiveSession(null)}
          onCreateFeedback={async () => { /* archive view is read-only history */ }}
        />
      )}
    </div>
  );
}
