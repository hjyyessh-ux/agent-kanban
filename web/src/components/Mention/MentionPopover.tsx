import React from 'react';
import type { MentionKind } from '../../../../src/core/mention-reference';
import type {
  MentionCandidate,
  MentionSearchResponse,
} from '../../../../src/core/mention-search';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { dirAccentClass } from '../Works/worksAffinity';

/**
 * `@` 멘션 팝오버 — 탭 4개 · 그룹 리스트 · 스니펫.
 *
 * 모달이 아니다. 오버레이도 백드롭도 없고 `DialogSkeleton`도 쓰지 않는다
 * (`docs/design-system.md`). 위치는 `useAnchoredPopover`가 body 포털에 고정
 * 좌표로 잡아 주고, 이 컴포넌트는 **그리기만** 한다. 선택 상태와 키보드는 전부
 * `MentionTextarea`에 있다 — 키가 textarea에서 발생하므로 거기가 유일하게
 * 옳은 자리다.
 */

export type MentionTab = 'all' | 'session' | 'work' | 'doc';

export const MENTION_TABS: { id: MentionTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'session', label: 'Sessions' },
  { id: 'work', label: 'Works' },
  { id: 'doc', label: 'Docs' },
];

/** All 탭이 종류별로 섞어 보여주는 개수. */
const ALL_TAB_PER_KIND = 3;

const KIND_ICON: Record<MentionKind, string> = {
  session: '🧵',
  work: '🗂',
  doc: '📄',
};

const GROUP_LABEL: Record<MentionKind, string> = {
  session: '🧵 Sessions',
  work: '🗂 Works',
  doc: '📄 Docs (Wiki)',
};

/** 상태 dot의 색 캐리어(`kv2/mention.css`)를 고르는 규칙 — 보드와 같은 4종. */
function statusModifier(status: string | undefined): string {
  if (status === 'todo' || status === 'in_progress' || status === 'complete' || status === 'done') {
    return status;
  }
  return 'unknown';
}

export type MentionRowItem =
  | { type: 'group'; kind: MentionKind; label: string }
  | { type: 'row'; candidate: MentionCandidate; index: number };

export interface MentionRows {
  /** 헤딩까지 포함한 렌더 순서. */
  items: MentionRowItem[];
  /** 키보드가 이동하는 후보들. `items`의 `index`가 이 배열의 첨자다. */
  candidates: MentionCandidate[];
}

/**
 * 응답을 탭에 맞는 렌더 목록으로 편다.
 *
 * All 탭은 종류별 최근 `ALL_TAB_PER_KIND`개를 헤딩과 함께 섞고, 종류 탭은 그
 * 그룹만 헤딩 없이 전부 보여준다. 키보드가 쓰는 `candidates`를 같은 함수가 같은
 * 순서로 만들기 때문에 화면 순서와 `↑↓` 순서가 어긋날 수 없다.
 */
export function buildMentionRows(
  data: MentionSearchResponse | null,
  tab: MentionTab,
): MentionRows {
  const items: MentionRowItem[] = [];
  const candidates: MentionCandidate[] = [];
  if (!data) return { items, candidates };

  const groups: { kind: MentionKind; list: MentionCandidate[] }[] = [
    { kind: 'session', list: data.groups.sessions },
    { kind: 'work', list: data.groups.works },
    { kind: 'doc', list: data.groups.docs },
  ];

  for (const group of groups) {
    if (tab !== 'all' && tab !== group.kind) continue;
    const shown = tab === 'all' ? group.list.slice(0, ALL_TAB_PER_KIND) : group.list;
    if (shown.length === 0) continue;
    if (tab === 'all') {
      items.push({ type: 'group', kind: group.kind, label: GROUP_LABEL[group.kind] });
    }
    for (const candidate of shown) {
      items.push({ type: 'row', candidate, index: candidates.length });
      candidates.push(candidate);
    }
  }

  return { items, candidates };
}

/** 검색어가 걸린 구간을 `<mark>`로 감싼다. 매칭이 없으면 원문 그대로. */
function highlight(text: string, query: string): React.ReactNode {
  const needle = query.trim();
  if (!needle) return text;
  const at = text.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark>{text.slice(at, at + needle.length)}</mark>
      {text.slice(at + needle.length)}
    </>
  );
}

/** `/Users/user/workspace/agent-kanban` → `agent-kanban`. */
function directoryName(projectDir: string): string {
  const parts = projectDir.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? projectDir;
}

interface MentionPopoverProps {
  popoverRef: React.RefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
  query: string;
  tab: MentionTab;
  onTabChange: (tab: MentionTab) => void;
  data: MentionSearchResponse | null;
  rows: MentionRows;
  activeIndex: number;
  loading: boolean;
  error: string | null;
  onHover: (index: number) => void;
  onSelect: (candidate: MentionCandidate) => void;
  listId: string;
  optionId: (index: number) => string;
}

export const MentionPopover: React.FC<MentionPopoverProps> = ({
  popoverRef,
  style,
  query,
  tab,
  onTabChange,
  data,
  rows,
  activeIndex,
  loading,
  error,
  onHover,
  onSelect,
  listId,
  optionId,
}) => {
  const totals = data?.totals;
  const tabCount = (id: MentionTab): number | undefined => {
    if (!totals) return undefined;
    if (id === 'all') return totals.sessions + totals.works + totals.docs;
    if (id === 'session') return totals.sessions;
    if (id === 'work') return totals.works;
    return totals.docs;
  };

  return (
    <div
      ref={popoverRef}
      className="kv2-mention-pop"
      style={style}
      role="dialog"
      aria-label="참조 검색"
      // 행을 클릭해도 textarea가 포커스를 잃지 않아야 캐럿이 살아 있다.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="kv2-mention-tabs" role="tablist" aria-label="참조 종류">
        {MENTION_TABS.map(({ id, label }) => {
          const count = tabCount(id);
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`kv2-mention-tab${tab === id ? ' is-active' : ''}`}
              onClick={() => onTabChange(id)}
            >
              {label}
              {count !== undefined && <span className="kv2-mention-tab-count">{count}</span>}
            </button>
          );
        })}
      </div>

      <div className="kv2-mention-query">
        <span>
          {query ? (
            <>
              검색어 <span className="kv2-mention-query-term">{query}</span>
            </>
          ) : (
            '최근 항목'
          )}
          {loading && ' · 검색 중…'}
        </span>
        <span className="kv2-mention-keys" aria-hidden="true">
          <span className="kv2-mention-key">↑↓</span>
          <span className="kv2-mention-key">Tab 탭이동</span>
          <span className="kv2-mention-key">⏎ 선택</span>
          <span className="kv2-mention-key">Esc</span>
        </span>
      </div>

      <div className="kv2-mention-list" id={listId} role="listbox" aria-label="참조 후보">
        {error && <div className="kv2-mention-empty">{error}</div>}
        {!error && rows.items.length === 0 && (
          <div className="kv2-mention-empty">
            {loading ? '검색 중…' : '일치하는 참조가 없습니다'}
          </div>
        )}
        {!error
          && rows.items.map((item) => {
            if (item.type === 'group') {
              return (
                <div key={`group-${item.kind}`} className="kv2-mention-group">
                  {item.label}
                </div>
              );
            }
            const { candidate, index } = item;
            const disabled = candidate.disabledReason === 'self';
            const classes = [
              'kv2-mention-row',
              `kv2-ref-kind-${candidate.kind}`,
              index === activeIndex ? 'is-selected' : '',
              disabled ? 'is-disabled' : '',
            ].filter(Boolean).join(' ');
            return (
              <button
                key={`${candidate.kind}:${candidate.id}`}
                type="button"
                id={optionId(index)}
                role="option"
                aria-selected={index === activeIndex}
                aria-disabled={disabled || undefined}
                className={classes}
                onMouseEnter={() => onHover(index)}
                onClick={() => {
                  if (!disabled) onSelect(candidate);
                }}
                title={disabled ? '이 카드 자신의 세션은 참조할 수 없습니다' : undefined}
              >
                <span className="kv2-mention-row-kind" aria-hidden="true">
                  {KIND_ICON[candidate.kind]}
                </span>
                <span
                  className={`kv2-mention-row-dot kv2-mention-row-dot--${statusModifier(candidate.status)}`}
                  aria-hidden="true"
                />
                <span className="kv2-mention-row-body">
                  <span className="kv2-mention-row-title">
                    {highlight(candidate.label, query)}
                    {disabled && <span className="kv2-mention-row-aside"> (이 카드의 세션)</span>}
                  </span>
                  <span className="kv2-mention-row-meta">
                    <span className="kv2-mention-row-id">{candidate.id}</span>
                    {candidate.status && (
                      <span
                        className={`kv2-session-status-badge kv2-session-status-badge--${statusModifier(candidate.status)}`}
                      >
                        {candidate.status}
                      </span>
                    )}
                    {candidate.projectDir && (
                      // Works 탭과 **같은 색 = 같은 프로젝트**. 크로스 프로젝트
                      // 참조가 한눈에 보이는 건 이 팔레트를 공유하기 때문이다.
                      <span
                        className={`works-dir-mark ${dirAccentClass(candidate.projectDir)}`.trim()}
                        title={candidate.projectDir}
                      >
                        {directoryName(candidate.projectDir)}
                      </span>
                    )}
                    {candidate.sublabel && <span>{candidate.sublabel}</span>}
                  </span>
                  {candidate.snippet && (
                    <span className="kv2-mention-row-snippet">
                      <span className="kv2-mention-row-snippet-field">
                        {candidate.snippet.field}
                      </span>
                      {highlight(candidate.snippet.text, query)}
                    </span>
                  )}
                </span>
                <span className="kv2-mention-row-right">
                  {candidate.agentRuntime && <RuntimeBadge runtime={candidate.agentRuntime} />}
                  {index === activeIndex && !disabled && (
                    <span className="kv2-mention-row-enter" aria-hidden="true">⏎</span>
                  )}
                </span>
              </button>
            );
          })}
      </div>
    </div>
  );
};
