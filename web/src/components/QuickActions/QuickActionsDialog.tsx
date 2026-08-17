import React, { useMemo, useState } from 'react';
import type {
  AgentRuntime,
  CreateQuickActionInput,
  QuickActionParameterDefinition,
  QuickActionParameterValue,
  QuickActionView,
  RunQuickActionResponse,
  ScriptEntry,
  UpdateQuickActionInput,
} from '../../../../src/core/types';
import { parameterEnvironmentKey } from '../../../../src/core/execution-environment';
import { buildQuickActionFormModel } from '../../hooks/quickActionFormModel';
import { useRuntimeModelSelection } from '../../hooks/useRuntimeModelSelection';
import { AGENT_CONFIGS } from '../../constants/agents';
import {
  getFilteredCommandsForRuntime,
  type CommandId,
} from '../../constants/commands';
import { CommandPicker } from '../Card/CommandPicker';
import { DirectoryPicker } from '../Card/DirectoryPicker';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { ErrorAlert } from '../shared/ErrorAlert';
import { RuntimeModelFields } from '../shared/RuntimeModelFields';

type DialogMode = 'launcher' | 'manage' | 'run' | 'editor';

interface ParameterDraft {
  key: string;
  label: string;
  type: QuickActionParameterDefinition['type'];
  required: boolean;
  defaultValue: string;
  options: string;
}

interface EditorDraft {
  id?: string;
  type: QuickActionView['type'];
  name: string;
  description: string;
  enabled: boolean;
  pinned: boolean;
  order: number;
  projectDir: string;
  cardTitleTemplate: string;
  promptTemplate: string;
  agentRuntime: AgentRuntime;
  model: string;
  agentType: string;
  command: CommandId | '';
  commandArguments: string;
  codexReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh';
  codexSandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  codexSkipGitRepoCheck: boolean;
  codexBypassApprovalsAndSandbox: boolean;
  claudePermissionMode: 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';
  claudeDangerouslySkipPermissions: boolean;
  scriptId: string;
  parameters: ParameterDraft[];
}

export interface QuickActionsDialogProps {
  actions: QuickActionView[];
  scripts: ScriptEntry[];
  loading: boolean;
  error: string | null;
  runningActionIds: string[];
  onCreate: (input: CreateQuickActionInput) => Promise<QuickActionView>;
  onUpdate: (id: string, input: UpdateQuickActionInput) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onRun: (
    id: string,
    parameterValues: Readonly<Record<string, unknown>>,
  ) => Promise<RunQuickActionResponse>;
  onRefresh: () => Promise<void>;
  onClearError: () => void;
  onClose: () => void;
}

const EMPTY_PARAMETER: ParameterDraft = {
  key: '',
  label: '',
  type: 'string',
  required: false,
  defaultValue: '',
  options: '',
};

function parameterDraftFromDefinition(definition: QuickActionParameterDefinition): ParameterDraft {
  return {
    key: definition.key,
    label: definition.label,
    type: definition.type,
    required: definition.required,
    defaultValue: definition.defaultValue === undefined ? '' : String(definition.defaultValue),
    options: definition.type === 'select' ? definition.options.join(', ') : '',
  };
}

export function makeQuickActionEditorDraft(action?: QuickActionView): EditorDraft {
  return {
    id: action?.id,
    type: action?.type ?? 'prompt',
    name: action?.name ?? '',
    description: action?.description ?? '',
    enabled: action?.enabled ?? true,
    pinned: action?.pinned ?? false,
    order: action?.order ?? 0,
    projectDir: action?.projectDir ?? '',
    cardTitleTemplate: action?.type === 'prompt' ? action.cardTitleTemplate : '',
    promptTemplate: action?.type === 'prompt' ? action.promptTemplate : '',
    agentRuntime: action?.type === 'prompt' ? action.agentRuntime : 'codex',
    model: action?.type === 'prompt' ? (action.model ?? '') : '',
    agentType: action?.type === 'prompt' ? (action.agentType ?? '') : '',
    command: action?.type === 'prompt' ? (action.command ?? '') : '',
    commandArguments: action?.type === 'prompt' ? (action.argumentsTemplate ?? '') : '',
    codexReasoningEffort: action?.type === 'prompt'
      ? (action.codexOptions?.reasoningEffort ?? 'high')
      : 'high',
    codexSandbox: action?.type === 'prompt'
      ? (action.codexOptions?.sandbox ?? 'workspace-write')
      : 'workspace-write',
    codexSkipGitRepoCheck: action?.type === 'prompt'
      ? (action.codexOptions?.skipGitRepoCheck ?? true)
      : true,
    codexBypassApprovalsAndSandbox: action?.type === 'prompt'
      ? (action.codexOptions?.bypassApprovalsAndSandbox ?? false)
      : false,
    claudePermissionMode: action?.type === 'prompt'
      ? (action.claudeOptions?.permissionMode ?? 'acceptEdits')
      : 'acceptEdits',
    claudeDangerouslySkipPermissions: action?.type === 'prompt'
      ? (action.claudeOptions?.dangerouslySkipPermissions ?? false)
      : false,
    scriptId: action?.type === 'script' ? action.scriptId : '',
    parameters: action?.parameterDefinitions.map(parameterDraftFromDefinition) ?? [],
  };
}

function parseParameterDrafts(drafts: readonly ParameterDraft[]): QuickActionParameterDefinition[] {
  const definitions: QuickActionParameterDefinition[] = [];
  const keys = new Set<string>();
  const environmentKeys = new Set<string>();

  for (const [index, draft] of drafts.entries()) {
    const position = index + 1;
    const key = draft.key.trim();
    const label = draft.label.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Parameter ${position} key must use letters, numbers, and underscores`);
    }
    if (!label) throw new Error(`Parameter ${position} label is required`);
    if (keys.has(key)) throw new Error(`Duplicate parameter key: ${key}`);
    keys.add(key);

    const environmentKey = parameterEnvironmentKey(key);
    if (environmentKeys.has(environmentKey)) {
      throw new Error(`Parameter environment key collision: ${environmentKey}`);
    }
    environmentKeys.add(environmentKey);

    const base = { key, label, required: draft.required };
    if (draft.type === 'secret') {
      definitions.push({ ...base, type: 'secret' });
      continue;
    }
    if (draft.type === 'select') {
      const options = draft.options.split(',').map((value) => value.trim()).filter(Boolean);
      if (options.length === 0) throw new Error(`Parameter ${label} needs at least one option`);
      if (new Set(options).size !== options.length) {
        throw new Error(`Parameter ${label} options must be unique`);
      }
      if (draft.defaultValue && !options.includes(draft.defaultValue)) {
        throw new Error(`Parameter ${label} default must match an option`);
      }
      definitions.push({
        ...base,
        type: 'select',
        options,
        ...(draft.defaultValue ? { defaultValue: draft.defaultValue } : {}),
      });
      continue;
    }
    if (draft.type === 'number') {
      const numberValue = draft.defaultValue === '' ? undefined : Number(draft.defaultValue);
      if (numberValue !== undefined && !Number.isFinite(numberValue)) {
        throw new Error(`Parameter ${label} default must be a finite number`);
      }
      definitions.push({
        ...base,
        type: 'number',
        ...(numberValue === undefined ? {} : { defaultValue: numberValue }),
      });
      continue;
    }
    if (draft.type === 'boolean') {
      if (draft.defaultValue && draft.defaultValue !== 'true' && draft.defaultValue !== 'false') {
        throw new Error(`Parameter ${label} boolean default is invalid`);
      }
      definitions.push({
        ...base,
        type: 'boolean',
        ...(draft.defaultValue ? { defaultValue: draft.defaultValue === 'true' } : {}),
      });
      continue;
    }
    definitions.push({
      ...base,
      type: 'string',
      ...(draft.defaultValue ? { defaultValue: draft.defaultValue } : {}),
    });
  }

  return definitions;
}

export function buildQuickActionInput(draft: EditorDraft): CreateQuickActionInput {
  const name = draft.name.trim();
  if (!name) throw new Error('Action name is required');
  const parameterDefinitions = parseParameterDrafts(draft.parameters);
  const common = {
    name,
    description: draft.description.trim(),
    enabled: draft.enabled,
    pinned: draft.pinned,
    order: draft.order,
    parameterDefinitions,
  };

  if (draft.type === 'script') {
    if (!draft.scriptId) throw new Error('Script is required');
    return {
      ...common,
      type: 'script',
      scriptId: draft.scriptId,
      ...(draft.projectDir.trim() ? { projectDir: draft.projectDir.trim() } : {}),
    };
  }

  if (!draft.cardTitleTemplate.trim()) throw new Error('Card title template is required');
  if (!draft.promptTemplate.trim()) throw new Error('Prompt template is required');
  if (!draft.projectDir.trim()) throw new Error('Prompt project directory is required');
  return {
    ...common,
    type: 'prompt',
    cardTitleTemplate: draft.cardTitleTemplate,
    promptTemplate: draft.promptTemplate,
    projectDir: draft.projectDir.trim(),
    agentRuntime: draft.agentRuntime,
    ...(draft.model.trim() ? { model: draft.model.trim() } : {}),
    ...(draft.agentRuntime === 'opencode' && draft.agentType.trim()
      ? { agentType: draft.agentType.trim() }
      : {}),
    ...(draft.command ? { command: draft.command } : {}),
    ...(draft.command && draft.commandArguments.trim()
      ? { argumentsTemplate: draft.commandArguments.trim() }
      : {}),
    ...(draft.agentRuntime === 'codex'
      ? {
          codexOptions: {
            reasoningEffort: draft.codexReasoningEffort,
            sandbox: draft.codexSandbox,
            skipGitRepoCheck: draft.codexSkipGitRepoCheck,
            bypassApprovalsAndSandbox: draft.codexBypassApprovalsAndSandbox,
          },
        }
      : {}),
    ...(draft.agentRuntime === 'claude'
      ? {
          claudeOptions: {
            permissionMode: draft.claudePermissionMode,
            dangerouslySkipPermissions: draft.claudeDangerouslySkipPermissions,
          },
        }
      : {}),
  };
}

export function isProductionQuickAction(action: QuickActionView): boolean {
  const text = `${action.name} ${action.description} ${action.projectDir ?? ''} ${action.effectiveProjectDir ?? ''}`.toLowerCase();
  return /(^|[^a-z])(prod|production)([^a-z]|$)/.test(text)
    || (action.type === 'prompt' && action.codexOptions?.sandbox === 'danger-full-access')
    || (action.type === 'prompt' && action.claudeOptions?.permissionMode === 'bypassPermissions');
}

function initialRunValues(action: QuickActionView): Record<string, QuickActionParameterValue> {
  return Object.fromEntries(
    action.parameterDefinitions.flatMap((definition) => (
      definition.type !== 'secret' && definition.defaultValue !== undefined
        ? [[definition.key, definition.defaultValue] as const]
        : []
    )),
  );
}

function ActionSummary({ action }: { action: QuickActionView }) {
  return (
    <dl className="kv2-quick-action-summary">
      <div><dt>Action type</dt><dd>{action.type === 'prompt' ? 'Prompt' : 'Script'}</dd></div>
      {action.type === 'script' && (
        <div><dt>Script</dt><dd>{action.scriptName ?? action.scriptId}</dd></div>
      )}
      {action.type === 'prompt' && action.command && (
        <div><dt>Command</dt><dd>/{action.command}</dd></div>
      )}
      <div><dt>Project directory</dt><dd>{action.effectiveProjectDir || 'Not configured'}</dd></div>
      <div><dt>Parameters</dt><dd>{action.parameterDefinitions.length}</dd></div>
    </dl>
  );
}

export const QuickActionsDialog: React.FC<QuickActionsDialogProps> = ({
  actions,
  scripts,
  loading,
  error,
  runningActionIds,
  onCreate,
  onUpdate,
  onDelete,
  onRun,
  onRefresh,
  onClearError,
  onClose,
}) => {
  const [mode, setMode] = useState<DialogMode>('launcher');
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null);
  const [parameterValues, setParameterValues] = useState<Record<string, unknown>>({});
  const [editorDraft, setEditorDraft] = useState<EditorDraft>(() => makeQuickActionEditorDraft());
  const [localError, setLocalError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const {
    orderedRuntimes,
    displayedModels,
    getDefaultModelForRuntime,
  } = useRuntimeModelSelection(editorDraft.agentRuntime, editorDraft.agentType || 'sisyphus');
  const filteredCommands = useMemo(
    () => getFilteredCommandsForRuntime(editorDraft.agentRuntime),
    [editorDraft.agentRuntime],
  );

  const selectedAction = useMemo(
    () => actions.find((action) => action.id === selectedActionId) ?? null,
    [actions, selectedActionId],
  );
  const formModel = selectedAction
    ? buildQuickActionFormModel(selectedAction, parameterValues)
    : null;
  const productionRisk = selectedAction ? isProductionQuickAction(selectedAction) : false;

  const resetTo = (nextMode: DialogMode) => {
    setMode(nextMode);
    setSelectedActionId(null);
    setParameterValues({});
    setProductionConfirmed(false);
    setLocalError(null);
  };

  const openRun = (action: QuickActionView) => {
    setSelectedActionId(action.id);
    setParameterValues(initialRunValues(action));
    setProductionConfirmed(false);
    setLocalError(null);
    setMode('run');
  };

  const openEditor = (action?: QuickActionView) => {
    setEditorDraft(makeQuickActionEditorDraft(action));
    setLocalError(null);
    setMode('editor');
  };

  const updateParameterDraft = (index: number, patch: Partial<ParameterDraft>) => {
    setEditorDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, parameterIndex) => (
        parameterIndex === index ? { ...parameter, ...patch } : parameter
      )),
    }));
  };

  const saveAction = async () => {
    setLocalError(null);
    setSaving(true);
    try {
      const input = buildQuickActionInput(editorDraft);
      if (editorDraft.id) await onUpdate(editorDraft.id, input);
      else await onCreate(input);
      resetTo('manage');
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : 'Failed to save quick action');
    } finally {
      setSaving(false);
    }
  };

  const runAction = async () => {
    if (!selectedAction || !formModel?.canRun || (productionRisk && !productionConfirmed)) return;
    setSubmitting(true);
    setLocalError(null);
    try {
      await onRun(selectedAction.id, parameterValues);
      setParameterValues({});
      onClose();
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : 'Failed to run quick action');
    } finally {
      setSubmitting(false);
    }
  };

  const deleteAction = async (action: QuickActionView) => {
    if (!window.confirm(`Delete Quick Action “${action.name}”?`)) return;
    setLocalError(null);
    try {
      await onDelete(action.id);
    } catch (caught: unknown) {
      setLocalError(caught instanceof Error ? caught.message : 'Failed to delete quick action');
    }
  };

  const title = mode === 'editor'
    ? (editorDraft.id ? 'Edit Quick Action' : 'Add Quick Action')
    : mode === 'run'
      ? `Run ${selectedAction?.name ?? 'Quick Action'}`
      : mode === 'manage'
        ? 'Manage Quick Actions'
        : 'Quick Actions';

  return (
    <DialogSkeleton title={title} onClose={onClose} width="48rem" className="kv2-dialog--quick-actions">
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

      {mode === 'launcher' && (
        <div className="kv2-quick-actions-shell">
          <div className="kv2-actions-split">
            <button type="button" className="kv2-btn kv2-btn--outline kv2-action-cancel" onClick={onClose}>Close</button>
            <div className="kv2-actions-primary">
              <button type="button" className="kv2-btn kv2-btn--outline" onClick={() => resetTo('manage')}>Manage</button>
              <button type="button" className="kv2-btn kv2-btn--primary" onClick={() => openEditor()}>Add Action</button>
            </div>
          </div>
          {loading && actions.length === 0 ? (
            <div className="loading-spinner" role="status" aria-label="Loading quick actions" />
          ) : actions.length === 0 ? (
            <div className="kv2-quick-actions-empty">No Quick Actions yet. Add one to start.</div>
          ) : (
            <div className="kv2-quick-action-list">
              {actions.map((action) => {
                const disabled = !action.enabled || !action.available || runningActionIds.includes(action.id);
                return (
                  <button
                    key={action.id}
                    type="button"
                    className="kv2-quick-action-item"
                    onClick={() => openRun(action)}
                    disabled={disabled}
                    aria-label={`Run ${action.name}`}
                  >
                    <span className="kv2-quick-action-item-main">
                      <span className="kv2-quick-action-item-title">{action.pinned ? '★ ' : ''}{action.name}</span>
                      <span className="kv2-quick-action-item-description">{action.description || 'No description'}</span>
                    </span>
                    <span className="kv2-quick-action-item-meta">
                      <span className="kv2-badge kv2-badge--accent">{action.type}</span>
                      {!action.enabled && <span>Disabled</span>}
                      {!action.available && <span>{action.unavailableReason}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {mode === 'manage' && (
        <div className="kv2-quick-actions-shell">
          <div className="kv2-actions-split">
            <button type="button" className="kv2-btn kv2-btn--outline kv2-action-cancel" onClick={() => resetTo('launcher')}>Back</button>
            <button type="button" className="kv2-btn kv2-btn--primary" onClick={() => openEditor()}>Add Action</button>
          </div>
          <div className="kv2-quick-action-list" role="list">
            {actions.map((action) => (
              <article key={action.id} className="kv2-quick-action-item kv2-quick-action-item--manage" role="listitem">
                <span className="kv2-quick-action-item-main">
                  <span className="kv2-quick-action-item-title">{action.name}</span>
                  <span className="kv2-quick-action-item-description">
                    {action.type}{action.available ? '' : ` · ${action.unavailableReason}`}
                  </span>
                </span>
                <span className="kv2-quick-action-manage-actions">
                  <button type="button" className="kv2-btn kv2-btn--small kv2-btn--outline" onClick={() => openEditor(action)}>Edit</button>
                  <button type="button" className="kv2-btn kv2-btn--small kv2-btn--subtle-danger" onClick={() => { void deleteAction(action); }}>Delete</button>
                </span>
              </article>
            ))}
          </div>
        </div>
      )}

      {mode === 'run' && selectedAction && formModel && (
        <div className="kv2-quick-actions-shell">
          <ActionSummary action={selectedAction} />
          {selectedAction.description && <p className="kv2-quick-action-copy">{selectedAction.description}</p>}
          <div className="kv2-quick-action-fields">
            {selectedAction.parameterDefinitions.map((definition) => {
              const id = `quick-action-param-${definition.key}`;
              const value = parameterValues[definition.key];
              const actualKey = selectedAction.type === 'script'
                ? parameterEnvironmentKey(definition.key)
                : `{{${definition.key}}}`;
              return (
                <div className="kv2-form-group" key={definition.key}>
                  <label className="kv2-label" htmlFor={id}>
                    {definition.label}{definition.required ? ' *' : ''}
                  </label>
                  {definition.type === 'boolean' ? (
                    <label className="kv2-quick-action-checkbox">
                      <input
                        id={id}
                        type="checkbox"
                        checked={value === true}
                        onChange={(event) => setParameterValues((current) => ({
                          ...current,
                          [definition.key]: event.target.checked,
                        }))}
                      />
                      <span>{value === true ? 'true' : 'false'}</span>
                    </label>
                  ) : definition.type === 'select' ? (
                    <select
                      id={id}
                      className="kv2-select"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(event) => setParameterValues((current) => ({
                        ...current,
                        [definition.key]: event.target.value,
                      }))}
                    >
                      <option value="">Select…</option>
                      {definition.options.map((option) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : (
                    <input
                      id={id}
                      className={`kv2-input${formModel.errors[definition.key] ? ' kv2-input--error' : ''}`}
                      type={definition.type === 'secret' ? 'password' : definition.type === 'number' ? 'number' : 'text'}
                      value={typeof value === 'string' || typeof value === 'number' ? value : ''}
                      autoComplete={definition.type === 'secret' ? 'new-password' : undefined}
                      onChange={(event) => {
                        const nextValue = definition.type === 'number'
                          ? (event.target.value === '' ? undefined : Number(event.target.value))
                          : event.target.value;
                        setParameterValues((current) => {
                          if (nextValue === undefined) {
                            const { [definition.key]: _removed, ...rest } = current;
                            return rest;
                          }
                          return { ...current, [definition.key]: nextValue };
                        });
                      }}
                    />
                  )}
                  <div className="kv2-quick-action-field-meta">
                    Delivered as <code>{actualKey}</code>
                    {formModel.errors[definition.key] && <span role="alert"> · {formModel.errors[definition.key]}</span>}
                  </div>
                </div>
              );
            })}
          </div>
          {productionRisk && (
            <label className="kv2-quick-action-confirmation">
              <input
                type="checkbox"
                checked={productionConfirmed}
                onChange={(event) => setProductionConfirmed(event.target.checked)}
              />
              <span>I confirm this production or elevated-permission action.</span>
            </label>
          )}
          <div className="kv2-actions-split">
            <button type="button" className="kv2-btn kv2-btn--outline kv2-action-cancel" onClick={() => resetTo('launcher')}>Back</button>
            <button
              type="button"
              className="kv2-btn kv2-btn--primary"
              disabled={!formModel.canRun || submitting || runningActionIds.includes(selectedAction.id) || (productionRisk && !productionConfirmed)}
              onClick={() => { void runAction(); }}
            >
              {submitting ? 'Starting…' : 'Run Action'}
            </button>
          </div>
        </div>
      )}

      {mode === 'editor' && (
        <div className="kv2-quick-actions-shell">
          <div className="kv2-quick-action-editor-grid">
            <div className="kv2-form-group">
              <label className="kv2-label" htmlFor="quick-action-type">Action type</label>
              <select
                id="quick-action-type"
                className="kv2-select"
                value={editorDraft.type}
                disabled={Boolean(editorDraft.id)}
                onChange={(event) => setEditorDraft((current) => ({
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
              <input id="quick-action-name" className="kv2-input" value={editorDraft.name} onChange={(event) => setEditorDraft((current) => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="kv2-form-group kv2-quick-action-editor-wide">
              <label className="kv2-label" htmlFor="quick-action-description">Description</label>
              <textarea id="quick-action-description" className="kv2-textarea" value={editorDraft.description} onChange={(event) => setEditorDraft((current) => ({ ...current, description: event.target.value }))} />
            </div>
            {editorDraft.type === 'prompt' ? (
              <>
                <div className="kv2-form-group kv2-quick-action-editor-wide">
                  <label className="kv2-label" htmlFor="quick-action-card-title">Card title template</label>
                  <input id="quick-action-card-title" className="kv2-input" value={editorDraft.cardTitleTemplate} onChange={(event) => setEditorDraft((current) => ({ ...current, cardTitleTemplate: event.target.value }))} />
                </div>
                <div className="kv2-form-group kv2-quick-action-editor-wide">
                  <label className="kv2-label" htmlFor="quick-action-prompt">Prompt template</label>
                  <textarea id="quick-action-prompt" className="kv2-textarea" value={editorDraft.promptTemplate} onChange={(event) => setEditorDraft((current) => ({ ...current, promptTemplate: event.target.value }))} />
                </div>
                <div className="kv2-form-group kv2-quick-action-editor-wide">
                  <label className="kv2-label" htmlFor="quick-action-project-dir">Project directory *</label>
                  <DirectoryPicker
                    id="quick-action-project-dir"
                    value={editorDraft.projectDir}
                    onChange={(projectDir) => setEditorDraft((current) => ({ ...current, projectDir }))}
                    commitLabel="Use directory"
                    onCommit={(projectDir) => setEditorDraft((current) => ({ ...current, projectDir }))}
                  />
                  <span className="kv2-quick-action-field-meta">Confirm the directory to continue; recent directories are shared with task creation.</span>
                </div>
                <RuntimeModelFields
                  runtime={editorDraft.agentRuntime}
                  model={editorDraft.model}
                  orderedRuntimes={orderedRuntimes}
                  displayedModels={displayedModels}
                  runtimeInputId="quick-action-runtime"
                  modelInputId="quick-action-model"
                  className="kv2-quick-action-editor-wide"
                  selectorVariant="cards"
                  onRuntimeChange={(agentRuntime) => setEditorDraft((current) => ({
                    ...current,
                    agentRuntime,
                    model: getDefaultModelForRuntime(agentRuntime, current.agentType || 'sisyphus'),
                    command: '',
                    commandArguments: '',
                  }))}
                  onModelChange={(model) => setEditorDraft((current) => ({ ...current, model }))}
                />
                {editorDraft.agentRuntime === 'opencode' && (
                  <div className="kv2-create-field kv2-quick-action-editor-wide">
                    <div className="kv2-create-label">Agent</div>
                    <div className="kv2-create-agent-row">
                      {AGENT_CONFIGS.map((agent) => (
                        <button
                          key={agent.key}
                          type="button"
                          className={`kv2-create-agent-chip${editorDraft.agentType === agent.key ? ' kv2-create-agent-chip--active' : ''}`}
                          onClick={() => setEditorDraft((current) => ({
                            ...current,
                            agentType: agent.key,
                            model: getDefaultModelForRuntime('opencode', agent.key),
                          }))}
                        >
                          {agent.emoji} {agent.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {editorDraft.agentRuntime === 'codex' && (
                  <div className="kv2-create-field kv2-quick-action-editor-wide">
                    <div className="kv2-create-label">Codex Options</div>
                    <div className="kv2-create-input-row">
                      <select className="kv2-create-select" aria-label="Codex reasoning effort" value={editorDraft.codexReasoningEffort} onChange={(event) => setEditorDraft((current) => ({ ...current, codexReasoningEffort: event.target.value as EditorDraft['codexReasoningEffort'] }))}>
                        <option value="low">Reasoning: low</option><option value="medium">Reasoning: medium</option><option value="high">Reasoning: high</option><option value="xhigh">Reasoning: xhigh</option>
                      </select>
                      <select className="kv2-create-select" aria-label="Codex sandbox" value={editorDraft.codexSandbox} onChange={(event) => setEditorDraft((current) => ({ ...current, codexSandbox: event.target.value as EditorDraft['codexSandbox'] }))}>
                        <option value="read-only">Sandbox: read-only</option><option value="workspace-write">Sandbox: workspace-write</option><option value="danger-full-access">Sandbox: danger-full-access</option>
                      </select>
                    </div>
                    <label className="kv2-create-radio-label">
                      <input type="checkbox" checked={editorDraft.codexSkipGitRepoCheck} onChange={(event) => setEditorDraft((current) => ({ ...current, codexSkipGitRepoCheck: event.target.checked }))} />
                      <div><div className="kv2-create-radio-title">Skip git repo check</div></div>
                    </label>
                    <label className="kv2-create-radio-label">
                      <input type="checkbox" checked={editorDraft.codexBypassApprovalsAndSandbox} onChange={(event) => setEditorDraft((current) => ({ ...current, codexBypassApprovalsAndSandbox: event.target.checked }))} />
                      <div><div className="kv2-create-radio-title">Bypass approvals and sandbox</div></div>
                    </label>
                  </div>
                )}
                {editorDraft.agentRuntime === 'claude' && (
                  <div className="kv2-create-field kv2-quick-action-editor-wide">
                    <div className="kv2-create-label">Claude Permissions</div>
                    <select className="kv2-create-select" aria-label="Claude permission mode" value={editorDraft.claudePermissionMode} onChange={(event) => setEditorDraft((current) => ({ ...current, claudePermissionMode: event.target.value as EditorDraft['claudePermissionMode'] }))} disabled={editorDraft.claudeDangerouslySkipPermissions}>
                      <option value="acceptEdits">acceptEdits</option><option value="plan">plan</option><option value="dontAsk">dontAsk</option><option value="bypassPermissions">bypassPermissions</option>
                    </select>
                    <label className="kv2-create-radio-label">
                      <input type="checkbox" checked={editorDraft.claudeDangerouslySkipPermissions} onChange={(event) => setEditorDraft((current) => ({ ...current, claudeDangerouslySkipPermissions: event.target.checked }))} />
                      <div><div className="kv2-create-radio-title">Dangerously skip permissions</div></div>
                    </label>
                  </div>
                )}
                <div className="kv2-create-field kv2-quick-action-editor-wide">
                  <div className="kv2-create-label">Command</div>
                  <div className="kv2-session-helper">Optional. Uses the same runtime-aware command picker as task creation.</div>
                  <CommandPicker
                    id="quick-action-command"
                    runtime={editorDraft.agentRuntime}
                    value={editorDraft.command}
                    commands={filteredCommands}
                    onChange={(command) => setEditorDraft((current) => ({
                      ...current,
                      command,
                      commandArguments: command ? current.commandArguments : '',
                    }))}
                  />
                  {editorDraft.command && (
                    <div className="kv2-create-field kv2-create-command-arguments">
                      <label className="kv2-create-label" htmlFor="quick-action-command-arguments">Command parameters template</label>
                      <input
                        id="quick-action-command-arguments"
                        className="kv2-create-input"
                        value={editorDraft.commandArguments}
                        onChange={(event) => setEditorDraft((current) => ({ ...current, commandArguments: event.target.value }))}
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
                  <select id="quick-action-script" className="kv2-select" value={editorDraft.scriptId} onChange={(event) => setEditorDraft((current) => ({ ...current, scriptId: event.target.value }))}>
                    <option value="">Select a script…</option>
                    {scripts.map((script) => <option key={script.id} value={script.id}>{script.name}</option>)}
                  </select>
                </div>
                <div className="kv2-form-group kv2-quick-action-editor-wide">
                  <label className="kv2-label" htmlFor="quick-action-script-dir">Project directory override</label>
                  <DirectoryPicker
                    id="quick-action-script-dir"
                    value={editorDraft.projectDir}
                    onChange={(projectDir) => setEditorDraft((current) => ({ ...current, projectDir }))}
                    commitLabel="Use override"
                    onCommit={(projectDir) => setEditorDraft((current) => ({ ...current, projectDir }))}
                  />
                  <span className="kv2-quick-action-field-meta">Leave empty to use the Script directory.</span>
                </div>
              </>
            )}
            <label className="kv2-quick-action-checkbox"><input type="checkbox" checked={editorDraft.enabled} onChange={(event) => setEditorDraft((current) => ({ ...current, enabled: event.target.checked }))} /><span>Enabled</span></label>
            <label className="kv2-quick-action-checkbox"><input type="checkbox" checked={editorDraft.pinned} onChange={(event) => setEditorDraft((current) => ({ ...current, pinned: event.target.checked }))} /><span>Pinned</span></label>
          </div>

          <section className="kv2-quick-action-parameters" aria-labelledby="quick-action-parameters-heading">
            <div className="kv2-quick-action-section-heading">
              <div>
                <h3 id="quick-action-parameters-heading" className="kv2-panel-heading">Parameters</h3>
                <p className="kv2-panel-subtitle">Use the same key inside <code>{'{{key}}'}</code>; Script actions receive <code>AK_PARAM_KEY</code>.</p>
              </div>
              <button type="button" className="kv2-btn kv2-btn--small kv2-btn--outline" onClick={() => setEditorDraft((current) => ({ ...current, parameters: [...current.parameters, { ...EMPTY_PARAMETER }] }))}>Add Parameter</button>
            </div>
            {editorDraft.parameters.map((parameter, index) => (
              <div className="kv2-quick-action-parameter-row" key={`${index}-${parameter.key}`}>
                <input aria-label={`Parameter ${index + 1} key`} className="kv2-input" placeholder="key" value={parameter.key} onChange={(event) => updateParameterDraft(index, { key: event.target.value })} />
                <input aria-label={`Parameter ${index + 1} label`} className="kv2-input" placeholder="Label" value={parameter.label} onChange={(event) => updateParameterDraft(index, { label: event.target.value })} />
                <select aria-label={`Parameter ${index + 1} type`} className="kv2-select" value={parameter.type} onChange={(event) => updateParameterDraft(index, { type: event.target.value as ParameterDraft['type'], defaultValue: '', options: '' })}>
                  <option value="string">string</option><option value="number">number</option><option value="boolean">boolean</option><option value="select">select</option><option value="secret">secret</option>
                </select>
                {parameter.type === 'select' ? (
                  <input aria-label={`Parameter ${index + 1} options`} className="kv2-input" placeholder="one, two" value={parameter.options} onChange={(event) => updateParameterDraft(index, { options: event.target.value })} />
                ) : parameter.type === 'boolean' ? (
                  <select aria-label={`Parameter ${index + 1} default`} className="kv2-select" value={parameter.defaultValue} onChange={(event) => updateParameterDraft(index, { defaultValue: event.target.value })}><option value="">No default</option><option value="true">true</option><option value="false">false</option></select>
                ) : parameter.type === 'secret' ? <span className="kv2-quick-action-no-default">No default</span> : (
                  <input aria-label={`Parameter ${index + 1} default`} className="kv2-input" placeholder="Default" value={parameter.defaultValue} onChange={(event) => updateParameterDraft(index, { defaultValue: event.target.value })} />
                )}
                <label className="kv2-quick-action-checkbox"><input type="checkbox" checked={parameter.required} onChange={(event) => updateParameterDraft(index, { required: event.target.checked })} /><span>Required</span></label>
                <button type="button" className="kv2-btn kv2-btn--small kv2-btn--subtle-danger" aria-label={`Remove parameter ${index + 1}`} onClick={() => setEditorDraft((current) => ({ ...current, parameters: current.parameters.filter((_value, parameterIndex) => parameterIndex !== index) }))}>Remove</button>
              </div>
            ))}
          </section>

          <div className="kv2-actions-split">
            <button type="button" className="kv2-btn kv2-btn--outline kv2-action-cancel" onClick={() => resetTo('manage')}>Cancel</button>
            <button type="button" className="kv2-btn kv2-btn--primary" disabled={saving} onClick={() => { void saveAction(); }}>{saving ? 'Saving…' : 'Save Action'}</button>
          </div>
        </div>
      )}
    </DialogSkeleton>
  );
};
