import type {
  AgentRuntime,
  CreateQuickActionInput,
  QuickActionParameterDefinition,
  QuickActionView,
  UpdateQuickActionInput,
} from '../../../../src/core/types';
import {
  QUICK_ACTION_ICON_PALETTE,
  normalizeQuickActionIcon,
} from '../../../../src/core/types';
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from '../../../../src/core/runtime-config';
import { parameterEnvironmentKey } from '../../../../src/core/execution-environment';
import type { CommandId } from '../../constants/commands';

export interface QuickActionParameterDraft {
  readonly rowId: string;
  key: string;
  label: string;
  type: QuickActionParameterDefinition['type'];
  required: boolean;
  defaultValue: string;
  options: string;
}

export interface QuickActionEditorDraft {
  id?: string;
  icon: string;
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
  parameters: QuickActionParameterDraft[];
}

export interface QuickActionEditorDefaults {
  runtime?: AgentRuntime;
  model?: string;
  icon?: string;
}

export interface QuickActionEditorTouchedState {
  runtime: boolean;
  model: boolean;
}

export interface QuickActionIconChoice {
  icon: string;
  selected: boolean;
  used: boolean;
}

let nextParameterDraftId = 0;

export function makeQuickActionParameterDraft(): QuickActionParameterDraft {
  nextParameterDraftId += 1;
  return {
    rowId: `quick-action-parameter-${nextParameterDraftId}`,
    key: '',
    label: '',
    type: 'string',
    required: false,
    defaultValue: '',
    options: '',
  };
}

function parameterDraftFromDefinition(
  definition: QuickActionParameterDefinition,
): QuickActionParameterDraft {
  return {
    ...makeQuickActionParameterDraft(),
    key: definition.key,
    label: definition.label,
    type: definition.type,
    required: definition.required,
    defaultValue: definition.defaultValue === undefined ? '' : String(definition.defaultValue),
    options: definition.type === 'select' ? definition.options.join(', ') : '',
  };
}

export function isQuickActionIconUsed(
  actions: readonly QuickActionView[],
  icon: string,
  editingActionId?: string,
): boolean {
  return actions.some((action) => action.id !== editingActionId && action.icon === icon);
}

export function getFirstAvailableQuickActionIcon(
  actions: readonly QuickActionView[],
  editingActionId?: string,
): string {
  return QUICK_ACTION_ICON_PALETTE.find((icon) => (
    !isQuickActionIconUsed(actions, icon, editingActionId)
  )) ?? '';
}

export function getQuickActionIconChoices(
  actions: readonly QuickActionView[],
  selectedIcon: string,
  editingActionId?: string,
): QuickActionIconChoice[] {
  return QUICK_ACTION_ICON_PALETTE.map((icon) => ({
    icon,
    selected: icon === selectedIcon,
    used: isQuickActionIconUsed(actions, icon, editingActionId),
  }));
}

export function makeQuickActionEditorDraft(
  action?: QuickActionView,
  defaults: QuickActionEditorDefaults = {},
): QuickActionEditorDraft {
  return {
    id: action?.id,
    icon: action?.icon ?? defaults.icon ?? '',
    type: action?.type ?? 'prompt',
    name: action?.name ?? '',
    description: action?.description ?? '',
    enabled: action?.enabled ?? true,
    pinned: action?.pinned ?? false,
    order: action?.order ?? 0,
    projectDir: action?.projectDir ?? '',
    cardTitleTemplate: action?.type === 'prompt' ? action.cardTitleTemplate : '',
    promptTemplate: action?.type === 'prompt' ? action.promptTemplate : '',
    agentRuntime: action?.type === 'prompt'
      ? action.agentRuntime
      : (defaults.runtime ?? 'opencode'),
    model: action?.type === 'prompt' ? (action.model ?? '') : (defaults.model ?? ''),
    agentType: action?.type === 'prompt' ? (action.agentType ?? '') : 'sisyphus',
    command: action?.type === 'prompt' ? (action.command ?? '') : '',
    commandArguments: action?.type === 'prompt' ? (action.argumentsTemplate ?? '') : '',
    codexReasoningEffort: action?.type === 'prompt'
      ? (action.codexOptions?.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT)
      : DEFAULT_CODEX_REASONING_EFFORT,
    codexSandbox: action?.type === 'prompt'
      ? (action.codexOptions?.sandbox ?? DEFAULT_CODEX_SANDBOX)
      : DEFAULT_CODEX_SANDBOX,
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

/**
 * Applies asynchronously arriving runtime/model defaults only to untouched new
 * Prompt drafts. Existing actions and Script drafts are intentionally inert.
 */
export function applyQuickActionEditorDefaults(
  draft: QuickActionEditorDraft,
  preferredRuntime: AgentRuntime | undefined,
  touched: QuickActionEditorTouchedState,
  getDefaultModelForRuntime: (runtime: AgentRuntime, agentType?: string) => string,
): QuickActionEditorDraft {
  if (draft.id || draft.type !== 'prompt') return draft;

  const agentRuntime = touched.runtime
    ? draft.agentRuntime
    : (preferredRuntime ?? 'opencode');
  const model = touched.model
    ? draft.model
    : getDefaultModelForRuntime(agentRuntime, draft.agentType || 'sisyphus');

  if (agentRuntime === draft.agentRuntime && model === draft.model) return draft;
  return { ...draft, agentRuntime, model };
}

function parseParameterDrafts(
  drafts: readonly QuickActionParameterDraft[],
): QuickActionParameterDefinition[] {
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

export function buildQuickActionInput(
  draft: QuickActionEditorDraft,
): CreateQuickActionInput {
  const icon = normalizeQuickActionIcon(draft.icon);
  const name = draft.name.trim();
  if (!name) throw new Error('Action name is required');
  const parameterDefinitions = parseParameterDrafts(draft.parameters);
  const common = {
    icon,
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

export function buildQuickActionUpdateInput(
  draft: QuickActionEditorDraft,
): UpdateQuickActionInput {
  return buildQuickActionInput(draft);
}
