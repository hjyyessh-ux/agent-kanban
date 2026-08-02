import { useCallback, useMemo, useState } from 'react';
import type {
  CapabilityItem,
  DiscoveredSkill,
  SkillRoot,
  SkillSyncResult,
  ScriptEntry,
  ScriptSyncResult,
  CreateScriptInput,
  UpdateScriptInput,
} from '../../../../src/core/types';
import {
  COMMAND_FILTER_KEY,
  formatCommandName,
  getAllCommands,
  getCommandHint,
  parseStoredEnabledCommandIds,
} from '../../constants/commands';
import { ScriptEditModal } from '../Scripts/ScriptEditModal';
import { ScriptHistoryPanel } from '../Scripts/ScriptHistoryPanel';
import { SkillRootsModal } from './SkillRootsModal';
import { useScopeTargets } from '../../hooks/useScopeTargets';
import { usePolling } from '../../hooks/usePolling';
import { useScopeInventory } from '../../hooks/useScopeInventory';
import { SkillDetailModal } from './SkillDetailModal';
import { NewSkillModal } from './NewSkillModal';
import { ImportSkillModal } from './ImportSkillModal';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { InventoryView } from './InventoryView';
import { StorageDrawer } from './StorageDrawer';
import {
  CAPABILITY_RUNTIME_FILTERS,
  listRuntimeCounts,
  matchesRuntime,
  runtimeLabel,
  type CapabilityRuntimeFilter,
} from './capability-filters';
import { timeAgo } from './capability-format';
import '../Scripts/Scripts.css';
import './Capabilities.css';

type CapViewMode = 'inventory' | 'list' | 'storage';

const VIEW_TABS: Array<{ mode: CapViewMode; label: string; caption: string; title: string }> = [
  {
    mode: 'inventory',
    label: 'Inventory',
    caption: 'MCP · Skill 배치 현황',
    title: '설치된 MCP 서버와 skill이 어느 scope(user/local/project)에 배치되어 있는지 한눈에 봅니다.',
  },
  {
    mode: 'list',
    label: 'Skills & Scripts',
    caption: '목록 · Commands',
    title: '스킬/스크립트 목록을 검색·편집하고, 카드 생성 화면에 노출할 command를 관리합니다.',
  },
  {
    mode: 'storage',
    label: 'Cold Storage',
    caption: '보관 · 복원',
    title: 'Freeze로 보관한 MCP/skill을 확인하고 다시 복원하거나 영구 삭제합니다.',
  },
];

type TypeFilter = 'all' | 'skill' | 'script';

export interface CapabilitiesViewProps {
  skills: DiscoveredSkill[];
  skillsLoading: boolean;
  skillsSyncing: boolean;
  onSyncSkills: () => Promise<SkillSyncResult | null>;
  onRefreshSkills: () => Promise<void>;
  scripts: ScriptEntry[];
  scriptsLoading: boolean;
  onUpdateScript: (id: string, input: UpdateScriptInput) => Promise<void>;
  onDeleteScript: (id: string) => Promise<void>;
  onRunScript: (id: string) => Promise<void>;
  onRefreshScripts: () => Promise<void>;
  onSyncScripts: () => Promise<ScriptSyncResult>;
  skillRoots: SkillRoot[];
  skillRootsLoading: boolean;
  onAddRoot: (input: Omit<SkillRoot, 'id'>) => Promise<SkillRoot>;
  onUpdateRoot: (id: string, patch: Partial<Omit<SkillRoot, 'id'>>) => Promise<void>;
  onRemoveRoot: (id: string) => Promise<void>;
  onRefreshRoots: () => Promise<void>;
  commandsVersion?: number;
  lastSkillSync?: string | null;
}

function buildItems(skills: DiscoveredSkill[], scripts: ScriptEntry[]): CapabilityItem[] {
  const skillItems: CapabilityItem[] = skills.map((s) => ({
    id: s.id,
    type: 'skill',
    name: s.displayName,
    agent: s.runtime,
    directory: s.directory,
    scope: s.scope,
    description: s.description,
    tools: s.tools,
    filePath: s.filePath,
  }));

  const scriptItems: CapabilityItem[] = scripts.map((s) => ({
    id: s.id,
    type: 'script',
    name: s.name,
    agent: null,
    directory: s.projectDir ?? '~/.agent-kanban/scripts',
    scope: 'user',
    description: s.description,
  }));

  return [...skillItems, ...scriptItems];
}

function matchesSearch(item: CapabilityItem, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    item.name.toLowerCase().includes(q) ||
    item.description.toLowerCase().includes(q) ||
    item.directory.toLowerCase().includes(q) ||
    (item.tools ?? []).some((t) => t.toLowerCase().includes(q))
  );
}

export function CapabilitiesView({
  skills,
  skillsLoading,
  skillsSyncing,
  onSyncSkills,
  onRefreshSkills,
  scripts,
  scriptsLoading,
  onUpdateScript,
  onDeleteScript,
  onRunScript,
  onRefreshScripts,
  onSyncScripts,
  skillRoots,
  skillRootsLoading,
  onAddRoot,
  onUpdateRoot,
  onRemoveRoot,
  onRefreshRoots,
  commandsVersion = 0,
  lastSkillSync = null,
}: CapabilitiesViewProps) {
  const [viewMode, setViewMode] = useState<CapViewMode>('inventory');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [runtimeFilter, setRuntimeFilter] = useState<CapabilityRuntimeFilter>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [showRootsModal, setShowRootsModal] = useState(false);
  const scopeTargets = useScopeTargets(true);
  usePolling(scopeTargets.refresh, 10000);
  const inventory = useScopeInventory(viewMode === 'inventory');
  usePolling(inventory.refresh, 10000, viewMode === 'inventory');
  const [showNewSkillModal, setShowNewSkillModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<DiscoveredSkill | null>(null);
  const [editEntry, setEditEntry] = useState<ScriptEntry | null>(null);
  const [historyEntry, setHistoryEntry] = useState<ScriptEntry | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  const allCommands = useMemo(() => getAllCommands(), [commandsVersion]);
  const [enabledCommandIds, setEnabledCommandIds] = useState<Set<string>>(() => {
    try {
      const stored = parseStoredEnabledCommandIds(localStorage.getItem(COMMAND_FILTER_KEY));
      if (stored) return stored;
    } catch {}
    return new Set<string>(getAllCommands().map(c => c.id));
  });

  const toggleCommand = (commandId: string) => {
    setEnabledCommandIds(prev => {
      const next = new Set(prev);
      if (next.has(commandId)) next.delete(commandId);
      else next.add(commandId);
      localStorage.setItem(COMMAND_FILTER_KEY, JSON.stringify([...next]));
      return next;
    });
  };

  const toggleAllCommands = () => {
    const allEnabled = allCommands.every(c => enabledCommandIds.has(c.id));
    const next = allEnabled ? new Set<string>() : new Set(allCommands.map(c => c.id));
    setEnabledCommandIds(next);
    localStorage.setItem(COMMAND_FILTER_KEY, JSON.stringify([...next]));
  };

  // Scope mutations (freeze/copy/move/remove/visibility) change both the skill
  // list and the inventory snapshot — refresh both so the UI doesn't stay
  // stale until the next 10s poll.
  const refreshSkillsAndInventory = useCallback(async () => {
    await Promise.all([onRefreshSkills(), inventory.refresh()]);
  }, [onRefreshSkills, inventory.refresh]);

  const allItems = useMemo(() => buildItems(skills, scripts), [skills, scripts]);

  const filteredItems = useMemo(() => {
    return allItems.filter((item) => {
      if (typeFilter !== 'all' && item.type !== typeFilter) return false;
      if (!matchesRuntime(item.agent, runtimeFilter)) return false;
      return matchesSearch(item, search);
    });
  }, [allItems, typeFilter, runtimeFilter, search]);
  const runtimeCounts = useMemo(() => listRuntimeCounts(
    typeFilter === 'all' ? allItems : allItems.filter((item) => item.type === typeFilter),
  ), [allItems, typeFilter]);

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const [skillResult, scriptResult] = await Promise.allSettled([
        onSyncSkills(),
        onSyncScripts(),
      ]);
      const skillTotal =
        skillResult.status === 'fulfilled' ? (skillResult.value?.total ?? 0) : 0;
      const scriptMsg =
        scriptResult.status === 'fulfilled'
          ? `scripts +${scriptResult.value.created} ~${scriptResult.value.updated} -${scriptResult.value.removed}`
          : 'script sync failed';
      setSyncResult(`${skillTotal} skill(s) • ${scriptMsg}`);
      await onRefreshRoots();
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 5000);
    }
  };

  const handleRun = async (id: string) => {
    setRunningIds((prev) => new Set(prev).add(id));
    try {
      await onRunScript(id);
      await onRefreshScripts();
    } finally {
      setRunningIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this script? This cannot be undone.')) return;
    await onDeleteScript(id);
    await onRefreshScripts();
  };

  const handleUpdateScript = async (input: CreateScriptInput) => {
    if (!editEntry) return;
    await onUpdateScript(editEntry.id, input);
    setEditEntry(null);
    await onRefreshScripts();
  };

  if (skillsLoading && scriptsLoading && allItems.length === 0) {
    return (
      <div className="scripts-loading">
                <p>Loading capabilities...</p>
      </div>
    );
  }

  return (
    <div className="cap-view">
      {/* ── Header ──────────────────────────────────────────── */}
      <div className="cap-header">
        <div className="cap-title-group">
          <div className="cap-viewnav" role="group" aria-label="View">
            {VIEW_TABS.map((tab) => (
              <button
                key={tab.mode}
                type="button"
                className={`cap-viewnav-btn${viewMode === tab.mode ? ' cap-viewnav-btn--active' : ''}`}
                onClick={() => setViewMode(tab.mode)}
                title={tab.title}
                aria-pressed={viewMode === tab.mode}
              >
                <span className="cap-viewnav-label">{tab.label}</span>
                <span className="cap-viewnav-caption">{tab.caption}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="cap-header-actions">
          {syncResult && <span className="cap-sync-result">{syncResult}</span>}
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-btn--small"
            onClick={() => void handleSync()}
            disabled={syncing || skillsSyncing}
            title="스킬 디렉토리와 스크립트 저장소를 다시 스캔해 목록을 최신 상태로 갱신합니다."
          >
            {syncing || skillsSyncing ? 'Syncing...' : '⟳ Sync'}
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-btn--small"
            onClick={() => setShowImportModal(true)}
            title="기존 SKILL.md 파일을 가져와 skill로 등록합니다."
          >
            ↑ Import
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary kv2-btn--small"
            onClick={() => setShowNewSkillModal(true)}
            title="새 skill을 처음부터 작성합니다."
          >
            + New Skill
          </button>
          <button
            type="button"
            className="cap-gear-btn"
            onClick={() => setShowRootsModal(true)}
            aria-label="Manage skill directories"
            title="Skill 검색 대상 디렉토리(root)를 관리합니다."
          >
            ⚙
          </button>
        </div>
      </div>

      {/* ── Inventory view ──────────────────────────────────── */}
      {viewMode === 'inventory' && (
        <>
          {inventory.loading && !inventory.data && (
            <div className="scripts-loading">
                            <p>Loading inventory...</p>
            </div>
          )}
          {inventory.error && (
            <div className="cap-empty">
              <p>⚠ {inventory.error}</p>
            </div>
          )}
          {inventory.data && (
            <InventoryView
              data={inventory.data}
              skillRoots={skillRoots}
              placementTargets={scopeTargets.targets}
              targetsLoading={scopeTargets.loading}
              onAddTarget={scopeTargets.addTarget}
              onRemoveTarget={scopeTargets.removeTarget}
              onRefreshSkills={refreshSkillsAndInventory}
              runtimeFilter={runtimeFilter}
              onRuntimeFilterChange={setRuntimeFilter}
            />
          )}
        </>
      )}

      {/* ── Storage (Phase 4) ────────────────────────────────── */}
      {viewMode === 'storage' && (
        <StorageDrawer
          skillRoots={skillRoots}
          placementTargets={scopeTargets.targets}
          onRefresh={refreshSkillsAndInventory}
        />
      )}

      {/* ── List (existing) ─────────────────────────────────── */}
      {viewMode === 'list' && <>

      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="cap-toolbar">
        <input
          type="search"
          className="kv2-input cap-search"
          placeholder="Search name, description, directory, tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="cap-filter-group" role="group" aria-label="Filter by type">
          {(['all', 'skill', 'script'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`cap-filter-btn${typeFilter === t ? ' cap-filter-btn--active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {t === 'all' ? 'All' : t === 'skill' ? 'Skills' : 'Scripts'}
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
          {filteredItems.length === allItems.length
            ? `${allItems.length} total · ${skills.length} skills · ${scripts.length} scripts`
            : `${filteredItems.length} / ${allItems.length}`}
          {lastSkillSync && !syncResult && (
            <> · synced {timeAgo(lastSkillSync)}</>
          )}
        </span>
      </div>

      {/* ── List ────────────────────────────────────────────── */}
      <div className="cap-list">
        {filteredItems.length === 0 ? (
          <div className="cap-empty">
            <p>
              {search || typeFilter !== 'all' || runtimeFilter !== 'all'
                ? 'No capabilities match your filters.'
                : 'No capabilities found. Run Sync to discover skills, or create one with + New Skill.'}
            </p>
          </div>
        ) : (
          filteredItems.map((item) => {
            const scriptEntry =
              item.type === 'script' ? scripts.find((s) => s.id === item.id) : undefined;
            const skillEntry =
              item.type === 'skill' ? skills.find((s) => s.id === item.id) : undefined;
            const isClickable = (item.type === 'script' && Boolean(scriptEntry)) ||
              (item.type === 'skill' && Boolean(skillEntry));

            const handleClick = () => {
              if (item.type === 'skill' && skillEntry) setSelectedSkill(skillEntry);
              else if (item.type === 'script' && scriptEntry) setEditEntry(scriptEntry);
            };

            return (
              <div
                key={`${item.type}:${item.id}`}
                className={`cap-item${isClickable ? ' cap-item--clickable' : ''}`}
                onClick={handleClick}
                role={isClickable ? 'button' : undefined}
                tabIndex={isClickable ? 0 : undefined}
                onKeyDown={(e) => {
                  if (isClickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    handleClick();
                  }
                }}
              >
                <div className="cap-item-header">
                  <div className="cap-item-main">
                    <div className="cap-badges">
                      <span className={`kv2-badge cap-badge--${item.type}`}>{item.type}</span>
                      {item.agent && (
                        <RuntimeBadge runtime={item.agent} />
                      )}
                      {item.type === 'script' && scriptEntry?.language && (
                        <span className={`kv2-badge scripts-badge--${scriptEntry.language}`}>
                          {scriptEntry.language}
                        </span>
                      )}
                      {item.type === 'script' && scriptEntry?.lastRunStatus && (
                        <span
                          className={`kv2-badge cap-badge--${
                            scriptEntry.lastRunStatus === 'success' ? 'success' : 'error'
                          }`}
                        >
                          {scriptEntry.lastRunStatus}
                        </span>
                      )}
                    </div>
                    <h3 className="cap-item-name">{item.name}</h3>
                  </div>
                  {item.type === 'script' && scriptEntry?.lastRunAt && (
                    <span className="cap-item-meta">
                      ran {timeAgo(scriptEntry.lastRunAt)}
                    </span>
                  )}
                </div>

                {item.description && (
                  <p className="cap-item-description">{item.description}</p>
                )}

                {item.tools && item.tools.length > 0 && (
                  <div className="cap-item-tools">
                    {item.tools.slice(0, 5).map((tool) => (
                      <span key={tool} className="kv2-badge cap-badge--tool">
                        {tool}
                      </span>
                    ))}
                    {item.tools.length > 5 && (
                      <span className="kv2-badge cap-badge--tool">
                        +{item.tools.length - 5}
                      </span>
                    )}
                  </div>
                )}

                <div className="cap-item-directory">{item.directory}</div>

                {item.type === 'script' && scriptEntry && (
                  <div
                    className="cap-item-actions"
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--outline kv2-btn--small"
                      onClick={() => void handleRun(item.id)}
                      disabled={runningIds.has(item.id)}
                    >
                      {runningIds.has(item.id) ? 'Running...' : '▶ Run'}
                    </button>
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--ghost kv2-btn--small"
                      onClick={() => setHistoryEntry(scriptEntry)}
                    >
                      History ({scriptEntry.history.length})
                    </button>
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--ghost kv2-btn--small"
                      onClick={() => setEditEntry(scriptEntry)}
                    >
                      ✎ Edit
                    </button>
                    <button
                      type="button"
                      className="kv2-btn kv2-btn--subtle-danger kv2-btn--small"
                      onClick={() => void handleDelete(item.id)}
                    >
                      ✕ Delete
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ── Commands ────────────────────────────────────────── */}
      <div className="cap-commands-section">
        <div className="cap-commands-header">
          <div className="cap-commands-info">
            <h3 className="cap-commands-title">Commands</h3>
            <p className="cap-commands-desc">
              Runtime별 카드 생성 화면에 표시할 command를 선택합니다.
            </p>
          </div>
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-btn--small"
            onClick={toggleAllCommands}
          >
            {allCommands.every(c => enabledCommandIds.has(c.id)) ? '전체 해제' : '전체 선택'}
          </button>
        </div>
        <div className="cap-commands-list">
          {allCommands.map(command => (
            <label key={command.id} className="cap-command-item">
              <input
                type="checkbox"
                className="cap-command-checkbox"
                checked={enabledCommandIds.has(command.id)}
                onChange={() => toggleCommand(command.id)}
              />
              <span className="cap-command-name">{formatCommandName(command.id)}</span>
              <RuntimeBadge runtime={command.runtime} />
              <span className="cap-command-meta">
                {command.description}
                {' · '}
                {getCommandHint(command.id)?.executionMode === 'command_only'
                  ? '프롬프트 없이 실행'
                  : '프롬프트와 함께 실행'}
              </span>
            </label>
          ))}
        </div>
      </div>

      </>}

      {/* ── Modals ──────────────────────────────────────────── */}
      {showRootsModal && (
        <SkillRootsModal
          roots={skillRoots}
          loading={skillRootsLoading}
          onClose={() => setShowRootsModal(false)}
          onAdd={onAddRoot}
          onUpdate={onUpdateRoot}
          onRemove={onRemoveRoot}
        />
      )}

      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          skillRoots={skillRoots}
          placementTargets={scopeTargets.targets}
          onClose={() => setSelectedSkill(null)}
          onSaved={() => void onRefreshSkills()}
        />
      )}

      {showNewSkillModal && (
        <NewSkillModal
          skillRoots={skillRoots}
          onClose={() => setShowNewSkillModal(false)}
          onCreated={() => void onRefreshSkills()}
        />
      )}

      {showImportModal && (
        <ImportSkillModal
          skillRoots={skillRoots}
          onClose={() => setShowImportModal(false)}
          onImported={() => void onRefreshSkills()}
        />
      )}

      {editEntry && (
        <ScriptEditModal
          editEntry={editEntry}
          onClose={() => setEditEntry(null)}
          onSave={handleUpdateScript}
        />
      )}

      {historyEntry && (
        <ScriptHistoryPanel
          entry={historyEntry}
          onClose={() => setHistoryEntry(null)}
        />
      )}
    </div>
  );
}
