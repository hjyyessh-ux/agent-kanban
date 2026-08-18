import React, { useMemo, useState } from 'react';
import type {
  QuickActionParameterValue,
  QuickActionView,
  RunQuickActionResponse,
} from '../../../../src/core/types';
import { parameterEnvironmentKey } from '../../../../src/core/execution-environment';
import { buildQuickActionFormModel } from '../../hooks/quickActionFormModel';

export interface QuickActionRunPanelProps {
  action: QuickActionView;
  running: boolean;
  onRun: (
    id: string,
    parameterValues: Readonly<Record<string, unknown>>,
  ) => Promise<RunQuickActionResponse>;
  onBack: () => void;
  onCompleted: () => void;
  onError: (message: string) => void;
}

export function isProductionQuickAction(action: QuickActionView): boolean {
  const text = `${action.name} ${action.description} ${action.projectDir ?? ''} ${action.effectiveProjectDir ?? ''}`.toLowerCase();
  return /(^|[^a-z])(prod|production)([^a-z]|$)/.test(text)
    || (action.type === 'prompt' && action.codexOptions?.sandbox === 'danger-full-access')
    || (action.type === 'prompt' && action.claudeOptions?.permissionMode === 'bypassPermissions');
}

export function initialQuickActionRunValues(
  action: QuickActionView,
): Record<string, QuickActionParameterValue> {
  return Object.fromEntries(
    action.parameterDefinitions.flatMap((definition) => (
      definition.type !== 'secret' && definition.defaultValue !== undefined
        ? [[definition.key, definition.defaultValue] as const]
        : []
    )),
  );
}

function QuickActionSummary({ action }: { action: QuickActionView }) {
  return (
    <dl className="kv2-quick-action-summary">
      <div><dt>Icon</dt><dd>{action.icon}</dd></div>
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

export const QuickActionRunPanel: React.FC<QuickActionRunPanelProps> = ({
  action,
  running,
  onRun,
  onBack,
  onCompleted,
  onError,
}) => {
  const [parameterValues, setParameterValues] = useState<Record<string, unknown>>(
    () => initialQuickActionRunValues(action),
  );
  const [submitting, setSubmitting] = useState(false);
  const [productionConfirmed, setProductionConfirmed] = useState(false);
  const formModel = useMemo(
    () => buildQuickActionFormModel(action, parameterValues),
    [action, parameterValues],
  );
  const productionRisk = isProductionQuickAction(action);

  const runAction = async () => {
    if (!formModel.canRun || running || submitting || (productionRisk && !productionConfirmed)) return;
    setSubmitting(true);
    onError('');
    try {
      await onRun(action.id, parameterValues);
      setParameterValues({});
      onCompleted();
    } catch (caught: unknown) {
      onError(caught instanceof Error ? caught.message : 'Failed to run quick action');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="kv2-quick-actions-shell kv2-quick-action-run-panel">
      <div className="kv2-quick-action-run-title">
        <span className="kv2-quick-action-item-icon" aria-hidden="true">{action.icon}</span>
        <div>
          <h3 className="kv2-panel-heading">Run {action.name}</h3>
          {action.description && <p className="kv2-panel-subtitle">{action.description}</p>}
        </div>
      </div>
      <QuickActionSummary action={action} />
      <div className="kv2-quick-action-fields">
        {action.parameterDefinitions.map((definition) => {
          const id = `quick-action-param-${definition.key}`;
          const value = parameterValues[definition.key];
          const actualKey = action.type === 'script'
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
                  {definition.options.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  className={`kv2-input${formModel.errors[definition.key] ? ' kv2-input--error' : ''}`}
                  type={definition.type === 'secret'
                    ? 'password'
                    : definition.type === 'number'
                      ? 'number'
                      : 'text'}
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
                {formModel.errors[definition.key] && (
                  <span role="alert"> · {formModel.errors[definition.key]}</span>
                )}
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
        <button
          type="button"
          className="kv2-btn kv2-btn--outline kv2-action-cancel"
          onClick={onBack}
        >
          Back
        </button>
        <button
          type="button"
          className="kv2-btn kv2-btn--primary"
          disabled={!formModel.canRun
            || running
            || submitting
            || (productionRisk && !productionConfirmed)}
          onClick={() => { void runAction(); }}
        >
          {running || submitting ? 'Starting…' : 'Run Action'}
        </button>
      </div>
    </div>
  );
};
