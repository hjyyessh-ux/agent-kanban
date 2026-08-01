import { useEffect, useState } from 'react';
import type { AgentRuntime, DiscoveredSkill, PlacementTarget, SkillRoot } from '../../../../src/core/types';
import { CardMarkdown } from '../Card/CardMarkdown';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { RuntimeBadge } from '../Board/BoardCardSections';
import { ScopeChip } from './ScopeChip';
import { fetchSkillContent, saveSkillContent, duplicateSkill, createSkillCard } from '../../hooks/useSkillsApi';
import { moveSkillApi, freezeSkillApi } from '../../hooks/useScopeInventory';
import { stripFrontmatter } from './capability-format';

interface SkillDetailModalProps {
  skill: DiscoveredSkill;
  skillRoots: SkillRoot[];
  placementTargets: PlacementTarget[];
  onClose: () => void;
  onSaved: () => void;
}

type PanelMode = 'preview' | 'edit';

export function SkillDetailModal({ skill, skillRoots, placementTargets, onClose, onSaved }: SkillDetailModalProps) {
  const [mode, setMode] = useState<PanelMode>('preview');
  const [content, setContent] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [duplicateRootId, setDuplicateRootId] = useState('');
  const [duplicating, setDuplicating] = useState(false);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  const [duplicateSuccess, setDuplicateSuccess] = useState(false);

  const [showImprove, setShowImprove] = useState(false);
  const [improvePrompt, setImprovePrompt] = useState('');
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [improveCardId, setImproveCardId] = useState<string | null>(null);

  const [portTarget, setPortTarget] = useState<AgentRuntime | ''>('');
  const [porting, setPorting] = useState(false);
  const [portError, setPortError] = useState<string | null>(null);
  const [portCardId, setPortCardId] = useState<string | null>(null);

  // Encoded as `root:<skillRootId>` or `target:<placementTargetId>`.
  const [moveSelection, setMoveSelection] = useState('');
  const [moving, setMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveSuccess, setMoveSuccess] = useState(false);

  const [freezing, setFreezing] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [frozenSuccess, setFrozenSuccess] = useState(false);

  const otherRoots = skillRoots.filter((r) => r.enabled && !skill.directory.startsWith(r.dir + '/'));
  const eligibleTargets = placementTargets.filter((t) => t.kind !== 'cold');

  useEffect(() => {
    if (!skill.filePath) {
      setLoadError('No file path available for this skill.');
      return;
    }
    fetchSkillContent(skill.id)
      .then(({ content: c }) => {
        setContent(c);
        setEditContent(c);
      })
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err.message : 'Failed to load content');
      });
  }, [skill.id, skill.filePath]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveSkillContent(skill.id, editContent);
      setContent(editContent);
      setMode('preview');
      onSaved();
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDuplicate = async () => {
    if (!duplicateRootId) return;
    setDuplicating(true);
    setDuplicateError(null);
    setDuplicateSuccess(false);
    try {
      await duplicateSkill(skill.id, duplicateRootId);
      setDuplicateSuccess(true);
      onSaved();
    } catch (err: unknown) {
      setDuplicateError(err instanceof Error ? err.message : 'Duplicate failed');
    } finally {
      setDuplicating(false);
    }
  };

  const handleImprove = async () => {
    if (!improvePrompt.trim()) return;
    setImproving(true);
    setImproveError(null);
    setImproveCardId(null);
    const skillContext = content
      ? `\`\`\`markdown\n${content}\n\`\`\``
      : `File path: ${skill.filePath ?? '(unknown)'}`;
    const description = [
      `Improve the following skill based on the direction below. Output the COMPLETE improved SKILL.md (including frontmatter) for the user to manually review and apply.`,
      ``,
      `**Do NOT write or patch any files automatically.** The user will copy-paste or apply changes manually after reviewing.`,
      ``,
      `## Skill: ${skill.displayName}`,
      `Runtime: ${skill.runtime} | Directory: ${skill.directory}`,
      ``,
      skillContext,
      ``,
      `## Improvement direction`,
      ``,
      improvePrompt.trim(),
      ``,
      `## Reference`,
      `skill-creator guide: ~/.codex/skills/.system/skill-creator/SKILL.md (read if available for format guidelines)`,
    ].join('\n');
    try {
      const card = await createSkillCard({
        title: `Improve skill: ${skill.displayName}`,
        description,
        agentRuntime: 'claude',
      });
      setImproveCardId(card.id);
      setImprovePrompt('');
      setShowImprove(false);
    } catch (err: unknown) {
      setImproveError(err instanceof Error ? err.message : 'Failed to create card');
    } finally {
      setImproving(false);
    }
  };

  const handlePort = async () => {
    if (!portTarget) return;
    setPorting(true);
    setPortError(null);
    setPortCardId(null);
    const skillContext = content
      ? `\`\`\`markdown\n${content}\n\`\`\``
      : `File path: ${skill.filePath ?? '(unknown)'}`;
    const portingRules: Record<string, string> = {
      codex: 'Use codex skill conventions: frontmatter with `name`/`description` fields; display name uses `$`-prefix.',
      claude: 'Use claude skill conventions: display name uses `/`-prefix slash command format.',
      opencode: 'Use opencode-compatible shared format. Refer to ~/.agents/skills/ for examples.',
    };
    const description = [
      `Port the following skill from **${skill.runtime}** format to **${portTarget}** format. Output the COMPLETE ported SKILL.md (including frontmatter) for the user to save manually.`,
      ``,
      `**Do NOT write or patch any files automatically.** The user will save the result to the appropriate directory.`,
      ``,
      `## Source skill: ${skill.displayName} (${skill.runtime})`,
      `Directory: ${skill.directory}`,
      ``,
      skillContext,
      ``,
      `## Porting instructions`,
      ``,
      portingRules[portTarget] ?? `Adapt to ${portTarget} format.`,
      `- Keep the skill's functionality and instructions intact.`,
      `- Update agent-specific references and frontmatter fields as needed.`,
      `- Output the full SKILL.md ready to place in the ${portTarget} skills directory.`,
    ].join('\n');
    try {
      const card = await createSkillCard({
        title: `Port skill: ${skill.displayName} → ${portTarget}`,
        description,
        agentRuntime: portTarget,
      });
      setPortCardId(card.id);
      setPortTarget('');
    } catch (err: unknown) {
      setPortError(err instanceof Error ? err.message : 'Failed to create card');
    } finally {
      setPorting(false);
    }
  };

  const handleMove = async () => {
    if (!moveSelection) return;
    if (skill.scope === 'project' || skill.source?.includes('project')) {
      if (!window.confirm('This skill is in a project directory (git-tracked). Moving it will create untracked changes. Continue?')) return;
    }
    setMoving(true);
    setMoveError(null);
    setMoveSuccess(false);
    try {
      const body = moveSelection.startsWith('target:')
        ? { placementTargetId: moveSelection.slice('target:'.length) }
        : { targetRootId: moveSelection.slice('root:'.length) };
      await moveSkillApi(skill.id, body);
      setMoveSuccess(true);
      onSaved();
    } catch (e: unknown) {
      setMoveError(e instanceof Error ? e.message : 'Move failed');
    } finally {
      setMoving(false);
    }
  };

  const handleFreeze = async () => {
    if (skill.scope === 'project' || skill.source?.includes('project')) {
      if (!window.confirm('This skill is in a project directory (git-tracked). Freezing it will create untracked changes. Continue?')) return;
    }
    setFreezing(true);
    setFreezeError(null);
    setFrozenSuccess(false);
    try {
      await freezeSkillApi(skill.id);
      setFrozenSuccess(true);
      onSaved();
      onClose();
    } catch (e: unknown) {
      setFreezeError(e instanceof Error ? e.message : 'Freeze failed');
    } finally {
      setFreezing(false);
    }
  };

  const isManaged = skill.scope === 'system';
  const otherRuntimes: AgentRuntime[] = (['claude', 'codex', 'opencode'] as AgentRuntime[]).filter(
    (r) => r !== skill.runtime,
  );

  return (
    <DialogSkeleton
      title={skill.displayName}
      onClose={onClose}
      persistSizeKey="cap-skill-detail-size"
      defaultSize={{ width: 800, height: 760 }}
      className="cap-detail-dialog"
    >
      <div className="cap-detail-stack">
        {/* Meta */}
        <div className="cap-detail-meta">
          <div className="cap-detail-badges">
            <RuntimeBadge runtime={skill.runtime} />
            <span className="cap-chip cap-chip--skill">skill</span>
            <ScopeChip scope={skill.scope === 'user' || skill.scope === 'system' ? 'user' : 'project'} />
          </div>
          {skill.description && <p className="cap-detail-desc">{skill.description}</p>}
          <div className="cap-detail-dir">{skill.directory}</div>
          {skill.tools && skill.tools.length > 0 && (
            <div className="cap-item-tools">
              {skill.tools.map((t) => (
                <span key={t} className="cap-chip cap-chip--tool">{t}</span>
              ))}
            </div>
          )}
        </div>

        {/* Preview / Edit toggle */}
        {skill.filePath && (
          <div className="cap-detail-toggle-row">
            <div className="cap-filter-group" role="group" aria-label="View mode">
              <button
                type="button"
                className={`cap-filter-btn${mode === 'preview' ? ' cap-filter-btn--active' : ''}`}
                onClick={() => setMode('preview')}
              >
                Preview
              </button>
              <button
                type="button"
                className={`cap-filter-btn${mode === 'edit' ? ' cap-filter-btn--active' : ''}`}
                onClick={() => setMode('edit')}
              >
                Edit
              </button>
            </div>
            {mode === 'edit' && (
              <button
                type="button"
                className="kv2-btn kv2-btn--primary kv2-btn--small"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            )}
          </div>
        )}

        {/* Content area */}
        <div className="cap-detail-body">
          {loadError ? (
            <p className="cap-detail-error">{loadError}</p>
          ) : content === null ? (
            skill.filePath ? (
              <div className="cap-detail-loading">Loading...</div>
            ) : (
              <p className="cap-detail-empty">No SKILL.md — this skill has no editable content.</p>
            )
          ) : mode === 'preview' ? (
            <div className="cap-detail-preview">
              <CardMarkdown text={stripFrontmatter(content)} />
            </div>
          ) : (
            <textarea
              className="kv2-textarea cap-detail-textarea"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              spellCheck={false}
              aria-label="SKILL.md content"
            />
          )}
        </div>

        {saveError && <p className="cap-detail-error">{saveError}</p>}

        {/* Duplicate section */}
        {otherRoots.length > 0 && (
          <div className="cap-detail-section">
            <span className="cap-detail-section-title">Duplicate to</span>
            <p className="cap-detail-section-hint">
              이 skill을 선택한 다른 skill 디렉토리(root)로 그대로 복사합니다.
            </p>
            <div className="cap-detail-action-row">
              <select
                className="kv2-select cap-detail-select"
                value={duplicateRootId}
                onChange={(e) => setDuplicateRootId(e.target.value)}
              >
                <option value="">— select target root —</option>
                {otherRoots.map((r) => (
                  <option key={r.id} value={r.id}>
                    [{r.agent}] {r.dir}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--small"
                onClick={() => void handleDuplicate()}
                disabled={!duplicateRootId || duplicating}
              >
                {duplicating ? 'Copying...' : 'Duplicate'}
              </button>
            </div>
            {duplicateError && <p className="cap-detail-error">{duplicateError}</p>}
            {duplicateSuccess && <p className="cap-detail-success">Duplicated successfully.</p>}
          </div>
        )}

        {/* Move to */}
        {!isManaged && (otherRoots.length > 0 || eligibleTargets.length > 0) && (
          <div className="cap-detail-section">
            <span className="cap-detail-section-title">Move to</span>
            <p className="cap-detail-section-hint">
              이 skill을 다른 root 또는 등록된 placement target으로 이동합니다(원본 삭제). Placement target으로
              이동하면 <code>{'<target dir>/.' + skill.runtime + '/skills'}</code> 아래로 옮겨지고, 해당 디렉토리가
              자동으로 Skill Directories에 등록됩니다. project 항목은 git 변경이 발생합니다.
            </p>
            <div className="cap-detail-action-row">
              <select
                className="kv2-select cap-detail-select"
                value={moveSelection}
                onChange={(e) => setMoveSelection(e.target.value)}
              >
                <option value="">— select target —</option>
                {otherRoots.length > 0 && (
                  <optgroup label="Skill Roots">
                    {otherRoots.map((r) => (
                      <option key={`root:${r.id}`} value={`root:${r.id}`}>
                        [{r.agent}] {r.dir}
                      </option>
                    ))}
                  </optgroup>
                )}
                {eligibleTargets.length > 0 && (
                  <optgroup label="Placement Targets">
                    {eligibleTargets.map((t) => (
                      <option key={`target:${t.id}`} value={`target:${t.id}`}>
                        [{t.kind}] {t.label} ({t.dir})
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--small"
                onClick={() => void handleMove()}
                disabled={!moveSelection || moving}
              >
                {moving ? 'Moving...' : 'Move'}
              </button>
            </div>
            {moveError && <p className="cap-detail-error">{moveError}</p>}
            {moveSuccess && <p className="cap-detail-success">Moved successfully.</p>}
          </div>
        )}

        {/* Freeze to Cold Storage */}
        {!isManaged && (
          <div className="cap-detail-section">
            <div className="cap-detail-action-header">
              <span className="cap-detail-section-title">❄ Freeze to Cold Storage</span>
              <button
                type="button"
                className="kv2-btn kv2-btn--small cold-freeze-btn"
                onClick={() => void handleFreeze()}
                disabled={freezing || frozenSuccess}
              >
                {freezing ? '보관 중…' : '❄ Freeze to storage'}
              </button>
            </div>
            <p className="cap-detail-section-hint">
              삭제하지 않고 현재 agent 설정에서만 분리합니다.
              필요할 때 Cold Storage 탭에서 원하는 위치로 복원할 수 있습니다.
            </p>
            {(skill.scope === 'project' || skill.source?.includes('project')) && (
              <p className="cap-detail-section-hint cap-detail-section-hint--danger">
                ⚠ project 항목: git 관리 파일이므로 이동 시 untracked 변경이 발생합니다.
              </p>
            )}
            {freezeError && <p className="cap-detail-error">{freezeError}</p>}
            {frozenSuccess && <p className="cap-detail-success">Frozen. Cold Storage 탭에서 restore 가능합니다.</p>}
          </div>
        )}

        {/* Improve with Claude */}
        <div className="cap-detail-section">
          <div className="cap-detail-action-header">
            <span className="cap-detail-section-title">Improve with Claude</span>
            {!showImprove && (
              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--small"
                onClick={() => { setShowImprove(true); setImproveError(null); setImproveCardId(null); }}
              >
                Improve...
              </button>
            )}
          </div>
          <p className="cap-detail-section-hint">
            개선 방향을 입력하면 Claude가 SKILL.md를 개선해주는 보드 카드를 생성합니다 (파일 자동 수정 없이 수동 검토용).
          </p>
          {showImprove && (
            <>
              <textarea
                className="kv2-textarea cap-detail-improve-input"
                placeholder="Describe the improvement direction (required)..."
                value={improvePrompt}
                onChange={(e) => setImprovePrompt(e.target.value)}
                rows={3}
                aria-label="Improvement direction"
              />
              <div className="cap-detail-action-row">
                <button
                  type="button"
                  className="kv2-btn kv2-btn--ghost kv2-btn--small"
                  onClick={() => { setShowImprove(false); setImprovePrompt(''); setImproveError(null); }}
                  disabled={improving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="kv2-btn kv2-btn--primary kv2-btn--small"
                  onClick={() => void handleImprove()}
                  disabled={!improvePrompt.trim() || improving}
                >
                  {improving ? 'Creating...' : 'Create Board Card'}
                </button>
              </div>
              {improveError && <p className="cap-detail-error">{improveError}</p>}
            </>
          )}
          {improveCardId && (
            <p className="cap-detail-success">
              Card created (id: {improveCardId.slice(0, 8)}…). Dispatch it from the board to start.
            </p>
          )}
        </div>

        {/* Port to another agent */}
        {skill.filePath && otherRuntimes.length > 0 && (
          <div className="cap-detail-section">
            <span className="cap-detail-section-title">Port to Agent</span>
            <p className="cap-detail-section-hint">
              이 skill을 다른 agent(claude/codex/opencode) 형식으로 변환하는 보드 카드를 생성합니다.
            </p>
            <div className="cap-detail-action-row">
              <select
                className="kv2-select cap-detail-select"
                value={portTarget}
                onChange={(e) => setPortTarget(e.target.value as AgentRuntime | '')}
              >
                <option value="">— select target agent —</option>
                {otherRuntimes.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
              <button
                type="button"
                className="kv2-btn kv2-btn--outline kv2-btn--small"
                onClick={() => void handlePort()}
                disabled={!portTarget || porting}
              >
                {porting ? 'Creating...' : 'Create Port Card'}
              </button>
            </div>
            {portError && <p className="cap-detail-error">{portError}</p>}
            {portCardId && (
              <p className="cap-detail-success">
                Port card created (id: {portCardId.slice(0, 8)}…). Dispatch it from the board to start.
              </p>
            )}
          </div>
        )}
      </div>
    </DialogSkeleton>
  );
}
