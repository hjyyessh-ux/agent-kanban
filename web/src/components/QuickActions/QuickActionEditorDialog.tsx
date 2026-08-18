import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentRuntime,
  CreateQuickActionInput,
  QuickActionView,
  ScriptEntry,
  UpdateQuickActionInput,
} from '../../../../src/core/types';
import {
  QUICK_ACTION_ICON_ERRORS,
  QUICK_ACTION_ICON_PALETTE,
} from '../../../../src/core/types';
import { useRuntimeDefaults } from '../../hooks/useRuntimeDefaults';
import { useRuntimeModelSelection } from '../../hooks/useRuntimeModelSelection';
import { AGENT_CONFIGS } from '../../constants/agents';
import { getFilteredCommandsForRuntime } from '../../constants/commands';
import { CommandPicker } from '../Card/CommandPicker';
import { DirectoryPicker } from '../Card/DirectoryPicker';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { ErrorAlert } from '../shared/ErrorAlert';
import { RuntimeModelFields } from '../shared/RuntimeModelFields';
import {
  applyQuickActionEditorDefaults,
  buildQuickActionInput,
  buildQuickActionUpdateInput,
  getFirstAvailableQuickActionIcon,
  getQuickActionIconChoices,
  isQuickActionIconUsed,
  makeQuickActionEditorDraft,
  makeQuickActionParameterDraft,
  type QuickActionEditorDraft,
  type QuickActionParameterDraft,
} from './quickActionEditorModel';

export interface QuickActionEditorDialogProps {
  action?: QuickActionView;
  actions: QuickActionView[];
  scripts: ScriptEntry[];
  error: string | null;
  onCreate: (input: CreateQuickActionInput) => Promise<QuickActionView>;
  onUpdate: (id: string, input: UpdateQuickActionInput) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
  onSaved: () => void;
  onCancel: () => void;
}

export const QuickActionEditorDialog: React.FC<QuickActionEditorDialogProps> = ({
  action,
  actions,
  scripts,
  error,
  onCreate,
  onUpdate,
  onRefresh,
  onClearError,
  onSaved,
  onCancel,
}) => {
  const { prefs } = useRuntimeDefaults();
  const touchedRef = useRef({ runtime: false, model: false });
  const [draft, setDraft] = useState<QuickActionEditorDraft>(() => (
    makeQuickActionEditorDraft(action, {
      runtime: prefs.runtime ?? 'opencode',
      icon: action?.icon ?? getFirstAvailableQuickActionIcon(actions),
    })
  ));
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const {
    orderedRuntimes,
    displayedModels,
    getDefaultModelForRuntime,
  } = useRuntimeModelSelection(draft.agentRuntime, draft.agentType || 'sisyphus');
  const filteredCommands = useMemo(
    () => getFilteredCommandsForRuntime(draft.agentRuntime),
    [draft.agentRuntime],
  );
  const iconChoices = useMemo(
    () => getQuickActionIconChoices(actions, draft.icon, draft.id),
    [actions, draft.icon, draft.id],
  );
  const customIcon = QUICK_ACTION_ICON_PALETTE.some((icon) => icon === draft.icon)
    ? ''
    : draft.icon;
  const iconConflict = draft.icon.length > 0
    && isQuickActionIconUsed(actions, draft.icon, draft.id);

  useEffect(() => {
    setDraft((current) => applyQuickActionEditorDefaults(
      current,
      prefs.runtime,
      touchedRef.current,
      getDefaultModelForRuntime,
    ));
  }, [getDefaultModelForRuntime, prefs.runtime]);

  const updateParameterDraft = (index: number, patch: Partial<QuickActionParameterDraft>) => {
    setDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, parameterIndex) => (
        parameterIndex === index ? { ...parameter, ...patch } : parameter
      )),
    }));
  };

  const saveAction = async () => {
    setLocalError(null);
    if (iconConflict) {
      setLocalError(QUICK_ACTION_ICON_ERRORS.duplicate);
      return;
    }

    setSaving(true);
    try {
      if (draft.id) {
        await onUpdate(draft.id, buildQuickActionUpdateInput(draft));
      } else {
        await onCreate(buildQuickActionInput(draft));
      }
      onSaved();
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : 'Failed to save quick action');
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogSkeleton
      title={draft.id ? 'Edit Quick Action' : 'Add Quick Action'}
      onClose={onCancel}
      width="48rem"
      className="kv2-dialog--quick-actions"
      persistSizeKey="quick-action-editor-dialog-size"
      defaultSize={{ width: 768, height: 800 }}
    >
      {(error || localError) && (
        <ErrorAlert
          title="Quick Action error"
          message={localError ?? error ?? 'Unknown error'}
          actionLabel="Refresh"
          onAction={() => { void onRefresh(); }}
          onDismiss={() => {
            setLocalError(null);
            onClearError();
          }}
          variant="inline"
        />
      )}

      <div className="kv2-quick-actions-shell">
        <div className="kv2-quick-action-editor-grid">
          <div className="kv2-form-group">
            <label className="kv2-label" htmlFor="quick-action-type">Action type</label>
            <select
              id="quick-action-type"
              className="kv2-select"
              value={draft.type}
              disabled={Boolean(draft.id)}
              onChange={(event) => setDraft((current) => ({
                ...current,
                type: event.target.value as QuickActionView['type'],
              }))}
            >
              <option value="prompt">Prompt</option>
              <option value="script">Script</option>
            </select>
          </div>
          <div className="kv2-form-group">
            <label className="kv2-label" htmlFor="quick-action-name">Name</label>
            <input
              id="quick-action-name"
              className="kv2-input"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>

          <section
            className="kv2-form-group kv2-quick-action-editor-wide kv2-quick-action-icon-picker"
            aria-labelledby="quick-action-icon-heading"
          >
            <div className="kv2-quick-action-icon-heading">
              <div>
                <div id="quick-action-icon-heading" className="kv2-label">Icon</div>
                <div className="kv2-quick-action-field-meta">
                  Icons marked in use belong to another Quick Action.
                </div>
              </div>
              <output className="kv2-quick-action-icon-preview" aria-label={`Selected icon ${draft.icon || 'none'}`}>
                {draft.icon || '—'}
              </output>
            </div>
            <div className="kv2-quick-action-icon-options" role="group" aria-label="Default icon palette">
              {iconChoices.map(({ icon, selected, used }) => (
                <button
                  key={icon}
                  type="button"
                  className={`kv2-btn ${selected ? 'kv2-btn--primary' : 'kv2-btn--outline'} kv2-quick-action-icon-option`}
                  aria-label={`${icon}${used ? ' already in use' : selected ? ' selected' : ''}`}
                  aria-pressed={selected}
                  disabled={used}
                  title={used ? 'Already used by another Quick Action' : `Use ${icon}`}
                  onClick={() => setDraft((current) => ({ ...current, icon }))}
                >
                  <span aria-hidden="true">{icon}</span>
                </button>
              ))}
            </div>
            <div className="kv2-quick-action-custom-icon-row">
              <label className="kv2-label" htmlFor="quick-action-custom-icon">Custom emoji</label>
              <input
                id="quick-action-custom-icon"
                className={`kv2-input${iconConflict ? ' kv2-input--error' : ''}`}
                value={customIcon}
                aria-invalid={iconConflict}
                placeholder="One emoji, for example 🧑‍💻"
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  icon: event.target.value,
                }))}
              />
            </div>
            {iconConflict && (
              <div className="kv2-quick-action-field-meta" role="alert">
                {QUICK_ACTION_ICON_ERRORS.duplicate}
              </div>
            )}
          </section>

          <div className="kv2-form-group kv2-quick-action-editor-wide">
            <label className="kv2-label" htmlFor="quick-action-description">Description</label>
            <textarea
              id="quick-action-description"
              className="kv2-textarea"
              value={draft.description}
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </div>

          {draft.type === 'prompt' ? (
            <>
              <div className="kv2-form-group kv2-quick-action-editor-wide">
                <label className="kv2-label" htmlFor="quick-action-card-title">Card title template</label>
                <input
                  id="quick-action-card-title"
                  className="kv2-input"
                  value={draft.cardTitleTemplate}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    cardTitleTemplate: event.target.value,
                  }))}
                />
              </div>
              <div className="kv2-form-group kv2-quick-action-editor-wide">
                <label className="kv2-label" htmlFor="quick-action-prompt">Prompt template</label>
                <textarea
                  id="quick-action-prompt"
                  className="kv2-textarea"
                  value={draft.promptTemplate}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    promptTemplate: event.target.value,
                  }))}
                />
              </div>
              <div className="kv2-form-group kv2-quick-action-editor-wide">
                <label className="kv2-label" htmlFor="quick-action-project-dir">Project directory *</label>
                <DirectoryPicker
                  id="quick-action-project-dir"
                  value={draft.projectDir}
                  onChange={(projectDir) => setDraft((current) => ({ ...current, projectDir }))}
                  commitLabel="Use directory"
                  onCommit={(projectDir) => setDraft((current) => ({ ...current, projectDir }))}
                />
                <span className="kv2-quick-action-field-meta">
                  Confirm the directory to continue; recent directories are shared with task creation.
                </span>
              </div>
              <RuntimeModelFields
                runtime={draft.agentRuntime}
                model={draft.model}
                orderedRuntimes={orderedRuntimes}
                displayedModels={displayedModels}
                runtimeInputId="quick-action-runtime"
                modelInputId="quick-action-model"
                className="kv2-quick-action-editor-wide"
                selectorVariant="cards"
                onRuntimeChange={(agentRuntime) => {
                  touchedRef.current.runtime = true;
                  touchedRef.current.model = false;
                  setDraft((current) => ({
                    ...current,
                    agentRuntime,
                    model: getDefaultModelForRuntime(agentRuntime, current.agentType || 'sisyphus'),
                    command: '',
                    commandArguments: '',
                  }));
                }}
                onModelChange={(model) => {
                  touchedRef.current.model = true;
                  setDraft((current) => ({ ...current, model }));
                }}
              />
              {draft.agentRuntime === 'opencode' && (
                <div className="kv2-create-field kv2-quick-action-editor-wide">
                  <div className="kv2-create-label">Agent</div>
                  <div className="kv2-create-agent-row">
                    {AGENT_CONFIGS.map((agent) => (
                      <button
                        key={agent.key}
                        type="button"
                        className={`kv2-create-agent-chip${draft.agentType === agent.key ? ' kv2-create-agent-chip--active' : ''}`}
                        onClick={() => {
                          touchedRef.current.model = false;
                          setDraft((current) => ({
                            ...current,
                            agentType: agent.key,
                            model: getDefaultModelForRuntime('opencode', agent.key),
                          }));
                        }}
                      >
                        {agent.emoji} {agent.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {draft.agentRuntime === 'codex' && (
                <div className="kv2-create-field kv2-quick-action-editor-wide">
                  <div className="kv2-create-label">Codex Options</div>
                  <div className="kv2-create-input-row">
                    <select
                      className="kv2-create-select"
                      aria-label="Codex reasoning effort"
                      value={draft.codexReasoningEffort}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        codexReasoningEffort: event.target.value as QuickActionEditorDraft['codexReasoningEffort'],
                      }))}
                    >
                      <option value="low">Reasoning: low</option>
                      <option value="medium">Reasoning: medium</option>
                      <option value="high">Reasoning: high</option>
                      <option value="xhigh">Reasoning: xhigh</option>
                    </select>
                    <select
                      className="kv2-create-select"
                      aria-label="Codex sandbox"
                      value={draft.codexSandbox}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        codexSandbox: event.target.value as QuickActionEditorDraft['codexSandbox'],
                      }))}
                    >
                      <option value="read-only">Sandbox: read-only</option>
                      <option value="workspace-write">Sandbox: workspace-write</option>
                      <option value="danger-full-access">Sandbox: danger-full-access</option>
                    </select>
                  </div>
                  <label className="kv2-create-radio-label">
                    <input
                      type="checkbox"
                      checked={draft.codexSkipGitRepoCheck}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        codexSkipGitRepoCheck: event.target.checked,
                      }))}
                    />
                    <div><div className="kv2-create-radio-title">Skip git repo check</div></div>
                  </label>
                  <label className="kv2-create-radio-label">
                    <input
                      type="checkbox"
                      checked={draft.codexBypassApprovalsAndSandbox}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        codexBypassApprovalsAndSandbox: event.target.checked,
                      }))}
                    />
                    <div><div className="kv2-create-radio-title">Bypass approvals and sandbox</div></div>
                  </label>
                </div>
              )}
              {draft.agentRuntime === 'claude' && (
                <div className="kv2-create-field kv2-quick-action-editor-wide">
                  <div className="kv2-create-label">Claude Permissions</div>
                  <select
                    className="kv2-create-select"
                    aria-label="Claude permission mode"
                    value={draft.claudePermissionMode}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      claudePermissionMode: event.target.value as QuickActionEditorDraft['claudePermissionMode'],
                    }))}
                    disabled={draft.claudeDangerouslySkipPermissions}
                  >
                    <option value="acceptEdits">acceptEdits</option>
                    <option value="plan">plan</option>
                    <option value="dontAsk">dontAsk</option>
                    <option value="bypassPermissions">bypassPermissions</option>
                  </select>
                  <label className="kv2-create-radio-label">
                    <input
                      type="checkbox"
                      checked={draft.claudeDangerouslySkipPermissions}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        claudeDangerouslySkipPermissions: event.target.checked,
                      }))}
                    />
                    <div><div className="kv2-create-radio-title">Dangerously skip permissions</div></div>
                  </label>
                </div>
              )}
              <div className="kv2-create-field kv2-quick-action-editor-wide">
                <div className="kv2-create-label">Command</div>
                <div className="kv2-session-helper">
                  Optional. Uses the same runtime-aware command picker as task creation.
                </div>
                <CommandPicker
                  id="quick-action-command"
                  runtime={draft.agentRuntime}
                  value={draft.command}
                  commands={filteredCommands}
                  onChange={(command) => setDraft((current) => ({
                    ...current,
                    command,
                    commandArguments: command ? current.commandArguments : '',
                  }))}
                />
                {draft.command && (
                  <div className="kv2-create-field kv2-create-command-arguments">
                    <label className="kv2-create-label" htmlFor="quick-action-command-arguments">
                      Command parameters template
                    </label>
                    <input
                      id="quick-action-command-arguments"
                      className="kv2-create-input"
                      value={draft.commandArguments}
                      onChange={(event) => setDraft((current) => ({
                        ...current,
                        commandArguments: event.target.value,
                      }))}
                      placeholder="Optional; supports {{parameterKey}}"
                    />
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <div className="kv2-form-group kv2-quick-action-editor-wide">
                <label className="kv2-label" htmlFor="quick-action-script">Script</label>
                <select
                  id="quick-action-script"
                  className="kv2-select"
                  value={draft.scriptId}
                  onChange={(event) => setDraft((current) => ({
                    ...current,
                    scriptId: event.target.value,
                  }))}
                >
                  <option value="">Select a script…</option>
                  {scripts.map((script) => (
                    <option key={script.id} value={script.id}>{script.name}</option>
                  ))}
                </select>
              </div>
              <div className="kv2-form-group kv2-quick-action-editor-wide">
                <label className="kv2-label" htmlFor="quick-action-script-dir">
                  Project directory override
                </label>
                <DirectoryPicker
                  id="quick-action-script-dir"
                  value={draft.projectDir}
                  onChange={(projectDir) => setDraft((current) => ({ ...current, projectDir }))}
                  commitLabel="Use override"
                  onCommit={(projectDir) => setDraft((current) => ({ ...current, projectDir }))}
                />
                <span className="kv2-quick-action-field-meta">
                  Leave empty to use the Script directory.
                </span>
              </div>
            </>
          )}

          <div className="kv2-quick-action-editor-wide kv2-quick-action-behavior-options">
            <label className="kv2-create-radio-label">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  enabled: event.target.checked,
                }))}
              />
              <span className="kv2-quick-action-behavior-copy">
                <span className="kv2-create-radio-title">Allow this action to run</span>
                <span className="kv2-quick-action-field-meta">
                  Turn this off to keep the action saved while preventing new runs.
                </span>
              </span>
            </label>
            <label className="kv2-create-radio-label">
              <input
                type="checkbox"
                checked={draft.pinned}
                onChange={(event) => setDraft((current) => ({
                  ...current,
                  pinned: event.target.checked,
                }))}
              />
              <span className="kv2-quick-action-behavior-copy">
                <span className="kv2-create-radio-title">Pin to top of list</span>
                <span className="kv2-quick-action-field-meta">
                  Show this action before Quick Actions that are not pinned.
                </span>
              </span>
            </label>
          </div>
        </div>

        <section className="kv2-quick-action-parameters" aria-labelledby="quick-action-parameters-heading">
          <div className="kv2-quick-action-section-heading">
            <div>
              <h3 id="quick-action-parameters-heading" className="kv2-panel-heading">Parameters</h3>
              <p className="kv2-panel-subtitle">
                Use the same key inside <code>{'{{key}}'}</code>; Script actions receive <code>AK_PARAM_KEY</code>.
              </p>
            </div>
            <button
              type="button"
              className="kv2-btn kv2-btn--small kv2-btn--outline"
              onClick={() => setDraft((current) => ({
                ...current,
                parameters: [...current.parameters, makeQuickActionParameterDraft()],
              }))}
            >
              Add Parameter
            </button>
          </div>
          {draft.parameters.map((parameter, index) => (
            <div className="kv2-quick-action-parameter-row" key={parameter.rowId}>
              <input
                aria-label={`Parameter ${index + 1} key`}
                className="kv2-input"
                placeholder="key"
                value={parameter.key}
                onChange={(event) => updateParameterDraft(index, { key: event.target.value })}
              />
              <input
                aria-label={`Parameter ${index + 1} label`}
                className="kv2-input"
                placeholder="Label"
                value={parameter.label}
                onChange={(event) => updateParameterDraft(index, { label: event.target.value })}
              />
              <select
                aria-label={`Parameter ${index + 1} type`}
                className="kv2-select"
                value={parameter.type}
                onChange={(event) => updateParameterDraft(index, {
                  type: event.target.value as QuickActionParameterDraft['type'],
                  defaultValue: '',
                  options: '',
                })}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="boolean">boolean</option>
                <option value="select">select</option>
                <option value="secret">secret</option>
              </select>
              {parameter.type === 'select' ? (
                <input
                  aria-label={`Parameter ${index + 1} options`}
                  className="kv2-input"
                  placeholder="one, two"
                  value={parameter.options}
                  onChange={(event) => updateParameterDraft(index, { options: event.target.value })}
                />
              ) : parameter.type === 'boolean' ? (
                <select
                  aria-label={`Parameter ${index + 1} default`}
                  className="kv2-select"
                  value={parameter.defaultValue}
                  onChange={(event) => updateParameterDraft(index, { defaultValue: event.target.value })}
                >
                  <option value="">No default</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              ) : parameter.type === 'secret' ? (
                <span className="kv2-quick-action-no-default">No default</span>
              ) : (
                <input
                  aria-label={`Parameter ${index + 1} default`}
                  className="kv2-input"
                  placeholder="Default"
                  value={parameter.defaultValue}
                  onChange={(event) => updateParameterDraft(index, { defaultValue: event.target.value })}
                />
              )}
              <label className="kv2-quick-action-checkbox">
                <input
                  type="checkbox"
                  checked={parameter.required}
                  onChange={(event) => updateParameterDraft(index, { required: event.target.checked })}
                />
                <span>Required</span>
              </label>
              <button
                type="button"
                className="kv2-btn kv2-btn--small kv2-btn--subtle-danger"
                aria-label={`Remove parameter ${index + 1}`}
                onClick={() => setDraft((current) => ({
                  ...current,
                  parameters: current.parameters.filter((_value, parameterIndex) => (
                    parameterIndex !== index
                  )),
                }))}
              >
                Remove
              </button>
            </div>
          ))}
        </section>

        <div className="kv2-actions-split">
          <button
            type="button"
            className="kv2-btn kv2-btn--outline kv2-action-cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            disabled={saving || iconConflict}
            onClick={() => { void saveAction(); }}
          >
            {saving ? 'Saving…' : 'Save Action'}
          </button>
        </div>
      </div>
    </DialogSkeleton>
  );
};
