import { useState } from 'react';
import type { PlacementTarget, CreatePlacementTargetInput, CapScope, McpRuntime } from '../../../../src/core/types';
import { DirectoryPicker } from '../Card/DirectoryPicker';

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

/**
 * Inline (always-visible) Placement Targets manager shown at the top of the
 * Inventory view. Replaces the old header "Targets" button + modal so users
 * can see at a glance *where* MCP servers / skills can be placed.
 */
export function PlacementTargetsPanel({ targets, loading, onAdd, onRemove }: PlacementTargetsPanelProps) {
  const [showAddForm, setShowAddForm] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newDir, setNewDir] = useState('');
  const [newKind, setNewKind] = useState<CapScope>('local');
  const [newRuntime, setNewRuntime] = useState<McpRuntime>('claude');
  const [newTeamShared, setNewTeamShared] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <section className="ptp-panel" aria-label="Placement targets">
      <div className="ptp-header">
        <div className="ptp-header-text">
          <h3 className="ptp-title">Placement Targets</h3>
          <p className="ptp-hint">
            MCP 서버와 skill을 배치(copy / move / restore)할 수 있는 대상 위치입니다.
          </p>
        </div>
        <button
          type="button"
          className="kv2-btn kv2-btn--outline kv2-btn--small"
          onClick={() => { setShowAddForm((v) => !v); setError(null); }}
          aria-expanded={showAddForm}
        >
          {showAddForm ? 'Cancel' : '+ Add Target'}
        </button>
      </div>

      {error && <p className="ptp-error">{error}</p>}

      <div className="ptp-list">
        {loading && targets.length === 0 && <p className="ptp-empty">Loading...</p>}
        {!loading && targets.length === 0 && <p className="ptp-empty">No targets configured.</p>}
        {targets.map((t) => (
          <div key={t.id} className="ptp-item">
            <span
              className={`scope-chip scope-chip--${t.kind}`}
              title={KIND_HINTS[t.runtime][t.kind] ?? t.kind}
            >
              {t.kind}
            </span>
            <span className={`kv2-badge cap-badge--${t.runtime}`}>{t.runtime}</span>
            <span className="ptp-item-label">{t.label}</span>
            <span className="ptp-item-dir" title={targetConfigPath(t.runtime, t.kind, t.dir)}>
              {targetConfigPath(t.runtime, t.kind, t.dir)}
            </span>
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
          </div>
        ))}
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
            설정 파일: {targetConfigPath(newRuntime, newKind, newDir.trim() || '<directory>')}
            {newRuntime === 'codex' && newKind !== 'user'
              ? ' · trusted project에서만 로드되며 새 세션 또는 Codex 클라이언트 재시작이 필요할 수 있습니다.'
              : ''}
          </p>
        </div>
      )}
    </section>
  );
}
