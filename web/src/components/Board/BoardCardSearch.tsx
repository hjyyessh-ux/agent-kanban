import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { exactCardSearchMatch, splitCardSearch, type CardSemanticHit } from '../../../../src/core/card-semantic';
import type { KanbanCard, Work } from '../../../../src/core/types';
import { BOARD_SEARCH_COPY as copy, STATUS_LABELS } from '../../constants/copy';
import { useCardSemanticSearchState } from '../../hooks/useCardSemanticSearch';
import { dirAccentClass } from '../../utils/project-color';
import { buildResumeCommand } from '../../utils/resume-command';
import { previewLine } from '../../utils/text-preview';
import { ResumeCopyButton } from '../shared/IdChip';
import { DEFAULT_BOARD_FILTERS, filterBoardCards, filterUnreadOnly, type BoardFilters } from './board-filters';
import { filterCardsByWork, indexWorksBySession, workForCard, type BoardWorkFilter } from './board-works';
import { getDirectoryProjectName } from './directory-display';

export function boardKeywordMatches(cards: KanbanCard[], query: string) {
  const { keys } = splitCardSearch(query, new Set(cards.map(card => card.id)));
  const cardId = query.replace(/^#/, '');
  const exact = cards.filter(card => card.id === cardId
    || (/^[A-Za-z0-9_-]{8}$/.test(cardId) && card.id.startsWith(cardId))
    || (keys.size > 0 && exactCardSearchMatch(card.id,
      [card.title, card.description, card.progressSummary, card.result].join(' '), keys)));
  return { exact, keyword: filterBoardCards(cards, { ...DEFAULT_BOARD_FILTERS, search: query }) };
}

export function boardSearchRows(exact: CardSemanticHit[], keyword: CardSemanticHit[], semantic: CardSemanticHit[], scope: Map<string, KanbanCard>) {
  const seen = new Set<string>();
  const rows: Array<{ card: KanbanCard; kind: 'exact' | 'keyword' | 'semantic' }> = [];
  let excluded = 0;
  for (const [kind, hits] of [['exact', exact], ['keyword', keyword], ['semantic', semantic]] as const) {
    for (const { id } of hits) {
      if (seen.has(id)) continue;
      seen.add(id);
      const card = scope.get(id);
      if (card) rows.push({ card, kind });
      else excluded++;
    }
  }
  return { rows, excluded };
}

export function useBoardSearch({ enabled, cards, filters, workFilter, works, unread, grouped }: {
  enabled: boolean;
  cards: KanbanCard[];
  filters: BoardFilters;
  workFilter: BoardWorkFilter;
  works: Work[];
  unread: boolean;
  grouped: boolean;
}) {
  const [input, setInput] = useState({ value: '', composing: false });
  const [settled, setSettled] = useState<typeof input | null>(null);
  const scope = useMemo(() => ({
    kind: 'board' as const, filter: { ...filters, search: '' }, unread, grouped,
    work: typeof workFilter === 'string' ? (workFilter === 'all' ? undefined : workFilter) : workFilter.workId,
  }), [filters, unread, grouped, workFilter]);
  const scopeKey = JSON.stringify(scope);
  const [selection, setSelection] = useState<{ input: typeof input; scopeKey: string; id: string } | null>(null);
  const active = enabled && (input.composing || !!input.value.trim());
  const query = active && !input.composing && settled === input ? input.value.trim() : '';

  useEffect(() => {
    if (!enabled || input.composing || !input.value.trim()) return;
    const timer = setTimeout(() => setSettled(input), 200);
    return () => clearTimeout(timer);
  }, [enabled, input]);

  const lexical = useMemo(() => query ? boardKeywordMatches(cards, query) : null, [cards, query]);
  const eligible = useMemo(() => {
    if (!query) return new Map<string, KanbanCard>();
    const filtered = filterBoardCards(cards, scope.filter);
    const byWork = filterCardsByWork(filtered, workFilter, indexWorksBySession(works));
    const visible = unread ? filterUnreadOnly(byWork, { groupBySession: grouped }) : byWork;
    return new Map(visible.map(card => [card.id, card]));
  }, [cards, grouped, query, scope.filter, unread, workFilter, works]);
  const semantic = useCardSemanticSearchState(query, scope);
  const { rows, excluded } = useMemo(() => boardSearchRows(
    lexical?.exact ?? [], lexical?.keyword ?? [], semantic.result?.semantic ?? [], eligible,
  ), [lexical, semantic.result, eligible]);
  const selected = selection?.input === input && selection.scopeKey === scopeKey
    ? rows.find(({ card }) => card.id === selection.id)?.card : undefined;

  const activeFilters = Object.entries(scope.filter).filter(([, value]) => !!value).length
    + Number(!!scope.work) + Number(unread);
  const workLabel = scope.work === 'unassigned' ? 'Work 미배정'
    : works.find(work => work.id === scope.work)?.title;
  const scopeDescription = [copy.boardScope, workLabel, filters.status && STATUS_LABELS[filters.status],
    unread && '미확인만', filters.directory, filters.sessionName, filters.sessionId,
    (filters.createdFrom || filters.createdTo) && `생성일 ${filters.createdFrom} ~ ${filters.createdTo}`,
    (filters.updatedFrom || filters.updatedTo) && `수정일 ${filters.updatedFrom} ~ ${filters.updatedTo}`,
  ].filter(Boolean).join(' · ');

  return {
    input, setInput, active, rows, excluded, selected, activeFilters, scopeDescription,
    phase: input.composing ? 'composing' as const : query ? semantic.phase : 'typing' as const,
    select: (id: string) => setSelection({ input, scopeKey, id }),
  };
}

type SearchProps = { search: ReturnType<typeof useBoardSearch>; onOpen: (card: KanbanCard) => void };
const resultId = (id: string) => `board-search-result-${id}`;

export function BoardSearchInput({ search, onOpen }: SearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (search.input.composing || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && search.selected) {
      event.preventDefault();
      onOpen(search.selected);
    }
    if (!search.rows.length || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    const index = search.rows.findIndex(({ card }) => card.id === search.selected?.id);
    const last = search.rows.length - 1;
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, last) : index < 0 ? last : Math.max(index - 1, 0);
    const id = search.rows[next].card.id;
    search.select(id);
    document.getElementById(resultId(id))?.scrollIntoView({ block: 'nearest' });
  }

  return <div className="app-board-search" role="search" aria-label="보드 카드 검색">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" />
    </svg>
    <input ref={inputRef} type="search" role="combobox" aria-label={copy.label} aria-autocomplete="list" aria-haspopup="grid"
      aria-controls={search.active ? 'board-search-results' : undefined} aria-expanded={search.active}
      aria-activedescendant={search.selected ? resultId(search.selected.id) : undefined}
      aria-describedby="board-search-scope" placeholder={copy.label} autoComplete="off" enterKeyHint="search"
      value={search.input.value} onKeyDown={handleKey}
      onChange={event => {
        const value = event.currentTarget.value;
        search.setInput(previous => ({ ...previous, value }));
      }}
      onCompositionStart={() => search.setInput(previous => ({ ...previous, composing: true }))}
      onCompositionEnd={event => search.setInput({ value: event.currentTarget.value, composing: false })}
    />
    <span className="app-board-search-scope" title={search.scopeDescription} aria-hidden="true">
      {search.activeFilters ? copy.filterScope(search.activeFilters) : copy.boardScope}
    </span>
    <span id="board-search-scope" className="app-board-search-description">{search.scopeDescription}</span>
    {search.input.value && <button type="button" className="app-board-search-clear" aria-label={copy.clear} title={copy.clear} onClick={() => {
      search.setInput({ value: '', composing: false });
      inputRef.current?.focus();
    }}>×</button>}
  </div>;
}

const updatedFormatter = new Intl.DateTimeFormat('ko-KR', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function BoardSearchResults({ search, onOpen, onArchive, loading, works }: SearchProps & {
  onArchive: () => void; loading: boolean; works: readonly Work[];
}) {
  const bySession = useMemo(() => indexWorksBySession(works), [works]);
  const byId = useMemo(() => new Map(works.map(work => [work.id, work])), [works]);
  const message = copy.phase[search.phase];
  const waiting = loading || ['typing', 'composing', 'pending', 'preparing'].includes(search.phase);
  const empty = search.activeFilters ? copy.filteredEmpty : search.phase === 'ready' ? copy.empty : copy.keywordEmpty;
  return <section className="app-board-search-results" aria-labelledby="board-search-heading">
    <header><h2 id="board-search-heading">{copy.results} <span>{!waiting || search.rows.length > 0 ? copy.count(search.rows.length) : ''}</span></h2>
      <button className="kv2-btn kv2-btn--ghost kv2-btn--small" type="button" onClick={onArchive}>{copy.archive} <span aria-hidden="true">↗</span></button>
    </header>
    <ul id="board-search-results" role="grid" aria-label={copy.results}>
      {search.rows.map(({ card, kind }) => {
        const work = workForCard(card, bySession) ?? (card.plannedWorkId ? byId.get(card.plannedWorkId) : undefined);
        const project = getDirectoryProjectName(card.projectDir);
        const updated = Date.parse(card.updatedAt);
        const pr = /(?:\/pull\/|\bPR\s*#?\s*)(\d+)\b/i.exec([card.title, card.description, card.progressSummary, card.result].join(' '))?.[1];
        return <li key={card.id} id={resultId(card.id)} role="row" data-status={card.status}
          className="app-board-search-item" aria-selected={card.id === search.selected?.id}>
          <div role="gridcell">
            <button type="button" tabIndex={-1} className="app-board-search-row"
              onClick={() => { search.select(card.id); onOpen(card); }}>
              <span className="app-board-search-chips">
                {work && <span className="works-dir-chip kv2-project-chip app-board-search-work" title={work.title}>
                  <small>WORK</small> {work.title}
                </span>}
                {project && <span className={`works-dir-chip kv2-project-chip ${dirAccentClass(card.projectDir)}`} title={card.projectDir}>{project}</span>}
              </span>
              <span className="app-board-search-state">{STATUS_LABELS[card.status]}</span>
              <span className="app-board-search-title">
                <strong>{card.title}</strong>
                {kind !== 'keyword' && <span className="app-board-search-match">{copy[kind]}</span>}
                {pr && <span className="app-board-search-pr">PR #{pr}</span>}
              </span>
              <span className="app-board-search-preview">{previewLine(card.description || card.progressSummary || card.result)}</span>
              {Number.isFinite(updated) && <span className="app-board-search-updated">
                <span>마지막 업데이트</span>
                <time dateTime={card.updatedAt}>{updatedFormatter.format(updated)}</time>
              </span>}
            </button>
          </div>
          <div role="gridcell">
            {card.sessionId && <ResumeCopyButton className="app-board-search-resume"
              command={buildResumeCommand(card.agentRuntime, card.sessionId, card.projectDir)} />}
          </div>
        </li>;
      })}
    </ul>
    <div role="status" className="app-board-search-message">
      {!waiting && !search.rows.length && <strong>{empty}</strong>}
      {search.excluded > 0 && <span>{copy.excluded(search.excluded)}</span>}
      {message && <span>{message}</span>}
    </div>
  </section>;
}
