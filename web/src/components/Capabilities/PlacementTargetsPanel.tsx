import { useState } from 'react';
import type { PlacementTarget, CreatePlacementTargetInput, CapScope, McpRuntime } from '../../../../src/core/types';
import { DirectoryPicker } from '../Card/DirectoryPicker';
import { RuntimeBadge } from '../Board/BoardCardSections';

interface PlacementTargetsPanelProps {
  targets: PlacementTarget[];
  loading: boolean;
  onAdd: (input: CreatePlacementTargetInput) => Promise<PlacementTarget>;
  onRemove: (id: string) => Promise<void>;
}

const KIND_OPTIONS: Array<{ value: CapScope; label: string }> = [
  { value: 'local', label: 'local' },
  { value: 'project', label: 'project' },
];

const KIND_HINTS: Record<McpRuntime, Record<string, string>> = {
  claude: {
    user: '~/.claude.json 전역 설정',
    local: '~/.claude.json 의 projects[dir] 항목',
    project: '<repo>/.mcp.json — git으로 팀 공유',
    cold: '보관소 — 에이전트가 읽지 않음',
  },
  codex: {
    user: '~/.codex/config.toml 전역 설정',
    local: '<dir>/.codex/config.toml 디렉터리 설정',
    project: '<dir>/.codex/config.toml — git으로 팀 공유',
    cold: '보관소 — 에이전트가 읽지 않음',
  },
};

function targetConfigPath(runtime: McpRuntime, kind: CapScope, dir: string): string {
  if (runtime === 'codex') return kind === 'user' ? '~/.codex/config.toml' : `${dir}/.codex/config.toml`;
  if (kind === 'project') return `${dir}/.mcp.json`;
  return kind === 'local' ? `~/.claude.json → projects[${dir}]` : '~/.claude.json';
}

function targetLocations(runtime: McpRuntime, kind: CapScope, dir: string): Array<{ label: string; path: string }> {
  if (kind === 'cold') return [{ label: 'Storage', path: dir }];
  const skillDir = kind === 'user' ? dir : `${dir}/.${runtime}/skills`;
  return [
    { label: 'MCP', path: targetConfigPath(runtime, kind, dir) },
    { label: 'SKILL', path: skillDir },
  ];
}

export function compactPlacementPath(path: string): string {
  return path
    .replace(/\/Users\/[^/]+(?=\/)/g, '~')
    .replace(/\/home\/[^/]+(?=\/)/g, '~');
}

/**
 * Collapsible Placement Targets manager shown at the top of the Inventory view.
 * The compact summary stays visible while paths and mutations are opt-in.
 */
export function PlacementTargetsPanel({ targets, loading, onAdd, onRemove }: PlacementTargetsPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDir, setNewDir] = useState('');
  const [newKind, setNewKind] = useState<CapScope>('local');
  const [newRuntime, setNewRuntime] = useState<McpRuntime>('claude');
  const [newTeamShared, setNewTeamShared] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [copiedLocation, setCopiedLocation] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const claudeCount = targets.filter((target) => target.runtime === 'claude').length;
  const codexCount = targets.filter((target) => target.runtime === 'codex').length;

  const handleKindChange = (kind: CapScope) => {
    setNewKind(kind);
    setNewTeamShared(kind === 'project');
  };

  const handleAdd = async () => {
    const label = newLabel.trim();
    const dir = newDir.trim();
    if (!label || !dir) return;
    setAdding(true);
    setError(null);
    try {
      await onAdd({ label, dir, kind: newKind, teamShared: newTeamShared, runtime: newRuntime });
      setNewLabel('');
      setNewDir('');
      setNewKind('local');
      setNewTeamShared(false);
      setShowAddForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add target');
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm('Remove this placement target?')) return;
    setRemovingId(id);
    setError(null);
    try {
      await onRemove(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove target');
    } finally {
      setRemovingId(null);
    }
  };

  const handleCopyLocation = async (key: string, path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopiedLocation(key);
      window.setTimeout(() => {
        setCopiedLocation((current) => current === key ? null : current);
      }, 1500);
    } catch {
      setError('Failed to copy path');
    }
  };

  return (
    <section className="ptp-panel" aria-label="Placement targets">
      <div className="ptp-header">
        <div className="ptp-header-text">
          <h3 className="ptp-title">Placement Targets</h3>
          <p className="ptp-hint">
            {loading && targets.length === 0
              ? 'Loading targets…'
              : `${targets.length} configured · Claude ${claudeCount} · Codex ${codexCount}`}
          </p>
        </div>
        <div className="ptp-header-actions">
          {expanded && (
            <button
              type="button"
              className="kv2-btn kv2-btn--outline kv2-btn--small"
              onClick={() => { setShowAddForm((current) => !current); setError(null); }}
              aria-expanded={showAddForm}
            >
              {showAddForm ? 'Cancel' : '+ Add Target'}
            </button>
          )}
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-btn--small"
            onClick={() => {
              setExpanded((current) => !current);
              setShowAddForm(false);
              setError(null);
            }}
            aria-expanded={expanded}
            aria-controls="placement-targets-content"
          >
            {expanded ? 'Hide' : 'Show targets'}
          </button>
        </div>
      </div>

      {expanded && (
        <div id="placement-targets-content" className="ptp-content">
          {error && <p className="ptp-error">{error}</p>}

          <div className="ptp-list">
            {loading && targets.length === 0 && <p className="ptp-empty">Loading...</p>}
            {!loading && targets.length === 0 && <p className="ptp-empty">No targets configured.</p>}
            {targets.map((t) => {
              const locations = targetLocations(t.runtime, t.kind, t.dir);
              return (
                <div key={t.id} className="ptp-item">
                  <span
                    className={`scope-chip scope-chip--${t.kind}`}
                    title={KIND_HINTS[t.runtime][t.kind] ?? t.kind}
                  >
                    {t.kind}
                  </span>
                  <RuntimeBadge runtime={t.runtime} />
                  <span className="ptp-item-label" title={t.label}>{t.label}</span>
                  <span className="ptp-item-dir">
                    {locations.map(({ label, path }) => {
                      const locationKey = `${t.id}:${label}`;
                      return (
                        <button
                          key={locationKey}
                          type="button"
                          className={`ptp-item-path ptp-item-path--${label.toLowerCase()}`}
                          title={`Copy full path: ${path}`}
                          aria-label={`Copy ${label} path for ${t.label}: ${path}`}
                          onClick={() => void handleCopyLocation(locationKey, path)}
                        >
                          <span className="ptp-item-path-label">{label}</span>
                          <span className="ptp-item-path-value">{compactPlacementPath(path)}</span>
                          <span className="ptp-item-path-copy" aria-hidden="true">
                            {copiedLocation === locationKey ? 'Copied' : '⎘'}
                          </span>
                        </button>
                      );
                    })}
                  </span>
                  <span className="ptp-item-actions">
                    {t.teamShared && (
                      <span className="ptp-git-badge" title="git으로 팀과 공유되는 설정 파일입니다">git</span>
                    )}
                    {t.builtin ? (
                      <span className="ptp-builtin" title="기본 제공 target — 삭제할 수 없습니다">🔒</span>
                    ) : (
                      <button
                        type="button"
                        className="ptp-remove-btn"
                        onClick={() => void handleRemove(t.id)}
                        disabled={removingId === t.id}
                        aria-label={`Remove ${t.label}`}
                        title="Target 삭제 (파일은 삭제되지 않습니다)"
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {showAddForm && (
            <div className="ptp-add-form">
              <div className="ptp-add-row">
                <input
                  type="text"
                  className="kv2-input ptp-add-label"
                  placeholder="Label (e.g. my-project)"
                  aria-label="Target label"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                />
                <select
                  className="kv2-select ptp-add-kind"
                  value={newRuntime}
                  onChange={(e) => setNewRuntime(e.target.value as McpRuntime)}
                  aria-label="Target runtime"
                >
                  <option value="claude">claude</option>
                  <option value="codex">codex</option>
                </select>
                <select
                  className="kv2-select ptp-add-kind"
                  value={newKind}
                  onChange={(e) => handleKindChange(e.target.value as CapScope)}
                  aria-label="Target kind"
                >
                  {KIND_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <label className="ptp-team-shared">
                  <input
                    type="checkbox"
                    checked={newTeamShared}
                    onChange={(e) => setNewTeamShared(e.target.checked)}
                  />
                  team-shared (git)
                </label>
              </div>
              <div className="ptp-add-row">
                <div className="ptp-add-dir" role="group" aria-label="Target directory">
                  <DirectoryPicker
                    id="ptp-target-dir"
                    value={newDir}
                    onChange={setNewDir}
                    placeholder="~/workspace/my-project"
                    onCommit={(v) => setNewDir(v)}
                  />
                </div>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--primary kv2-btn--small"
                  onClick={() => void handleAdd()}
                  disabled={adding || !newLabel.trim() || !newDir.trim()}
                >
                  {adding ? 'Adding...' : '+ Add'}
                </button>
              </div>
              <p className="ptp-hint">
                {targetLocations(newRuntime, newKind, newDir.trim() || '<directory>')
                  .map(({ label, path }) => `${label}: ${path}`)
                  .join(' · ')}
                {newRuntime === 'codex' && newKind !== 'user'
                  ? ' · trusted project에서만 로드되며 새 세션 또는 Codex 클라이언트 재시작이 필요할 수 있습니다.'
                  : ''}
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
