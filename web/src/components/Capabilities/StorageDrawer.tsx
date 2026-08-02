import { useMemo, useState } from 'react';
import type { ColdEntryView } from '../../hooks/useScopeInventory';
import type { SkillRoot, PlacementTarget } from '../../../../src/core/types';
import { useColdStorage } from '../../hooks/useScopeInventory';
import { ColdDetailModal } from './ColdDetailModal';
import { ColdEntryActions } from './ColdEntryActions';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { timeAgo } from './capability-format';
import {
  CAPABILITY_RUNTIME_FILTERS,
  runtimeLabel,
  type CapabilityRuntimeFilter,
} from './capability-filters';
import {
  coldKindCounts,
  coldRuntimeCounts,
  filterColdEntries,
  type ColdKindFilter,
} from './cold-filters';

interface StorageDrawerProps {
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onRefresh: () => Promise<void>;
}

const KIND_FILTERS: ColdKindFilter[] = ['all', 'skill', 'mcp'];

function kindFilterLabel(kind: ColdKindFilter): string {
  return kind === 'all' ? 'All' : kind === 'skill' ? 'Skills' : 'MCP';
}

interface EntryCardProps {
  entry: ColdEntryView;
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onOpen: () => void;
  onRestored: () => Promise<void>;
  onDeleted: () => Promise<void>;
}

function EntryCard({ entry, skillRoots, placementTargets, onOpen, onRestored, onDeleted }: EntryCardProps) {
  return (
    <div className="cold-item">
      <div
        className="cold-item__main"
        role="button"
        tabIndex={0}
        title="클릭하면 보관된 내용을 확인할 수 있습니다"
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen();
          }
        }}
      >
        <div className="cold-item__header">
          <div className="cold-item__badges">
            <span className={`kv2-badge cold-item__kind-badge cold-item__kind-badge--${entry.kind}`}>
              {entry.kind === 'skill' ? '❄ skill' : '❄ MCP'}
            </span>
            {entry.runtime && (
              <RuntimeBadge runtime={entry.runtime} />
            )}
            <span className="kv2-badge cold-item__scope-badge">{entry.sourceScope}</span>
          </div>
          <span className="cold-item__ref">{entry.ref}</span>
          <span className="cold-item__age">{timeAgo(entry.createdAt)}</span>
          <button
            type="button"
            className="kv2-btn kv2-btn--ghost kv2-btn--small"
            onClick={(e) => { e.stopPropagation(); onOpen(); }}
            aria-label={`Open details for ${entry.ref}`}
          >
            Details
          </button>
        </div>
        <p className="cold-item__summary">
          {entry.summary ?? (entry.kind === 'skill'
            ? '설명이 없는 skill입니다 — Details에서 SKILL.md 전체를 볼 수 있습니다.'
            : '실행 정보가 없는 MCP 서버입니다 — Details에서 정의를 볼 수 있습니다.')}
        </p>
        <div className="cold-item__path">{entry.sourcePath}</div>
      </div>

      <ColdEntryActions
        entry={entry}
        skillRoots={skillRoots}
        placementTargets={placementTargets}
        onRestored={onRestored}
        onDeleted={onDeleted}
      />
    </div>
  );
}

export function StorageDrawer({ skillRoots, placementTargets, onRefresh }: StorageDrawerProps) {
  const cold = useColdStorage(true);
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState<ColdKindFilter>('all');
  const [runtimeFilter, setRuntimeFilter] = useState<CapabilityRuntimeFilter>('all');
  const [selectedRef, setSelectedRef] = useState<string | null>(null);

  const handleRestored = async () => {
    await cold.refresh();
    await onRefresh();
  };

  const handleDeleted = async () => {
    await cold.refresh();
  };

  const filtered = useMemo(
    () => filterColdEntries(cold.entries, { search, kind: kindFilter, runtime: runtimeFilter }),
    [cold.entries, search, kindFilter, runtimeFilter],
  );
  const kindCounts = useMemo(() => coldKindCounts(cold.entries), [cold.entries]);
  const runtimeCounts = useMemo(
    () => coldRuntimeCounts(kindFilter === 'all' ? cold.entries : cold.entries.filter((e) => e.kind === kindFilter)),
    [cold.entries, kindFilter],
  );

  const skillEntries = filtered.filter((e) => e.kind === 'skill');
  const mcpEntries = filtered.filter((e) => e.kind === 'mcp');
  const selectedEntry = cold.entries.find((e) => `${e.kind}:${e.ref}` === selectedRef) ?? null;

  if (cold.loading && cold.entries.length === 0) {
    return (
      <div className="scripts-loading">
                <p>Loading cold storage...</p>
      </div>
    );
  }

  if (cold.error) {
    return (
      <div className="cap-empty">
        <p>⚠ {cold.error}</p>
      </div>
    );
  }

  if (cold.entries.length === 0) {
    return (
      <div className="cold-drawer">
        <StorageIntroduction />
        <div className="cap-empty cold-empty">
          <p className="cold-empty__icon" aria-hidden="true">❄</p>
          <p className="cold-empty__title">아직 보관된 항목이 없습니다</p>
          <p className="cold-empty__hint">
            Inventory에서 <strong>Freeze to storage</strong>를 누르면 skill이나 MCP를
            삭제하지 않고 이곳에 보관할 수 있습니다.
          </p>
        </div>
      </div>
    );
  }

  const renderSection = (label: string, entries: ColdEntryView[]) => (
    <section className="cold-section">
      <div className="cold-section__label">
        {label}
        <span className="kv2-badge cold-section__count">{entries.length}</span>
      </div>
      <div className="cold-section__list">
        {entries.map((entry) => (
          <EntryCard
            key={`${entry.kind}:${entry.ref}`}
            entry={entry}
            skillRoots={skillRoots}
            placementTargets={placementTargets}
            onOpen={() => setSelectedRef(`${entry.kind}:${entry.ref}`)}
            onRestored={handleRestored}
            onDeleted={handleDeleted}
          />
        ))}
      </div>
    </section>
  );

  return (
    <div className="cold-drawer">
      <StorageIntroduction />

      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="cap-toolbar">
        <input
          type="search"
          className="kv2-input cap-search"
          placeholder="Search ref, description, scope, path..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="cap-filter-group" role="group" aria-label="Filter by type">
          {KIND_FILTERS.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`cap-filter-btn${kindFilter === kind ? ' cap-filter-btn--active' : ''}`}
              onClick={() => setKindFilter(kind)}
              aria-pressed={kindFilter === kind}
            >
              {kindFilterLabel(kind)} ({kindCounts[kind]})
            </button>
          ))}
        </div>
        <div className="cap-filter-group" role="group" aria-label="Filter by runtime">
          {CAPABILITY_RUNTIME_FILTERS.map((runtime) => (
            <button
              key={runtime}
              type="button"
              className={`cap-filter-btn${runtimeFilter === runtime ? ' cap-filter-btn--active' : ''}`}
              onClick={() => setRuntimeFilter(runtime)}
              aria-pressed={runtimeFilter === runtime}
            >
              {runtimeLabel(runtime)} ({runtimeCounts[runtime]})
            </button>
          ))}
        </div>
        <span className="cap-list-count">
          {filtered.length === cold.entries.length
            ? `${cold.entries.length} frozen`
            : `${filtered.length} / ${cold.entries.length}`}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="cap-empty">
          <p>No frozen items match your filters.</p>
        </div>
      ) : (
        <>
          {skillEntries.length > 0 && renderSection('Skills', skillEntries)}
          {mcpEntries.length > 0 && renderSection('MCP Servers', mcpEntries)}
        </>
      )}

      {selectedEntry && (
        <ColdDetailModal
          entry={selectedEntry}
          skillRoots={skillRoots}
          placementTargets={placementTargets}
          onClose={() => setSelectedRef(null)}
          onRestored={handleRestored}
          onDeleted={handleDeleted}
        />
      )}
    </div>
  );
}

function StorageIntroduction() {
  return (
    <section className="cold-intro" aria-labelledby="cold-intro-title">
      <div className="cold-intro__heading">
        <span className="cold-intro__icon" aria-hidden="true">❄</span>
        <div>
          <h2 id="cold-intro-title">Cold Storage</h2>
          <p>지금은 쓰지 않지만 나중에 다시 필요할 capability를 보관하는 곳입니다.</p>
        </div>
      </div>
      <div className="cold-intro__steps" aria-label="Cold Storage 동작 방식">
        <div className="cold-intro__step">
          <strong>1. Freeze</strong>
          <span>agent 설정에서 분리</span>
        </div>
        <span className="cold-intro__arrow" aria-hidden="true">→</span>
        <div className="cold-intro__step">
          <strong>2. Keep</strong>
          <span>파일과 설정을 안전하게 보관</span>
        </div>
        <span className="cold-intro__arrow" aria-hidden="true">→</span>
        <div className="cold-intro__step">
          <strong>3. Restore</strong>
          <span>원하는 위치로 다시 활성화</span>
        </div>
      </div>
      <p className="cold-intro__warning">
        Freeze는 삭제가 아닙니다. <strong>Delete만 영구 삭제</strong>이며 되돌릴 수 없습니다.
      </p>
    </section>
  );
}
