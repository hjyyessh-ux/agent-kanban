import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { nanoid } from 'nanoid';
import type { ScriptStore } from './script-store';
import type {
  AgentRuntime,
  ClaudeOptions,
  CodexOptions,
  CreateQuickActionInput,
  QuickAction,
  QuickActionParameterDefinition,
  QuickActionParameterSnapshot,
  QuickActionParameterValue,
  QuickActionStoreState,
  QuickActionView,
  PromptQuickAction,
  ScriptQuickAction,
  UpdateQuickActionInput,
} from './types';
import { resolveDir } from './data-dir';
import { FileLock } from './filelock';
import { parameterEnvironmentKey } from './execution-environment';

type UnknownRecord = Record<string, unknown>;
type QuickActionIdentityKeys = 'id' | 'createdAt' | 'updatedAt';
type QuickActionDraft<T extends QuickAction = QuickAction> = T extends QuickAction
  ? Omit<T, QuickActionIdentityKeys>
  : never;

const PARAMETER_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PARAMETER_TYPES = new Set(['string', 'number', 'boolean', 'select', 'secret']);
const AGENT_RUNTIMES = new Set<AgentRuntime>(['opencode', 'codex', 'claude']);
const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CLAUDE_PERMISSION_MODES = new Set(['acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']);

const COMMON_INPUT_KEYS = [
  'type',
  'name',
  'description',
  'enabled',
  'pinned',
  'order',
  'parameterDefinitions',
];
const PROMPT_INPUT_KEYS = new Set([
  ...COMMON_INPUT_KEYS,
  'cardTitleTemplate',
  'promptTemplate',
  'projectDir',
  'agentRuntime',
  'model',
  'agentType',
  'command',
  'argumentsTemplate',
  'codexOptions',
  'claudeOptions',
]);
const SCRIPT_INPUT_KEYS = new Set([
  ...COMMON_INPUT_KEYS,
  'scriptId',
  'projectDir',
]);
const PARAMETER_KEYS = new Set([
  'key',
  'label',
  'type',
  'required',
  'defaultValue',
  'options',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function assertAllowedKeys(record: UnknownRecord, allowed: ReadonlySet<string>, label: string): void {
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) {
    throw new Error(`${label} contains unsupported field: ${unknownKey}`);
  }
}

function readRequiredString(record: UnknownRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(record: UnknownRecord, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function parseCodexOptions(value: unknown): CodexOptions | undefined {
  if (value === undefined) return undefined;
  const record = assertRecord(value, 'quick action codexOptions');
  assertAllowedKeys(
    record,
    new Set(['reasoningEffort', 'sandbox', 'skipGitRepoCheck', 'bypassApprovalsAndSandbox']),
    'quick action codexOptions',
  );
  if (
    record.reasoningEffort !== undefined
    && (typeof record.reasoningEffort !== 'string' || !CODEX_REASONING_EFFORTS.has(record.reasoningEffort))
  ) {
    throw new Error('quick action codexOptions.reasoningEffort is invalid');
  }
  if (
    record.sandbox !== undefined
    && (typeof record.sandbox !== 'string' || !CODEX_SANDBOX_MODES.has(record.sandbox))
  ) {
    throw new Error('quick action codexOptions.sandbox is invalid');
  }
  if (record.skipGitRepoCheck !== undefined && typeof record.skipGitRepoCheck !== 'boolean') {
    throw new Error('quick action codexOptions.skipGitRepoCheck must be a boolean');
  }
  if (
    record.bypassApprovalsAndSandbox !== undefined
    && typeof record.bypassApprovalsAndSandbox !== 'boolean'
  ) {
    throw new Error('quick action codexOptions.bypassApprovalsAndSandbox must be a boolean');
  }
  return {
    reasoningEffort: record.reasoningEffort as CodexOptions['reasoningEffort'],
    sandbox: record.sandbox as CodexOptions['sandbox'],
    skipGitRepoCheck: record.skipGitRepoCheck as boolean | undefined,
    bypassApprovalsAndSandbox: record.bypassApprovalsAndSandbox as boolean | undefined,
  };
}

function parseClaudeOptions(value: unknown): ClaudeOptions | undefined {
  if (value === undefined) return undefined;
  const record = assertRecord(value, 'quick action claudeOptions');
  assertAllowedKeys(
    record,
    new Set(['permissionMode', 'dangerouslySkipPermissions']),
    'quick action claudeOptions',
  );
  if (
    record.permissionMode !== undefined
    && (typeof record.permissionMode !== 'string' || !CLAUDE_PERMISSION_MODES.has(record.permissionMode))
  ) {
    throw new Error('quick action claudeOptions.permissionMode is invalid');
  }
  if (
    record.dangerouslySkipPermissions !== undefined
    && typeof record.dangerouslySkipPermissions !== 'boolean'
  ) {
    throw new Error('quick action claudeOptions.dangerouslySkipPermissions must be a boolean');
  }
  return {
    permissionMode: record.permissionMode as ClaudeOptions['permissionMode'],
    dangerouslySkipPermissions: record.dangerouslySkipPermissions as boolean | undefined,
  };
}

function parseParameterDefinitions(value: unknown): QuickActionParameterDefinition[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error('quick action parameterDefinitions must be an array');
  }

  const seenKeys = new Set<string>();
  const seenEnvironmentKeys = new Map<string, string>();
  return value.map((rawDefinition, index) => {
    const label = `quick action parameterDefinitions[${index}]`;
    const definition = assertRecord(rawDefinition, label);
    assertAllowedKeys(definition, PARAMETER_KEYS, label);
    const key = readRequiredString(definition, 'key', label);
    if (!PARAMETER_KEY_PATTERN.test(key)) {
      throw new Error(`${label}.key must match ${PARAMETER_KEY_PATTERN.source}`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`quick action parameterDefinitions contains duplicate key: ${key}`);
    }
    seenKeys.add(key);
    const environmentKey = parameterEnvironmentKey(key);
    const collidingKey = seenEnvironmentKeys.get(environmentKey);
    if (collidingKey) {
      throw new Error(
        `quick action parameterDefinitions contains environment collision: ${collidingKey}, ${key}`,
      );
    }
    seenEnvironmentKeys.set(environmentKey, key);

    const displayLabel = readRequiredString(definition, 'label', label);
    if (typeof definition.type !== 'string' || !PARAMETER_TYPES.has(definition.type)) {
      throw new Error(`${label}.type is invalid`);
    }
    if (typeof definition.required !== 'boolean') {
      throw new Error(`${label}.required must be a boolean`);
    }
    const hasDefault = Object.prototype.hasOwnProperty.call(definition, 'defaultValue');
    const hasOptions = Object.prototype.hasOwnProperty.call(definition, 'options');

    switch (definition.type) {
      case 'string':
        if (hasOptions) throw new Error(`${label}.options is only supported for select parameters`);
        if (hasDefault && typeof definition.defaultValue !== 'string') {
          throw new Error(`${label}.defaultValue must be a string`);
        }
        return {
          key,
          label: displayLabel,
          type: 'string',
          required: definition.required,
          ...(hasDefault ? { defaultValue: definition.defaultValue as string } : {}),
        };
      case 'number':
        if (hasOptions) throw new Error(`${label}.options is only supported for select parameters`);
        if (
          hasDefault
          && (typeof definition.defaultValue !== 'number' || !Number.isFinite(definition.defaultValue))
        ) {
          throw new Error(`${label}.defaultValue must be a finite number`);
        }
        return {
          key,
          label: displayLabel,
          type: 'number',
          required: definition.required,
          ...(hasDefault ? { defaultValue: definition.defaultValue as number } : {}),
        };
      case 'boolean':
        if (hasOptions) throw new Error(`${label}.options is only supported for select parameters`);
        if (hasDefault && typeof definition.defaultValue !== 'boolean') {
          throw new Error(`${label}.defaultValue must be a boolean`);
        }
        return {
          key,
          label: displayLabel,
          type: 'boolean',
          required: definition.required,
          ...(hasDefault ? { defaultValue: definition.defaultValue as boolean } : {}),
        };
      case 'select': {
        if (!Array.isArray(definition.options) || definition.options.length === 0) {
          throw new Error(`${label}.options must be a non-empty array`);
        }
        if (
          definition.options.some((option) => typeof option !== 'string' || option.trim().length === 0)
        ) {
          throw new Error(`${label}.options must contain non-empty strings`);
        }
        const options = definition.options as string[];
        if (new Set(options).size !== options.length) {
          throw new Error(`${label}.options must not contain duplicates`);
        }
        if (
          hasDefault
          && (typeof definition.defaultValue !== 'string' || !options.includes(definition.defaultValue))
        ) {
          throw new Error(`${label}.defaultValue must match one of its options`);
        }
        return {
          key,
          label: displayLabel,
          type: 'select',
          required: definition.required,
          options,
          ...(hasDefault ? { defaultValue: definition.defaultValue as string } : {}),
        };
      }
      case 'secret':
        if (hasDefault) {
          throw new Error(`${label}.defaultValue is forbidden for secret parameters`);
        }
        if (hasOptions) throw new Error(`${label}.options is only supported for select parameters`);
        return {
          key,
          label: displayLabel,
          type: 'secret',
          required: definition.required,
        };
      default:
        throw new Error(`${label}.type is invalid`);
    }
  });
}

function parseActionDraft(value: unknown, fallbackOrder: number): QuickActionDraft {
  const input = assertRecord(value, 'quick action');
  if (input.type !== 'prompt' && input.type !== 'script') {
    throw new Error('quick action type must be prompt or script');
  }
  const allowedKeys = input.type === 'prompt' ? PROMPT_INPUT_KEYS : SCRIPT_INPUT_KEYS;
  assertAllowedKeys(input, allowedKeys, 'quick action');

  const name = readRequiredString(input, 'name', 'quick action');
  if (typeof input.description !== 'string') {
    throw new Error('quick action.description must be a string');
  }
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') {
    throw new Error('quick action.enabled must be a boolean');
  }
  const pinned = input.pinned === undefined ? false : input.pinned;
  if (typeof pinned !== 'boolean') {
    throw new Error('quick action.pinned must be a boolean');
  }
  const order = input.order === undefined ? fallbackOrder : input.order;
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0) {
    throw new Error('quick action.order must be a non-negative integer');
  }
  const parameterDefinitions = parseParameterDefinitions(input.parameterDefinitions);

  if (input.type === 'script') {
    return {
      type: 'script',
      name,
      description: input.description,
      enabled,
      pinned,
      order,
      parameterDefinitions,
      scriptId: readRequiredString(input, 'scriptId', 'quick action'),
      projectDir: readOptionalString(input, 'projectDir', 'quick action'),
    };
  }

  if (typeof input.agentRuntime !== 'string' || !AGENT_RUNTIMES.has(input.agentRuntime as AgentRuntime)) {
    throw new Error('quick action.agentRuntime is invalid');
  }
  const agentRuntime = input.agentRuntime as AgentRuntime;
  const command = readOptionalString(input, 'command', 'quick action');
  const argumentsTemplate = readOptionalString(input, 'argumentsTemplate', 'quick action');
  if (argumentsTemplate && !command) {
    throw new Error('quick action.argumentsTemplate requires command');
  }
  const codexOptions = parseCodexOptions(input.codexOptions);
  const claudeOptions = parseClaudeOptions(input.claudeOptions);
  if (agentRuntime !== 'codex' && codexOptions) {
    throw new Error('quick action.codexOptions requires agentRuntime codex');
  }
  if (agentRuntime !== 'claude' && claudeOptions) {
    throw new Error('quick action.claudeOptions requires agentRuntime claude');
  }

  return {
    type: 'prompt',
    name,
    description: input.description,
    enabled,
    pinned,
    order,
    parameterDefinitions,
    cardTitleTemplate: readRequiredString(input, 'cardTitleTemplate', 'quick action'),
    promptTemplate: readRequiredString(input, 'promptTemplate', 'quick action'),
    projectDir: readRequiredString(input, 'projectDir', 'quick action'),
    agentRuntime,
    model: readOptionalString(input, 'model', 'quick action'),
    agentType: readOptionalString(input, 'agentType', 'quick action'),
    command,
    argumentsTemplate,
    codexOptions,
    claudeOptions,
  };
}

function toInputRecord(action: QuickAction, patch: UnknownRecord): UnknownRecord {
  const patched = (key: string, current: unknown): unknown => (
    Object.prototype.hasOwnProperty.call(patch, key) ? patch[key] : current
  );
  const common = {
    type: action.type,
    name: patched('name', action.name),
    description: patched('description', action.description),
    enabled: patched('enabled', action.enabled),
    pinned: patched('pinned', action.pinned),
    order: patched('order', action.order),
    parameterDefinitions: patched('parameterDefinitions', action.parameterDefinitions),
  };

  if (action.type === 'script') {
    return {
      ...common,
      scriptId: patched('scriptId', action.scriptId),
      projectDir: patch.projectDir === null ? undefined : patched('projectDir', action.projectDir),
    };
  }

  return {
    ...common,
    cardTitleTemplate: patched('cardTitleTemplate', action.cardTitleTemplate),
    promptTemplate: patched('promptTemplate', action.promptTemplate),
    projectDir: patch.projectDir === null ? undefined : patched('projectDir', action.projectDir),
    agentRuntime: patched('agentRuntime', action.agentRuntime),
    model: patch.model === null ? undefined : patched('model', action.model),
    agentType: patch.agentType === null ? undefined : patched('agentType', action.agentType),
    command: patch.command === null ? undefined : patched('command', action.command),
    argumentsTemplate: patch.argumentsTemplate === null
      ? undefined
      : patched('argumentsTemplate', action.argumentsTemplate),
    codexOptions: patch.codexOptions === null ? undefined : patched('codexOptions', action.codexOptions),
    claudeOptions: patch.claudeOptions === null ? undefined : patched('claudeOptions', action.claudeOptions),
  };
}

function parsePersistedAction(value: unknown, index: number): QuickAction | null {
  if (!isRecord(value)) return null;
  try {
    const { id, createdAt, updatedAt, ...draft } = value;
    const parsed = parseActionDraft(draft, index);
    const now = new Date().toISOString();
    return {
      ...parsed,
      id: typeof id === 'string' && id.length > 0 ? id : nanoid(),
      createdAt: typeof createdAt === 'string' ? createdAt : now,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : now,
    } as QuickAction;
  } catch {
    return null;
  }
}

function sortActions(actions: QuickAction[]): QuickAction[] {
  return [...actions].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.order !== right.order) return left.order - right.order;
    const createdOrder = left.createdAt.localeCompare(right.createdAt);
    return createdOrder !== 0 ? createdOrder : left.id.localeCompare(right.id);
  });
}

function assertParameterValue(
  definition: QuickActionParameterDefinition,
  value: unknown,
): QuickActionParameterValue {
  if (definition.type === 'string' || definition.type === 'secret') {
    if (typeof value !== 'string') throw new Error(`Parameter ${definition.key} must be a string`);
    return value;
  }
  if (definition.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Parameter ${definition.key} must be a finite number`);
    }
    return value;
  }
  if (definition.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`Parameter ${definition.key} must be a boolean`);
    return value;
  }
  if (typeof value !== 'string' || !definition.options.includes(value)) {
    throw new Error(`Parameter ${definition.key} must match one of its options`);
  }
  return value;
}

export interface ResolvedQuickActionParameters {
  values: Record<string, QuickActionParameterValue>;
  snapshot: QuickActionParameterSnapshot;
}

export interface RenderedPromptQuickAction {
  title: string;
  prompt: string;
  arguments?: string;
  parameterSnapshot: QuickActionParameterSnapshot;
}

const TEMPLATE_PLACEHOLDER_PATTERN = /\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g;
const TEMPLATE_MARKER_PATTERN = /\{\{|\}\}/;

/**
 * Resolves supplied values and stored defaults against the saved definition.
 * Secret values remain available for rendering but are excluded from the card
 * provenance snapshot.
 */
export function resolveQuickActionParameters(
  action: Pick<QuickAction, 'parameterDefinitions'>,
  rawValues: unknown,
): ResolvedQuickActionParameters {
  const inputValues = assertRecord(rawValues, 'quick action parameterValues');
  const definitionsByKey = new Map(
    action.parameterDefinitions.map((definition) => [definition.key, definition]),
  );
  const unknownKey = Object.keys(inputValues).find((key) => !definitionsByKey.has(key));
  if (unknownKey) throw new Error(`Unknown quick action parameter: ${unknownKey}`);

  const values: Record<string, QuickActionParameterValue> = {};
  const snapshot: QuickActionParameterSnapshot = {};
  for (const definition of action.parameterDefinitions) {
    const provided = Object.prototype.hasOwnProperty.call(inputValues, definition.key);
    const rawValue = provided ? inputValues[definition.key] : definition.defaultValue;
    if (rawValue === undefined) {
      if (definition.required) throw new Error(`Missing required parameter: ${definition.key}`);
      continue;
    }
    if (
      definition.required
      && (definition.type === 'string' || definition.type === 'secret')
      && typeof rawValue === 'string'
      && rawValue.trim().length === 0
    ) {
      throw new Error(`Missing required parameter: ${definition.key}`);
    }
    const validated = assertParameterValue(definition, rawValue);
    values[definition.key] = validated;
    if (definition.type !== 'secret') snapshot[definition.key] = validated;
  }
  return { values, snapshot };
}

/**
 * Renders only exact `{{parameterKey}}` placeholders. Malformed, unknown, or
 * value-less placeholders are rejected before replacement, so rendered user
 * values containing braces are never interpreted a second time.
 */
export function renderQuickActionTemplate(
  template: string,
  values: Readonly<Record<string, QuickActionParameterValue>>,
): string {
  const withoutValidPlaceholders = template.replace(TEMPLATE_PLACEHOLDER_PATTERN, '');
  if (TEMPLATE_MARKER_PATTERN.test(withoutValidPlaceholders)) {
    throw new Error('Quick action template contains an invalid placeholder');
  }

  TEMPLATE_PLACEHOLDER_PATTERN.lastIndex = 0;
  const unresolved = Array.from(template.matchAll(TEMPLATE_PLACEHOLDER_PATTERN))
    .map((match) => match[1])
    .find((key) => !Object.prototype.hasOwnProperty.call(values, key));
  if (unresolved) {
    throw new Error(`Unresolved quick action placeholder: ${unresolved}`);
  }

  TEMPLATE_PLACEHOLDER_PATTERN.lastIndex = 0;
  return template.replace(TEMPLATE_PLACEHOLDER_PATTERN, (_placeholder, key: string) => (
    String(values[key])
  ));
}

export function renderPromptQuickAction(
  action: PromptQuickAction,
  rawValues: unknown,
): RenderedPromptQuickAction {
  const resolved = resolveQuickActionParameters(action, rawValues);
  const title = renderQuickActionTemplate(action.cardTitleTemplate, resolved.values);
  const prompt = renderQuickActionTemplate(action.promptTemplate, resolved.values);
  const renderedArguments = action.argumentsTemplate
    ? renderQuickActionTemplate(action.argumentsTemplate, resolved.values)
    : undefined;
  if (title.trim().length === 0) throw new Error('Rendered quick action card title is empty');
  if (prompt.trim().length === 0) throw new Error('Rendered quick action prompt is empty');
  if (renderedArguments !== undefined && renderedArguments.trim().length === 0) {
    throw new Error('Rendered quick action command arguments are empty');
  }
  return {
    title,
    prompt,
    ...(renderedArguments === undefined ? {} : { arguments: renderedArguments }),
    parameterSnapshot: resolved.snapshot,
  };
}

/**
 * Builds the immutable parameter portion of card provenance. Secret parameters
 * are validated for execution but deliberately omitted from the returned data.
 */
export function buildQuickActionParameterSnapshot(
  action: Pick<QuickAction, 'parameterDefinitions'>,
  rawValues: unknown,
): QuickActionParameterSnapshot {
  return resolveQuickActionParameters(action, rawValues).snapshot;
}

export class QuickActionStore {
  private readonly dataDir: string;
  private readonly actionsPath: string;
  private readonly tmpPath: string;
  private readonly fileLock: FileLock;
  private readonly scriptStore: ScriptStore;
  private lockPromise: Promise<void> = Promise.resolve();

  constructor(dataDir: string, scriptStore: ScriptStore) {
    this.dataDir = resolveDir(dataDir);
    this.actionsPath = join(this.dataDir, 'quick-actions.json');
    this.tmpPath = join(this.dataDir, '.quick-actions.json.tmp');
    this.fileLock = new FileLock(join(this.dataDir, '.quick-actions.json.lock'));
    this.scriptStore = scriptStore;
  }

  private async withDualLock<T>(fn: () => Promise<T>): Promise<T> {
    let release: () => void;
    const previous = this.lockPromise;
    this.lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.fileLock.withLock(fn);
    } finally {
      release!();
    }
  }

  private defaultState(): QuickActionStoreState {
    return {
      version: 1,
      entries: [],
      lastModified: new Date().toISOString(),
    };
  }

  async load(): Promise<QuickActionStoreState> {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.actionsPath)) return this.defaultState();

    try {
      const content = await Bun.file(this.actionsPath).text();
      if (content.trim().length === 0) return this.defaultState();
      const parsed: unknown = JSON.parse(content);
      const rawEntries = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.entries)
          ? parsed.entries
          : isRecord(parsed) && Array.isArray(parsed.actions)
            ? parsed.actions
            : [];
      const entries = rawEntries
        .map((entry, index) => parsePersistedAction(entry, index))
        .filter((entry): entry is QuickAction => entry !== null);
      const lastModified = isRecord(parsed) && typeof parsed.lastModified === 'string'
        ? parsed.lastModified
        : new Date().toISOString();
      return { version: 1, entries, lastModified };
    } catch {
      return this.defaultState();
    }
  }

  private async save(state: QuickActionStoreState): Promise<void> {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    await Bun.write(this.tmpPath, JSON.stringify(state, null, 2));
    renameSync(this.tmpPath, this.actionsPath);
  }

  private async requireScript(scriptId: string): Promise<void> {
    if (!await this.scriptStore.getEntry(scriptId)) {
      throw new Error(`Referenced script not found: ${scriptId}`);
    }
  }

  private async toView(action: QuickAction): Promise<QuickActionView> {
    if (action.type === 'prompt') {
      return { ...action, available: true, effectiveProjectDir: action.projectDir };
    }
    const script = await this.scriptStore.getEntry(action.scriptId);
    if (!script) {
      return {
        ...action,
        available: false,
        unavailableReason: `Referenced script not found: ${action.scriptId}`,
        effectiveProjectDir: action.projectDir,
      };
    }
    return {
      ...action,
      available: true,
      effectiveProjectDir: action.projectDir ?? script.projectDir,
      scriptName: script.name,
    };
  }

  async getActions(): Promise<QuickActionView[]> {
    const state = await this.load();
    return Promise.all(sortActions(state.entries).map((action) => this.toView(action)));
  }

  async getAction(id: string): Promise<QuickActionView | null> {
    const state = await this.load();
    const action = state.entries.find((entry) => entry.id === id);
    return action ? this.toView(action) : null;
  }

  async createAction(input: CreateQuickActionInput | unknown): Promise<QuickActionView> {
    let created: QuickAction | undefined;
    await this.withDualLock(async () => {
      const state = await this.load();
      const nextOrder = state.entries.reduce((max, action) => Math.max(max, action.order), -1) + 1;
      const draft = parseActionDraft(input, nextOrder);
      if (draft.type === 'script') await this.requireScript(draft.scriptId);
      const now = new Date().toISOString();
      created = { ...draft, id: nanoid(), createdAt: now, updatedAt: now } as QuickAction;
      state.entries.push(created);
      state.lastModified = now;
      await this.save(state);
    });
    return this.toView(created!);
  }

  async updateAction(id: string, input: UpdateQuickActionInput | unknown): Promise<QuickActionView> {
    let updated: QuickAction | undefined;
    await this.withDualLock(async () => {
      const state = await this.load();
      const index = state.entries.findIndex((entry) => entry.id === id);
      if (index === -1) throw new Error(`Quick action not found: ${id}`);
      const existing = state.entries[index];
      const patch = assertRecord(input, 'quick action update');
      if (patch.type !== undefined && patch.type !== existing.type) {
        throw new Error('Quick action type cannot be changed');
      }
      const allowed = existing.type === 'prompt' ? PROMPT_INPUT_KEYS : SCRIPT_INPUT_KEYS;
      assertAllowedKeys(patch, allowed, 'quick action update');
      const draft = parseActionDraft(toInputRecord(existing, patch), existing.order);
      if (draft.type === 'script' && draft.scriptId !== (existing as ScriptQuickAction).scriptId) {
        await this.requireScript(draft.scriptId);
      }
      updated = {
        ...draft,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: new Date().toISOString(),
      } as QuickAction;
      state.entries[index] = updated;
      state.lastModified = updated.updatedAt;
      await this.save(state);
    });
    return this.toView(updated!);
  }

  async deleteAction(id: string): Promise<void> {
    await this.withDualLock(async () => {
      const state = await this.load();
      if (!state.entries.some((entry) => entry.id === id)) {
        throw new Error(`Quick action not found: ${id}`);
      }
      state.entries = state.entries.filter((entry) => entry.id !== id);
      state.lastModified = new Date().toISOString();
      await this.save(state);
    });
  }

  async hasScriptReference(scriptId: string): Promise<boolean> {
    const state = await this.load();
    return state.entries.some((entry) => entry.type === 'script' && entry.scriptId === scriptId);
  }
}
