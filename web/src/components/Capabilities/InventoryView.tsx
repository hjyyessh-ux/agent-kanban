import { useMemo, useState } from 'react';
import type {
  McpInventoryItem,
  McpPlacement,
  DiscoveredSkill,
  SkillVisibility,
  PlacementTarget,
  CreatePlacementTargetInput,
} from '../../../../src/core/types';
import type { ScopeInventoryData } from '../../hooks/useScopeInventory';
import { freezeSkillApi, freezeMcpApi } from '../../hooks/useScopeInventory';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { ScopeChip } from './ScopeChip';
import { DiagnosticsBar } from './DiagnosticsBar';
import { PlacementTargetsPanel } from './PlacementTargetsPanel';
import { SkillDetailModal } from './SkillDetailModal';
import { McpDetailModal } from './McpDetailModal';
import { SkillVisibilityControl } from './VisibilityControl';
import type { SkillRoot } from '../../../../src/core/types';
import {
  CAPABILITY_RUNTIME_FILTERS,
  inventoryRuntimeCounts,
  matchesRuntime,
  runtimeLabel,
  type CapabilityRuntimeFilter,
} from './capability-filters';

type ItemType = 'all' | 'mcp' | 'skill';

interface InventoryViewProps {
  data: ScopeInventoryData;
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  targetsLoading: boolean;
  onAddTarget: (input: CreatePlacementTargetInput) => Promise<PlacementTarget>;
  onRemoveTarget: (id: string) => Promise<void>;
  onRefreshSkills: () => Promise<void>;
  runtimeFilter: CapabilityRuntimeFilter;
  onRuntimeFilterChange: (runtime: CapabilityRuntimeFilter) => void;
}

function estSkillTokens(skill: DiscoveredSkill & SkillVisibility): number {
  if (skill.effectivelyHidden) return 0;
  const text = skill.override === 'name-only' ? skill.skillName : skill.description;
  return Math.ceil(text.length / 4);
}

const FREEZE_TITLE =
  'Cold Storage로 보관 — 이 위치의 설정에서 제거되어 에이전트가 읽지 않게 되고, Cold Storage 탭에서 언제든 복원할 수 있습니다.';

function skillIdentity(skill: DiscoveredSkill): string {
  return `${skill.runtime}:${skill.skillName}:${skill.id}`;
}

export function InventoryView({
  data,
  skillRoots,
  placementTargets,
  targetsLoading,
  onAddTarget,
  onRemoveTarget,
  onRefreshSkills,
  runtimeFilter,
  onRuntimeFilterChange,
}: InventoryViewProps) {
  const { mcp, skills, diagnostics } = data;
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ItemType>('all');
  const [selectedSkill, setSelectedSkill] = useState<(DiscoveredSkill & SkillVisibility) | null>(null);
  const [selectedMcpIdentity, setSelectedMcpIdentity] = useState<string | null>(null);
  const [expandedVisSkillId, setExpandedVisSkillId] = useState<string | null>(null);
  const [freezingIds, setFreezingIds] = useState<Set<string>>(new Set());
  const [freezeErrors, setFreezeErrors] = useState<Record<string, string>>({});

  const handleFreezeSkill = async (skill: DiscoveredSkill & SkillVisibility) => {
    if (skill.scope === 'project' || skill.source?.includes('project')) {
      if (!window.confirm('project 항목: git 관리 파일이므로 이동 시 변경이 발생합니다. 계속하시겠습니까?')) return;
    }
    const identity = skillIdentity(skill);
    setFreezingIds((prev) => new Set(prev).add(identity));
    setFreezeErrors((prev) => { const n = { ...prev }; delete n[identity]; return n; });
    try {
      await freezeSkillApi(skill.id);
      await onRefreshSkills();
    } catch (e: unknown) {
      setFreezeErrors((prev) => ({ ...prev, [identity]: e instanceof Error ? e.message : 'Freeze failed' }));
    } finally {
      setFreezingIds((prev) => { const n = new Set(prev); n.delete(identity); return n; });
    }
  };

  const handleFreezeMcpPlacement = async (item: McpInventoryItem, placement: McpPlacement) => {
    if (placement.scope === 'project') {
      if (!window.confirm('project 항목: git 관리 파일(.mcp.json)이므로 변경이 발생합니다. 계속하시겠습니까?')) return;
    }
    const key = `mcp:${item.identity}:${placement.identity}`;
    const fromDir = placement.scope === 'local' || placement.scope === 'project'
      ? placement.dir
      : undefined;
    setFreezingIds((prev) => new Set(prev).add(key));
    setFreezeErrors((prev) => { const n = { ...prev }; delete n[`mcp:${item.identity}`]; return n; });
    try {
      await freezeMcpApi(item.name, placement.scope, fromDir, item.runtime, placement.identity);
      await onRefreshSkills();
    } catch (e: unknown) {
      setFreezeErrors((prev) => ({ ...prev, [`mcp:${item.identity}`]: e instanceof Error ? e.message : 'Freeze failed' }));
    } finally {
      setFreezingIds((prev) => { const n = new Set(prev); n.delete(key); return n; });
    }
  };

  const filteredMcp = useMemo(() => {
    if (typeFilter === 'skill') return [];
    const q = search.toLowerCase();
    return mcp.filter((item) => {
      if (!matchesRuntime(item.runtime, runtimeFilter)) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.placements.some((p) => p.scope.includes(q))
      );
    });
  }, [mcp, search, typeFilter, runtimeFilter]);

  const filteredSkills = useMemo(() => {
    if (typeFilter === 'mcp') return [];
    const q = search.toLowerCase();
    return skills.filter((s) => {
      if (!matchesRuntime(s.runtime, runtimeFilter)) return false;
      if (!q) return true;
      return (
        s.skillName.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q)
      );
    });
  }, [skills, search, typeFilter, runtimeFilter]);

  const totalCount = filteredMcp.length + filteredSkills.length;
  const runtimeCounts = useMemo(() => inventoryRuntimeCounts(
    typeFilter === 'skill' ? [] : mcp,
    typeFilter === 'mcp' ? [] : skills,
  ), [mcp, skills, typeFilter]);
  const typeCounts = useMemo(() => ({
    all: mcp.filter((item) => matchesRuntime(item.runtime, runtimeFilter)).length +
      skills.filter((item) => matchesRuntime(item.runtime, runtimeFilter)).length,
    mcp: mcp.filter((item) => matchesRuntime(item.runtime, runtimeFilter)).length,
    skill: skills.filter((item) => matchesRuntime(item.runtime, runtimeFilter)).length,
  }), [mcp, skills, runtimeFilter]);
  const selectedMcp = selectedMcpIdentity
    ? mcp.find((item) => item.identity === selectedMcpIdentity) ?? null
    : null;

  return (
    <div className="inv-view">
      <DiagnosticsBar diagnostics={diagnostics} />

      {/* ── Placement Targets (inline, formerly a hidden modal) ── */}
      <PlacementTargetsPanel
        targets={placementTargets}
        loading={targetsLoading}
        onAdd={onAddTarget}
        onRemove={onRemoveTarget}
      />

      {mcp.some((item) => item.runtime === 'codex' && item.placements.some((placement) => placement.projectTrust === 'required-status-unknown')) && (
        <p className="cap-detail-section-hint" role="note">
          Codex 디렉터리 설정은 trusted project에서만 로드됩니다. 신뢰 상태는 여기서 추측하지 않으며,
          설정 변경 후 새 세션 또는 Codex 클라이언트 재시작이 필요할 수 있습니다.
        </p>
      )}

      <aside className="cap-freeze-guide" aria-labelledby="cap-freeze-guide-title">
        <div className="cap-freeze-guide__icon" aria-hidden="true">❄</div>
        <div className="cap-freeze-guide__copy">
          <strong id="cap-freeze-guide-title">잠시 사용하지 않을 항목은 Freeze 하세요</strong>
          <span>
            Freeze는 삭제가 아닙니다. 현재 agent 설정에서만 빼고 안전하게 보관하며,
            Cold Storage에서 원하는 위치로 다시 복원할 수 있습니다.
          </span>
        </div>
        <span className="cap-freeze-guide__flow" aria-label="Freeze workflow">
          Active → Freeze → Cold Storage → Restore
        </span>
      </aside>

      {/* ── Toolbar ─────────────────────────────────────────── */}
      <div className="cap-toolbar">
        <input
          type="search"
          className="kv2-input cap-search"
          placeholder="Search name, scope, description..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="cap-filter-group" role="group" aria-label="Filter by type">
          {(['all', 'mcp', 'skill'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`cap-filter-btn${typeFilter === t ? ' cap-filter-btn--active' : ''}`}
              onClick={() => setTypeFilter(t)}
            >
              {t === 'all' ? `All (${typeCounts.all})` : t === 'mcp' ? `MCP (${typeCounts.mcp})` : `Skills (${typeCounts.skill})`}
            </button>
          ))}
        </div>
        <div className="cap-filter-group" role="group" aria-label="Filter by runtime">
          {CAPABILITY_RUNTIME_FILTERS.map((runtime) => (
            <button
              key={runtime}
              type="button"
              className={`cap-filter-btn${runtimeFilter === runtime ? ' cap-filter-btn--active' : ''}`}
              onClick={() => onRuntimeFilterChange(runtime)}
              aria-pressed={runtimeFilter === runtime}
            >
              {runtimeLabel(runtime)} ({runtimeCounts[runtime]})
            </button>
          ))}
        </div>
        <span className="cap-list-count">{totalCount} shown</span>
      </div>

      {/* ── MCP rows ─────────────────────────────────────────── */}
      {filteredMcp.length > 0 && (
        <div className="inv-section">
          {typeFilter === 'all' && <div className="inv-section-label">MCP Servers</div>}
          <div className="inv-list">
            {filteredMcp.map((item) => {
              const anyAlwaysLoad = item.placements.some((p) => p.alwaysLoad);
              const anySecret = item.placements.some((p) => p.hasPlaintextSecret);
              const anyManaged = item.placements.some((p) => p.managed);
              const preloaded = Boolean(item.preloadReason);
              // Show the full invocation (binary + args), not just the bare command —
              // "npx" alone with no args is meaningless to the reader.
              const commandLine = item.def.command
                ? [String(item.def.command), ...(Array.isArray(item.def.args) ? item.def.args.map(String) : [])].join(' ')
                : undefined;

              return (
                <div key={item.identity} className="inv-item inv-item--mcp">
                  <div
                    className="inv-item-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedMcpIdentity(item.identity)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedMcpIdentity(item.identity);
                      }
                    }}
                  >
                    <div className="inv-item-main">
                      <div className="inv-item-badges">
                        <span className="cap-chip cap-chip--mcp">MCP</span>
                        <RuntimeBadge runtime={item.runtime} />
                        {item.def.type && (
                          <span className="cap-chip cap-chip--plain">{String(item.def.type)}</span>
                        )}
                        {anyAlwaysLoad && (
                          <span className="cap-chip cap-chip--alwaysload" title="alwaysLoad: 강제 선로딩">⚡ alwaysLoad</span>
                        )}
                        {anySecret && (
                          <span className="cap-chip cap-chip--secret-warn" title="정의에 평문 secret으로 보이는 값이 있습니다">⚠ secret?</span>
                        )}
                        {anyManaged && (
                          <span className="cap-chip cap-chip--managed" title="plugin/enterprise 제공 — 이동 불가">🔒 managed</span>
                        )}
                      </div>
                      <span className="inv-item-name">{item.name}</span>
                      {commandLine && (
                        <span className="inv-item-hint" title={commandLine}>{commandLine}</span>
                      )}
                      {item.def.url && (
                        <span className="inv-item-hint" title={String(item.def.url)}>{String(item.def.url)}</span>
                      )}
                    </div>
                    <div className="inv-item-right">
                      {preloaded ? (
                        <span
                          className="inv-tok-badge inv-tok-badge--warn"
                          title={`대화 시작 시 이 MCP의 tool schema가 선로딩됩니다 (사유: ${item.preloadReason}).`}
                        >
                          ⚡ preload
                        </span>
                      ) : (
                        <span
                          className="inv-tok-badge inv-tok-badge--deferred"
                          title="컨텍스트 비용: tool-search가 켜져 있어 tool schema는 필요할 때만 로딩(deferred)됩니다. 대화 시작 시 토큰 부담 ≈ 0."
                        >
                          context ≈0 tok
                        </span>
                      )}
                      <button
                        type="button"
                        className="kv2-btn kv2-btn--outline kv2-btn--small"
                        title="정의 확인, Copy / Move, placement 제거"
                        onClick={(e) => { e.stopPropagation(); setSelectedMcpIdentity(item.identity); }}
                        aria-label={`Open ${item.runtime} MCP details for ${item.name}`}
                      >
                        Details ›
                      </button>
                    </div>
                  </div>

                  {/* Per-placement rows: where this MCP is placed + freeze each */}
                  <div className="inv-placements">
                    {item.placements.map((p) => (
                      <div key={p.identity} className="inv-placement-row">
                        <ScopeChip scope={p.scope} alwaysLoad={p.alwaysLoad} managed={p.managed} />
                        <div className="inv-placement-where">
                          <span className="inv-placement-loc" title={p.location}>{p.location}</span>
                          {p.dir && (
                            <span className="inv-placement-dir" title={p.dir}>{p.dir}</span>
                          )}
                          {item.runtime === 'codex' && (
                            <span className="inv-placement-dir">
                              {p.configLayer ?? p.scope}{p.effective ? ' · effective' : p.overriddenBy ? ' · overridden' : ''}
                              {p.appliesToDir ? ` · applies to ${p.appliesToDir}` : ''}
                            </span>
                          )}
                        </div>
                        {!p.managed && (
                          <button
                            type="button"
                            className="kv2-btn kv2-btn--small cold-freeze-btn"
                            title={FREEZE_TITLE}
                            disabled={freezingIds.has(`mcp:${item.identity}:${p.identity}`)}
                            onClick={() => void handleFreezeMcpPlacement(item, p)}
                            aria-label={`Freeze ${item.runtime} ${item.name} (${p.scope}) to cold storage`}
                          >
                            {freezingIds.has(`mcp:${item.identity}:${p.identity}`) ? '보관 중…' : '❄ Freeze to storage'}
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  {freezeErrors[`mcp:${item.identity}`] && (
                    <p className="inv-freeze-error">{freezeErrors[`mcp:${item.identity}`]}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Skill rows ─────────────────────────────────────────── */}
      {filteredSkills.length > 0 && (
        <div className="inv-section">
          {typeFilter === 'all' && <div className="inv-section-label">Skills</div>}
          <div className="inv-list">
            {filteredSkills.map((skill) => {
              const tokEst = estSkillTokens(skill);
              const identity = skillIdentity(skill);
              const isVisExpanded = expandedVisSkillId === identity;
              return (
                <div
                  key={skill.id}
                  className={`inv-item inv-item--skill${skill.effectivelyHidden ? ' inv-item--hidden' : ''}`}
                >
                  <div
                    className="inv-item-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedSkill(skill)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedSkill(skill);
                      }
                    }}
                  >
                    <div className="inv-item-main">
                      <div className="inv-item-badges">
                        <RuntimeBadge runtime={skill.runtime} />
                        {skill.effectivelyHidden && (
                          <span className="cap-chip cap-chip--hidden" title="현재 설정상 에이전트에게 노출되지 않습니다">hidden</span>
                        )}
                        {skill.override && skill.override !== 'on' && (
                          <span className="cap-chip cap-chip--nameonly">{skill.override}</span>
                        )}
                        {skill.disableModelInvocation && (
                          <span className="cap-chip cap-chip--disabled-invoke" title="disable-model-invocation: true">no-auto</span>
                        )}
                      </div>
                      <span className="inv-item-name">{skill.displayName}</span>
                      {skill.description && (
                        <span className="inv-item-desc">{skill.description}</span>
                      )}
                    </div>
                    <div
                      className="inv-item-right"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      {skill.effectivelyHidden ? (
                        <span className="inv-tok-badge inv-tok-badge--zero" title="숨김 상태 — 컨텍스트 비용 없음">≈0 tok</span>
                      ) : (
                        <span className="inv-tok-badge" title="이 skill 설명이 차지하는 컨텍스트 토큰 추정치 (chars/4 휴리스틱)">
                          ~{tokEst} tok
                        </span>
                      )}
                      <button
                        type="button"
                        className={`inv-vis-btn${isVisExpanded ? ' inv-vis-btn--active' : ''}`}
                        title="Visibility 설정 — 에이전트 노출 방식 조절"
                        onClick={() =>
                          setExpandedVisSkillId(isVisExpanded ? null : identity)
                        }
                        aria-expanded={isVisExpanded}
                        aria-label="Toggle visibility settings"
                      >
                        ⚙
                      </button>
                    </div>
                  </div>

                  {/* Placement row: where this skill lives + freeze */}
                  <div className="inv-placements">
                    <div className="inv-placement-row">
                      <ScopeChip
                        scope={skill.scope === 'user' ? 'user' : skill.scope === 'system' ? 'user' : 'project'}
                      />
                      <div className="inv-placement-where">
                        <span className="inv-placement-dir" title={skill.directory}>{skill.directory}</span>
                      </div>
                      {skill.scope !== 'system' && (
                        <button
                          type="button"
                          className="kv2-btn kv2-btn--small cold-freeze-btn"
                          title={FREEZE_TITLE}
                          disabled={freezingIds.has(identity)}
                          onClick={() => void handleFreezeSkill(skill)}
                          aria-label={`Freeze ${skill.skillName} to cold storage`}
                        >
                          {freezingIds.has(identity) ? '보관 중…' : '❄ Freeze to storage'}
                        </button>
                      )}
                    </div>
                  </div>
                  {freezeErrors[identity] && (
                    <p className="inv-freeze-error">{freezeErrors[identity]}</p>
                  )}
                  {isVisExpanded && (
                    <div className="inv-item-vis-panel">
                      <SkillVisibilityControl
                        skill={skill}
                        onApplied={() => {
                          setExpandedVisSkillId(null);
                          void onRefreshSkills();
                        }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {filteredMcp.length === 0 && filteredSkills.length === 0 && (
        <div className="cap-empty">
          <p>
            {search || typeFilter !== 'all'
              ? 'No items match your filters.'
              : 'No MCP servers or skills found.'}
          </p>
        </div>
      )}

      {/* ── Modals ──────────────────────────────────────────── */}
      {selectedSkill && (
        <SkillDetailModal
          skill={selectedSkill}
          skillRoots={skillRoots}
          placementTargets={placementTargets}
          onClose={() => setSelectedSkill(null)}
          onSaved={() => void onRefreshSkills()}
        />
      )}
      {selectedMcp && (
        <McpDetailModal
          item={selectedMcp}
          placementTargets={placementTargets}
          onClose={() => setSelectedMcpIdentity(null)}
          onRefresh={onRefreshSkills}
        />
      )}
    </div>
  );
}
