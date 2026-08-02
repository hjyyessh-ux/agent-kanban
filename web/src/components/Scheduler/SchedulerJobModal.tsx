import React, { useEffect, useRef, useState } from 'react';
import type {
  AgentRuntime,
  ClaudePermissionMode,
  CodexReasoningEffort,
  CodexSandboxMode,
  CreateSchedulerInput,
  SchedulerActionType,
  SchedulerEntry,
  SchedulerScheduleInputState,
  SchedulerSimpleRepeat,
  UpdateSchedulerInput,
} from '../../../../src/core/types';
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from '../../../../src/core/runtime-config';
import {
  inferSchedulerScheduleInput,
  resolveSchedulerScheduleInput,
  SCHEDULER_CRON_FIELD_HINT,
} from '../../../../src/core/scheduling';
import { useRuntimeDefaults } from '../../hooks/useRuntimeDefaults';
import { useRuntimeModelSelection } from '../../hooks/useRuntimeModelSelection';
import { DialogSkeleton } from '../Card/DialogSkeleton';
import { DirectoryPicker } from '../Card/DirectoryPicker';
import { ErrorAlert } from '../shared/ErrorAlert';
import { RuntimeModelFields } from '../shared/RuntimeModelFields';
import './Scheduler.css';

interface SchedulerJobModalProps {
  onClose: () => void;
  onSave: (input: CreateSchedulerInput) => Promise<void>;
  onUpdate?: (id: string, input: UpdateSchedulerInput) => Promise<void>;
  editEntry?: SchedulerEntry;
}

interface SchedulerActionFieldsProps {
  actionType: SchedulerActionType;
  command: string;
  cwd: string;
  prompt: string;
  projectDir: string;
  runtime: AgentRuntime;
  model: string;
  orderedRuntimes: ReturnType<typeof useRuntimeModelSelection>['orderedRuntimes'];
  displayedModels: ReturnType<typeof useRuntimeModelSelection>['displayedModels'];
  codexReasoningEffort: CodexReasoningEffort;
  codexSandbox: CodexSandboxMode;
  codexSkipGitRepoCheck: boolean;
  codexBypassApprovalsAndSandbox: boolean;
  claudePermissionMode: ClaudePermissionMode;
  claudeDangerouslySkipPermissions: boolean;
  disabled: boolean;
  onCommandChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onProjectDirChange: (value: string) => void;
  onRuntimeChange: (runtime: AgentRuntime) => void;
  onModelChange: (model: string) => void;
  onCodexReasoningEffortChange: (value: CodexReasoningEffort) => void;
  onCodexSandboxChange: (value: CodexSandboxMode) => void;
  onCodexSkipGitRepoCheckChange: (value: boolean) => void;
  onCodexBypassApprovalsAndSandboxChange: (value: boolean) => void;
  onClaudePermissionModeChange: (value: ClaudePermissionMode) => void;
  onClaudeDangerouslySkipPermissionsChange: (value: boolean) => void;
}

interface SchedulerSchedulePreviewState {
  valid: boolean;
  cron?: string;
  description?: string;
  preview?: string;
  error?: string;
}

const ACTION_TYPES: Array<{
  type: SchedulerActionType;
  title: string;
  description: string;
}> = [
  {
    type: 'bash',
    title: 'Bash command',
    description: 'Run a shell command on the selected schedule.',
  },
  {
    type: 'prompt',
    title: 'Agent prompt',
    description: 'Dispatch a runtime prompt with runtime and model settings.',
  },
];

const SCHEDULE_MODES: Array<{
  mode: SchedulerScheduleInputState['mode'];
  title: string;
  description: string;
}> = [
  {
    mode: 'simple',
    title: '간편 설정',
    description: '반복 단위와 KST 시각을 선택하면 cron을 자동 생성합니다.',
  },
  {
    mode: 'cron',
    title: 'Cron 직접 입력',
    description: '복잡한 cron은 5-field 표현식으로 직접 관리합니다.',
  },
];

const SIMPLE_REPEAT_OPTIONS: Array<{ value: SchedulerSimpleRepeat; label: string }> = [
  { value: 'minutes', label: '매 N분' },
  { value: 'hours', label: '매 N시간' },
  { value: 'daily', label: '매일' },
  { value: 'weekdays', label: '평일' },
  { value: 'weekly', label: '요일 지정' },
];

const DAY_OPTIONS = [
  { value: 1, label: '월요일' },
  { value: 2, label: '화요일' },
  { value: 3, label: '수요일' },
  { value: 4, label: '목요일' },
  { value: 5, label: '금요일' },
  { value: 6, label: '토요일' },
  { value: 0, label: '일요일' },
];

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour);
const MINUTE_OPTIONS = Array.from({ length: 60 }, (_, minute) => minute);

function createDefaultScheduleInput(): SchedulerScheduleInputState {
  return {
    mode: 'simple',
    simple: {
      repeat: 'daily',
      hour: 9,
      minute: 0,
    },
  };
}

export function getInitialSchedulerScheduleInput(entry?: SchedulerEntry): SchedulerScheduleInputState {
  if (!entry) {
    return createDefaultScheduleInput();
  }
  return inferSchedulerScheduleInput(entry.cron, entry.scheduleInput);
}

export function getSchedulerSchedulePreview(scheduleInput: SchedulerScheduleInputState): SchedulerSchedulePreviewState {
  try {
    const resolved = resolveSchedulerScheduleInput(scheduleInput);
    return {
      valid: true,
      cron: resolved.cron,
      description: resolved.cronDescription,
      preview: resolved.preview,
    };
  } catch (error: unknown) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : '일정을 해석하지 못했습니다.',
    };
  }
}

export const SchedulerTimezoneNotice: React.FC = () => (
  <div className="scheduler-kst-note" role="note" aria-label="Scheduler timezone">
    모든 일정은 Asia/Seoul (KST) 기준입니다.
  </div>
);

export const SchedulerCronPreview: React.FC<{
  scheduleInput: SchedulerScheduleInputState;
  preview: SchedulerSchedulePreviewState;
}> = ({ scheduleInput, preview }) => {
  const inputText = scheduleInput.mode === 'simple'
    ? '간편 설정'
    : scheduleInput.expression.trim();
  const previewClassName = !inputText
    ? 'scheduler-cron-preview scheduler-cron-preview--empty'
    : preview.valid
      ? 'scheduler-cron-preview scheduler-cron-preview--valid'
      : 'scheduler-cron-preview scheduler-cron-preview--invalid';

  if (!inputText) {
    return (
      <div className={previewClassName} role="status" aria-live="polite">
        입력을 완성하면 KST 기준 실행 설명과 생성될 cron preview를 보여줍니다.
      </div>
    );
  }

  return (
    <div className={previewClassName} role="status" aria-live="polite">
      {preview.valid
        ? `Cron preview: ${preview.cron} · ${preview.preview}`
        : `확인 필요: ${preview.error}`}
    </div>
  );
};

function renderTimeSelect(
  id: string,
  value: number | undefined,
  options: number[],
  onChange: (value: number) => void,
  suffix: string,
  disabled: boolean,
) {
  return (
    <select
      id={id}
      className="kv2-select"
      value={typeof value === 'number' ? String(value) : ''}
      onChange={(event) => onChange(Number(event.target.value))}
      disabled={disabled}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {String(option).padStart(2, '0')}
          {suffix}
        </option>
      ))}
    </select>
  );
}

function SchedulerScheduleFields(props: {
  scheduleInput: SchedulerScheduleInputState;
  preview: SchedulerSchedulePreviewState;
  disabled: boolean;
  onChange: (value: SchedulerScheduleInputState) => void;
}) {
  const { scheduleInput, preview, disabled, onChange } = props;

  const moveMode = (nextMode: SchedulerScheduleInputState['mode']) => {
    if (nextMode === scheduleInput.mode) return;
    if (nextMode === 'simple') {
      if (scheduleInput.mode === 'cron' && scheduleInput.expression.trim()) {
        const inferred = inferSchedulerScheduleInput(scheduleInput.expression.trim());
        onChange(inferred.mode === 'simple' ? inferred : createDefaultScheduleInput());
        return;
      }
      if (preview.valid && preview.cron) {
        const inferred = inferSchedulerScheduleInput(preview.cron);
        onChange(inferred.mode === 'simple' ? inferred : createDefaultScheduleInput());
        return;
      }
      onChange(createDefaultScheduleInput());
      return;
    }
    onChange({
      mode: 'cron',
      expression: preview.valid && preview.cron ? preview.cron : '',
    });
  };

  const currentIndex = SCHEDULE_MODES.findIndex((item) => item.mode === scheduleInput.mode);

  return (
    <div className="scheduler-field scheduler-field--expand">
      <div className="kv2-label" id="scheduler-mode-group">Schedule *</div>
      <div
        className="scheduler-mode-toggle"
        role="radiogroup"
        aria-labelledby="scheduler-mode-group"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') {
            return;
          }
          event.preventDefault();
          const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
          const nextIndex = (currentIndex + direction + SCHEDULE_MODES.length) % SCHEDULE_MODES.length;
          const nextMode = SCHEDULE_MODES[nextIndex];
          if (nextMode) moveMode(nextMode.mode);
        }}
      >
        {SCHEDULE_MODES.map((item) => {
          const active = scheduleInput.mode === item.mode;
          return (
            <button
              key={item.mode}
              type="button"
              className={`scheduler-action-toggle-btn${active ? ' is-active' : ''}`}
              onClick={() => moveMode(item.mode)}
              disabled={disabled}
              role="radio"
              aria-checked={active}
            >
              <span className="scheduler-action-toggle-copy">
                <span className="scheduler-action-toggle-title">{item.title}</span>
                <span className="scheduler-action-toggle-description">{item.description}</span>
              </span>
              <span className="scheduler-action-toggle-check" aria-hidden="true">✓</span>
            </button>
          );
        })}
      </div>

      {scheduleInput.mode === 'simple' && (
        <div className="scheduler-schedule-shell">
          <div className="scheduler-simple-grid">
            <div className="scheduler-field">
              <label className="kv2-label" htmlFor="scheduler-simple-repeat">반복 단위</label>
              <select
                id="scheduler-simple-repeat"
                className="kv2-select"
                value={scheduleInput.simple.repeat}
                onChange={(event) => {
                  const repeat = event.target.value as SchedulerSimpleRepeat;
                  if (repeat === 'minutes') {
                    onChange({ mode: 'simple', simple: { repeat, interval: 5 } });
                    return;
                  }
                  if (repeat === 'hours') {
                    onChange({ mode: 'simple', simple: { repeat, interval: 2, minute: 0 } });
                    return;
                  }
                  if (repeat === 'weekly') {
                    onChange({ mode: 'simple', simple: { repeat, dayOfWeek: 1, hour: 9, minute: 0 } });
                    return;
                  }
                  onChange({ mode: 'simple', simple: { repeat, hour: 9, minute: 0 } });
                }}
                disabled={disabled}
              >
                {SIMPLE_REPEAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>

            {(scheduleInput.simple.repeat === 'minutes' || scheduleInput.simple.repeat === 'hours') && (
              <div className="scheduler-field">
                <label className="kv2-label" htmlFor="scheduler-simple-interval">간격</label>
                <input
                  id="scheduler-simple-interval"
                  className="kv2-input"
                  type="number"
                  min={1}
                  max={scheduleInput.simple.repeat === 'minutes' ? 59 : 23}
                  value={scheduleInput.simple.interval ?? ''}
                  onChange={(event) => onChange({
                    mode: 'simple',
                    simple: {
                      ...scheduleInput.simple,
                      interval: Number(event.target.value),
                    },
                  })}
                  disabled={disabled}
                />
              </div>
            )}

            {scheduleInput.simple.repeat === 'weekly' && (
              <div className="scheduler-field">
                <label className="kv2-label" htmlFor="scheduler-simple-day">요일</label>
                <select
                  id="scheduler-simple-day"
                  className="kv2-select"
                  value={String(scheduleInput.simple.dayOfWeek ?? 1)}
                  onChange={(event) => onChange({
                    mode: 'simple',
                    simple: {
                      ...scheduleInput.simple,
                      dayOfWeek: Number(event.target.value),
                    },
                  })}
                  disabled={disabled}
                >
                  {DAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
            )}

            {scheduleInput.simple.repeat !== 'minutes' && (
              <>
                <div className="scheduler-field">
                  <label className="kv2-label" htmlFor="scheduler-simple-hour">KST 시</label>
                  {renderTimeSelect(
                    'scheduler-simple-hour',
                    scheduleInput.simple.hour,
                    HOUR_OPTIONS,
                    (hour) => onChange({
                      mode: 'simple',
                      simple: {
                        ...scheduleInput.simple,
                        hour,
                      },
                    }),
                    '시',
                    disabled,
                  )}
                </div>

                <div className="scheduler-field">
                  <label className="kv2-label" htmlFor="scheduler-simple-minute">KST 분</label>
                  {renderTimeSelect(
                    'scheduler-simple-minute',
                    scheduleInput.simple.minute,
                    MINUTE_OPTIONS,
                    (minute) => onChange({
                      mode: 'simple',
                      simple: {
                        ...scheduleInput.simple,
                        minute,
                      },
                    }),
                    '분',
                    disabled,
                  )}
                </div>
              </>
            )}
          </div>

          <div className="scheduler-readonly-shell">
            <span className="scheduler-detail-label">Generated cron</span>
            <code className="scheduler-readonly-cron">{preview.valid ? preview.cron : '입력을 완성하면 표시됩니다.'}</code>
          </div>
        </div>
      )}

      {scheduleInput.mode === 'cron' && (
        <div className="scheduler-schedule-shell">
          <span className="scheduler-hint">
            5-field cron만 지원합니다. 순서: {SCHEDULER_CRON_FIELD_HINT}
          </span>
          <input
            id="scheduler-cron-input"
            className="kv2-input"
            value={scheduleInput.expression}
            onChange={(event) => onChange({ mode: 'cron', expression: event.target.value })}
            placeholder="*/5 * * * *"
            disabled={disabled}
            aria-describedby="scheduler-cron-fields"
          />
          <div id="scheduler-cron-fields" className="scheduler-field-hints" aria-label="Cron field hint">
            <span>minute</span>
            <span>hour</span>
            <span>day</span>
            <span>month</span>
            <span>weekday</span>
          </div>
        </div>
      )}

      <SchedulerCronPreview scheduleInput={scheduleInput} preview={preview} />
    </div>
  );
}

export const SchedulerActionFields: React.FC<SchedulerActionFieldsProps> = ({
  actionType,
  command,
  cwd,
  prompt,
  projectDir,
  runtime,
  model,
  orderedRuntimes,
  displayedModels,
  codexReasoningEffort,
  codexSandbox,
  codexSkipGitRepoCheck,
  codexBypassApprovalsAndSandbox,
  claudePermissionMode,
  claudeDangerouslySkipPermissions,
  disabled,
  onCommandChange,
  onCwdChange,
  onPromptChange,
  onProjectDirChange,
  onRuntimeChange,
  onModelChange,
  onCodexReasoningEffortChange,
  onCodexSandboxChange,
  onCodexSkipGitRepoCheckChange,
  onCodexBypassApprovalsAndSandboxChange,
  onClaudePermissionModeChange,
  onClaudeDangerouslySkipPermissionsChange,
}) => {
  if (actionType === 'bash') {
    return (
      <div className="scheduler-action-fields">
        <div className="scheduler-field scheduler-field--expand">
          <label className="kv2-label" htmlFor="scheduler-command-input">Bash command *</label>
          <textarea
            id="scheduler-command-input"
            className="kv2-textarea scheduler-textarea scheduler-textarea--command"
            value={command}
            onChange={(event) => onCommandChange(event.target.value)}
            placeholder="bun run scripts/nightly-check.ts"
            disabled={disabled}
            rows={5}
          />
        </div>
        <div className="scheduler-field">
          <label className="kv2-label" htmlFor="scheduler-cwd-input">Working directory</label>
          <DirectoryPicker
            id="scheduler-cwd-input"
            value={cwd}
            onChange={onCwdChange}
            disabled={disabled}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="scheduler-action-fields">
      <div className="scheduler-field scheduler-field--expand">
        <label className="kv2-label" htmlFor="scheduler-prompt-input">Agent prompt *</label>
        <textarea
          id="scheduler-prompt-input"
          className="kv2-textarea scheduler-textarea scheduler-textarea--prompt"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder="새벽 점검 결과를 요약하고 후속 카드를 만들어 주세요."
          disabled={disabled}
          rows={7}
        />
      </div>

      <div className="scheduler-field">
        <label className="kv2-label" htmlFor="scheduler-project-dir-input">Project directory</label>
        <DirectoryPicker
          id="scheduler-project-dir-input"
          value={projectDir}
          onChange={onProjectDirChange}
          disabled={disabled}
        />
      </div>

      <RuntimeModelFields
        runtime={runtime}
        model={model}
        orderedRuntimes={orderedRuntimes}
        displayedModels={displayedModels}
        runtimeInputId="scheduler-runtime-group"
        modelInputId="scheduler-model-select"
        disabled={disabled}
        layoutVariant="scheduler"
        selectorVariant="cards"
        onRuntimeChange={onRuntimeChange}
        onModelChange={onModelChange}
      />

      {runtime === 'codex' && (
        <div className="scheduler-runtime-options">
          <div className="scheduler-field">
            <label className="kv2-label" htmlFor="scheduler-codex-reasoning-select">Codex reasoning</label>
            <select
              id="scheduler-codex-reasoning-select"
              className="kv2-select"
              value={codexReasoningEffort}
              onChange={(event) => onCodexReasoningEffortChange(event.target.value as CodexReasoningEffort)}
              disabled={disabled}
            >
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Xhigh</option>
            </select>
          </div>

          <div className="scheduler-field">
            <label className="kv2-label" htmlFor="scheduler-codex-sandbox-select">Codex sandbox</label>
            <select
              id="scheduler-codex-sandbox-select"
              className="kv2-select"
              value={codexSandbox}
              onChange={(event) => onCodexSandboxChange(event.target.value as CodexSandboxMode)}
              disabled={disabled}
            >
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </div>

          <div className="scheduler-runtime-options-toggles">
            <label className="scheduler-inline-toggle">
              <input
                type="checkbox"
                checked={codexSkipGitRepoCheck}
                onChange={(event) => onCodexSkipGitRepoCheckChange(event.target.checked)}
                disabled={disabled}
              />
              <span>Skip git repo check</span>
            </label>

            <label className="scheduler-inline-toggle">
              <input
                type="checkbox"
                checked={codexBypassApprovalsAndSandbox}
                onChange={(event) => onCodexBypassApprovalsAndSandboxChange(event.target.checked)}
                disabled={disabled}
              />
              <span>Bypass approvals and sandbox</span>
            </label>
          </div>
        </div>
      )}

      {runtime === 'claude' && (
        <div className="scheduler-runtime-options">
          <div className="scheduler-field">
            <label className="kv2-label" htmlFor="scheduler-claude-permission-select">Claude permissions</label>
            <select
              id="scheduler-claude-permission-select"
              className="kv2-select"
              value={claudePermissionMode}
              onChange={(event) => onClaudePermissionModeChange(event.target.value as ClaudePermissionMode)}
              disabled={disabled || claudeDangerouslySkipPermissions}
            >
              <option value="acceptEdits">Accept edits</option>
              <option value="bypassPermissions">Bypass permissions</option>
              <option value="plan">Plan</option>
              <option value="dontAsk">Do not ask</option>
            </select>
          </div>

          <div className="scheduler-runtime-options-toggles">
            <label className="scheduler-inline-toggle">
              <input
                type="checkbox"
                checked={claudeDangerouslySkipPermissions}
                onChange={(event) => onClaudeDangerouslySkipPermissionsChange(event.target.checked)}
                disabled={disabled}
              />
              <span>Dangerously skip permissions</span>
            </label>
          </div>
        </div>
      )}
    </div>
  );
};

export const SchedulerJobModal: React.FC<SchedulerJobModalProps> = ({
  onClose,
  onSave,
  onUpdate,
  editEntry,
}) => {
  const isEditing = !!editEntry;
  const action = editEntry?.action;
  const { prefs } = useRuntimeDefaults();
  const [name, setName] = useState(editEntry?.name ?? '');
  const [description, setDescription] = useState(editEntry?.description ?? '');
  const [scheduleInput, setScheduleInput] = useState<SchedulerScheduleInputState>(getInitialSchedulerScheduleInput(editEntry));
  const [actionType, setActionType] = useState<SchedulerActionType>(action?.type ?? 'bash');
  const [command, setCommand] = useState(action?.type === 'bash' ? action.command : '');
  const [cwd, setCwd] = useState(action?.type === 'bash' ? action.cwd ?? '' : '');
  const [prompt, setPrompt] = useState(action?.type === 'prompt' ? action.prompt : '');
  const [projectDir, setProjectDir] = useState(action?.type === 'prompt' ? action.projectDir ?? '' : '');
  const [agentRuntime, setAgentRuntime] = useState<AgentRuntime>(action?.type === 'prompt'
    ? action.agentRuntime ?? prefs.runtime ?? 'opencode'
    : prefs.runtime ?? 'opencode');
  const [model, setModel] = useState(action?.type === 'prompt' ? action.model ?? '' : '');
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(
    action?.type === 'prompt'
      ? action.codexOptions?.reasoningEffort ?? prefs.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT
      : prefs.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
  );
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>(
    action?.type === 'prompt'
      ? action.codexOptions?.sandbox ?? prefs.codexSandbox ?? DEFAULT_CODEX_SANDBOX
      : prefs.codexSandbox ?? DEFAULT_CODEX_SANDBOX,
  );
  const [codexSkipGitRepoCheck, setCodexSkipGitRepoCheck] = useState(
    action?.type === 'prompt' ? action.codexOptions?.skipGitRepoCheck ?? true : true,
  );
  const [codexBypassApprovalsAndSandbox, setCodexBypassApprovalsAndSandbox] = useState(
    action?.type === 'prompt'
      ? action.codexOptions?.bypassApprovalsAndSandbox ?? prefs.codexBypassApprovalsAndSandbox ?? false
      : prefs.codexBypassApprovalsAndSandbox ?? false,
  );
  const [claudePermissionMode, setClaudePermissionMode] = useState<ClaudePermissionMode>(
    action?.type === 'prompt'
      ? action.claudeOptions?.permissionMode ?? prefs.claudePermissionMode ?? 'acceptEdits'
      : prefs.claudePermissionMode ?? 'acceptEdits',
  );
  const [claudeDangerouslySkipPermissions, setClaudeDangerouslySkipPermissions] = useState(
    action?.type === 'prompt'
      ? action.claudeOptions?.dangerouslySkipPermissions ?? prefs.claudeDangerouslySkipPermissions ?? false
      : prefs.claudeDangerouslySkipPermissions ?? false,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);
  const runtimeTouchedRef = useRef(false);

  const {
    orderedRuntimes,
    displayedModels,
    getDefaultModelForRuntime,
    isModelAvailableForRuntime,
    persistRuntimeSelection,
    persistModelSelection,
  } = useRuntimeModelSelection(agentRuntime);

  useEffect(() => {
    if (!prefs.runtime || runtimeTouchedRef.current || action?.type === 'prompt') return;
    setAgentRuntime(prefs.runtime);
  }, [action?.type, prefs.runtime]);

  useEffect(() => {
    if (model && isModelAvailableForRuntime(model, agentRuntime)) return;
    const nextModel = getDefaultModelForRuntime(agentRuntime);
    if (nextModel) setModel(nextModel);
  }, [agentRuntime, getDefaultModelForRuntime, isModelAvailableForRuntime, model]);

  const schedulePreview = getSchedulerSchedulePreview(scheduleInput);

  const canSubmit = () => {
    if (!name.trim()) return false;
    if (!schedulePreview.valid) return false;
    if (actionType === 'bash') return Boolean(command.trim());
    return Boolean(prompt.trim());
  };

  const buildPromptAction = () => ({
    type: 'prompt' as const,
    prompt: prompt.trim(),
    projectDir: projectDir.trim() || undefined,
    agentRuntime,
    model: (model || getDefaultModelForRuntime(agentRuntime)) || undefined,
    codexOptions: agentRuntime === 'codex' ? {
      reasoningEffort: codexReasoningEffort,
      sandbox: codexSandbox,
      skipGitRepoCheck: codexSkipGitRepoCheck,
      bypassApprovalsAndSandbox: codexBypassApprovalsAndSandbox,
    } : undefined,
    claudeOptions: agentRuntime === 'claude' ? {
      permissionMode: claudePermissionMode,
      dangerouslySkipPermissions: claudeDangerouslySkipPermissions,
    } : undefined,
  });

  const handleSubmit = async () => {
    if (!canSubmit() || isSubmitting || !schedulePreview.valid || !schedulePreview.cron || !schedulePreview.description) return;

    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const actionInput = actionType === 'bash'
        ? {
            type: 'bash' as const,
            command: command.trim(),
            cwd: cwd.trim() || undefined,
          }
        : buildPromptAction();

      const payload = {
        name: name.trim(),
        description: description.trim(),
        cron: schedulePreview.cron,
        cronDescription: schedulePreview.description,
        scheduleInput,
        action: actionInput,
      };

      if (isEditing && onUpdate && editEntry) {
        await onUpdate(editEntry.id, payload);
      } else {
        await onSave(payload);
      }

      onClose();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'The scheduler could not be saved.';
      setSubmitError({
        title: isEditing ? 'Scheduler update failed' : 'Scheduler creation failed',
        message,
      });
      setIsSubmitting(false);
    }
  };

  const needsEdit = action?.editState === 'edit-required';

  return (
    <DialogSkeleton
      title={isEditing ? 'Edit Scheduler' : 'New Scheduler'}
      onClose={onClose}
      persistSizeKey="kanban-scheduler-modal-size"
      defaultSize={{ width: 900, height: 760 }}
      className="kv2-dialog--form kv2-dialog--scheduler kv2-dialog--status-todo"
    >
      <div className="scheduler-modal-body">
        <div className="scheduler-modal-scroll">
          <SchedulerTimezoneNotice />

          {needsEdit && (
            <ErrorAlert
              variant="inline"
              title="편집 필요"
              message="이 항목은 legacy skill 실행 기록에서 변환되었습니다. Prompt 내용을 확인하고 저장한 뒤 다시 활성화하세요."
            />
          )}

          {submitError && (
            <ErrorAlert
              variant="inline"
              title={submitError.title}
              message={submitError.message}
              onDismiss={() => setSubmitError(null)}
            />
          )}

          <div className="scheduler-modal-grid">
            <div className="scheduler-field">
              <label className="kv2-label" htmlFor="scheduler-name-input">Name *</label>
              <input
                id="scheduler-name-input"
                className="kv2-input"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="예: Morning triage"
                disabled={isSubmitting}
              />
            </div>

            <div className="scheduler-field">
              <label className="kv2-label" htmlFor="scheduler-description-input">Description</label>
              <input
                id="scheduler-description-input"
                className="kv2-input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="팀이 보는 용도의 짧은 설명"
                disabled={isSubmitting}
              />
            </div>
          </div>

          <SchedulerScheduleFields
            scheduleInput={scheduleInput}
            preview={schedulePreview}
            disabled={isSubmitting}
            onChange={setScheduleInput}
          />

          <div className="scheduler-field">
            <div className="kv2-label" id="scheduler-action-group">Execution mode</div>
            <div
              className="scheduler-action-toggle"
              role="radiogroup"
              aria-labelledby="scheduler-action-group"
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') {
                  return;
                }
                event.preventDefault();
                const currentIndex = ACTION_TYPES.findIndex((item) => item.type === actionType);
                const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
                const nextIndex = (currentIndex + direction + ACTION_TYPES.length) % ACTION_TYPES.length;
                setActionType(ACTION_TYPES[nextIndex]?.type ?? actionType);
              }}
            >
              {ACTION_TYPES.map((item) => {
                const active = actionType === item.type;
                return (
                  <button
                    key={item.type}
                    type="button"
                    className={`scheduler-action-toggle-btn${active ? ' is-active' : ''}`}
                    onClick={() => setActionType(item.type)}
                    disabled={isSubmitting}
                    role="radio"
                    aria-checked={active}
                  >
                    <span className="scheduler-action-toggle-copy">
                      <span className="scheduler-action-toggle-title">{item.title}</span>
                      <span className="scheduler-action-toggle-description">{item.description}</span>
                    </span>
                    <span className="scheduler-action-toggle-check" aria-hidden="true">✓</span>
                  </button>
                );
              })}
            </div>
          </div>

          <SchedulerActionFields
            actionType={actionType}
            command={command}
            cwd={cwd}
            prompt={prompt}
            projectDir={projectDir}
            runtime={agentRuntime}
            model={model}
            orderedRuntimes={orderedRuntimes}
            displayedModels={displayedModels}
            codexReasoningEffort={codexReasoningEffort}
            codexSandbox={codexSandbox}
            codexSkipGitRepoCheck={codexSkipGitRepoCheck}
            codexBypassApprovalsAndSandbox={codexBypassApprovalsAndSandbox}
            claudePermissionMode={claudePermissionMode}
            claudeDangerouslySkipPermissions={claudeDangerouslySkipPermissions}
            disabled={isSubmitting}
            onCommandChange={setCommand}
            onCwdChange={setCwd}
            onPromptChange={setPrompt}
            onProjectDirChange={setProjectDir}
            onRuntimeChange={(nextRuntime) => {
              runtimeTouchedRef.current = true;
              setAgentRuntime(nextRuntime);
              persistRuntimeSelection(nextRuntime);
              setModel(getDefaultModelForRuntime(nextRuntime));
            }}
            onModelChange={(nextModel) => {
              setModel(nextModel);
              if (nextModel) {
                persistModelSelection(agentRuntime, nextModel);
              }
            }}
            onCodexReasoningEffortChange={setCodexReasoningEffort}
            onCodexSandboxChange={setCodexSandbox}
            onCodexSkipGitRepoCheckChange={setCodexSkipGitRepoCheck}
            onCodexBypassApprovalsAndSandboxChange={setCodexBypassApprovalsAndSandbox}
            onClaudePermissionModeChange={setClaudePermissionMode}
            onClaudeDangerouslySkipPermissionsChange={setClaudeDangerouslySkipPermissions}
          />
        </div>

        <div className="kv2-dialog-footer kv2-actions-split">
          <button type="button" className="kv2-btn kv2-btn--ghost kv2-action-cancel" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit() || isSubmitting}
          >
            {isSubmitting ? 'Saving...' : isEditing ? 'Save changes' : 'Create scheduler'}
          </button>
        </div>
      </div>
    </DialogSkeleton>
  );
};
