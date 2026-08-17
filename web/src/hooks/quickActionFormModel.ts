import type {
  QuickActionParameterDefinition,
  QuickActionParameterValue,
  QuickActionView,
} from '../../../src/core/types';

export interface QuickActionParameterValidationResult {
  valid: boolean;
  /** Transient, validated values ready for the run request. May contain secrets. */
  requestValues: Record<string, QuickActionParameterValue>;
  /** Field-level messages. Messages never interpolate user-supplied values. */
  errors: Record<string, string>;
}

export interface QuickActionParameterFormField {
  definition: QuickActionParameterDefinition;
  /** Secret values are deliberately omitted from the persistent form model. */
  value?: QuickActionParameterValue;
  usesDefault: boolean;
  error?: string;
}

export interface QuickActionProjectDirFormState {
  value: string;
  effectiveValue?: string;
  required: boolean;
  error?: string;
}

export interface QuickActionScriptReferenceFormState {
  scriptId: string;
  status: 'available' | 'unavailable';
  unavailableReason?: string;
}

export interface QuickActionFormModel {
  actionId: string;
  type: QuickActionView['type'];
  enabled: boolean;
  available: boolean;
  fields: QuickActionParameterFormField[];
  /** Valid non-secret values only. Safe to keep in React state. */
  parameterValues: Record<string, QuickActionParameterValue>;
  errors: Record<string, string>;
  projectDir: QuickActionProjectDirFormState;
  scriptReference?: QuickActionScriptReferenceFormState;
  canRun: boolean;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateValue(
  definition: QuickActionParameterDefinition,
  value: unknown,
): { valid: true; value: QuickActionParameterValue } | { valid: false; error: string } {
  switch (definition.type) {
    case 'string':
    case 'secret':
      return typeof value === 'string'
        ? { valid: true, value }
        : { valid: false, error: `${definition.label} must be a string` };
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { valid: true, value }
        : { valid: false, error: `${definition.label} must be a finite number` };
    case 'boolean':
      return typeof value === 'boolean'
        ? { valid: true, value }
        : { valid: false, error: `${definition.label} must be a boolean` };
    case 'select':
      return typeof value === 'string' && definition.options.includes(value)
        ? { valid: true, value }
        : { valid: false, error: `${definition.label} must be one of the available options` };
  }
}

/**
 * Merges stored defaults with transient user values and mirrors the server's
 * required/type/select/unknown-key validation contract. Secret values exist
 * only in the returned request payload and never appear in an error message.
 */
export function validateQuickActionParameterValues(
  definitions: readonly QuickActionParameterDefinition[],
  userValues: Readonly<Record<string, unknown>>,
): QuickActionParameterValidationResult {
  const definitionsByKey = new Map(definitions.map((definition) => [definition.key, definition]));
  const errors: Record<string, string> = {};
  const requestValues: Record<string, QuickActionParameterValue> = {};

  for (const key of Object.keys(userValues)) {
    if (!definitionsByKey.has(key)) {
      errors[key] = `Unknown quick action parameter: ${key}`;
    }
  }

  for (const definition of definitions) {
    const provided = hasOwn(userValues, definition.key);
    const rawValue = provided ? userValues[definition.key] : definition.defaultValue;
    if (rawValue === undefined) {
      if (definition.required) {
        errors[definition.key] = `${definition.label} is required`;
      }
      continue;
    }

    if (
      definition.required
      && (definition.type === 'string' || definition.type === 'secret')
      && typeof rawValue === 'string'
      && rawValue.trim().length === 0
    ) {
      errors[definition.key] = `${definition.label} is required`;
      continue;
    }

    const validated = validateValue(definition, rawValue);
    if (!validated.valid) {
      errors[definition.key] = validated.error;
      continue;
    }
    requestValues[definition.key] = validated.value;
  }

  return {
    valid: Object.keys(errors).length === 0,
    requestValues,
    errors,
  };
}

/**
 * Builds render-safe state for the run form. The model records the prompt cwd
 * requirement and script reference availability, but never retains a secret.
 */
export function buildQuickActionFormModel(
  action: QuickActionView,
  userValues: Readonly<Record<string, unknown>> = {},
): QuickActionFormModel {
  const validation = validateQuickActionParameterValues(action.parameterDefinitions, userValues);
  const errors = { ...validation.errors };
  const parameterValues: Record<string, QuickActionParameterValue> = {};
  const definitionsByKey = new Map(
    action.parameterDefinitions.map((definition) => [definition.key, definition]),
  );

  for (const [key, value] of Object.entries(validation.requestValues)) {
    if (definitionsByKey.get(key)?.type !== 'secret') {
      parameterValues[key] = value;
    }
  }

  const fields = action.parameterDefinitions.map((definition): QuickActionParameterFormField => {
    const value = definition.type === 'secret'
      ? undefined
      : validation.requestValues[definition.key];
    return {
      definition,
      ...(value === undefined ? {} : { value }),
      usesDefault: definition.type !== 'secret'
        && !hasOwn(userValues, definition.key)
        && definition.defaultValue !== undefined,
      ...(validation.errors[definition.key] ? { error: validation.errors[definition.key] } : {}),
    };
  });

  const projectDirValue = action.type === 'prompt'
    ? action.projectDir
    : (action.projectDir ?? '');
  const projectDirError = action.type === 'prompt' && projectDirValue.trim().length === 0
    ? 'Project directory is required'
    : undefined;
  if (projectDirError) errors.projectDir = projectDirError;

  let scriptReference: QuickActionScriptReferenceFormState | undefined;
  if (action.type === 'script') {
    const unavailableReason = action.unavailableReason
      ?? (action.scriptId.trim().length === 0 ? 'Script reference is required' : undefined);
    scriptReference = {
      scriptId: action.scriptId,
      status: action.available && !unavailableReason ? 'available' : 'unavailable',
      ...(unavailableReason ? { unavailableReason } : {}),
    };
    if (scriptReference.status === 'unavailable') {
      errors.scriptId = unavailableReason ?? 'Referenced script is unavailable';
    }
  }

  return {
    actionId: action.id,
    type: action.type,
    enabled: action.enabled,
    available: action.available,
    fields,
    parameterValues,
    errors,
    projectDir: {
      value: projectDirValue,
      ...(action.effectiveProjectDir ? { effectiveValue: action.effectiveProjectDir } : {}),
      required: action.type === 'prompt',
      ...(projectDirError ? { error: projectDirError } : {}),
    },
    ...(scriptReference ? { scriptReference } : {}),
    canRun: action.enabled && action.available && Object.keys(errors).length === 0,
  };
}

/** Redacts transient secret values before an exception reaches hook state or callers. */
export function redactQuickActionSecretValues(
  message: string,
  definitions: readonly QuickActionParameterDefinition[],
  userValues: Readonly<Record<string, unknown>>,
): string {
  let redacted = message;
  for (const definition of definitions) {
    if (definition.type !== 'secret') continue;
    const value = userValues[definition.key];
    if (typeof value === 'string' && value.length > 0) {
      redacted = redacted.split(value).join('[REDACTED]');
    }
  }
  return redacted;
}
