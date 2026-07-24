import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { uploadScreenshot } from "../../hooks/useKanbanApi";
import { KanbanCard, CreateCardInput, QueueSessionMode, AgentRuntime, ClaudePermissionMode, CodexReasoningEffort, CodexSandboxMode } from "../../../../src/core/types";
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from "../../../../src/core/runtime-config";
import { useRuntimeDefaults } from "../../hooks/useRuntimeDefaults";
import { AGENT_CONFIGS } from "../../constants/agents";
import {
  getCommandHint,
  getFilteredCommandsForRuntime,
  isCommandAvailableForRuntime,
  type CommandId,
} from "../../constants/commands";
import { DialogSkeleton } from "./DialogSkeleton";
import { ErrorAlert } from "../shared/ErrorAlert";
import { SessionPickerPanel } from "./SessionPickerPanel";
import { QueueSessionModePicker, QueueTargetList } from "./QueueSettingsPanel";
import { DirectoryPicker } from "./DirectoryPicker";
import { CommandPicker } from "./CommandPicker";
import { useDirectoryHistory } from "../../hooks/useDirectoryHistory";
import { RuntimeModelFields } from "../shared/RuntimeModelFields";
import {
  buildDefaultScheduleInput,
  ScheduledDispatchEditor,
  validateScheduleInputKst,
} from "../shared/ScheduledDispatchUi";
import { useRuntimeModelSelection } from "../../hooks/useRuntimeModelSelection";

interface CreateCardDialogProps {
  allCards: KanbanCard[];
  onClose: () => void;
  onCreate: (input: CreateCardInput) => Promise<KanbanCard>;
  onQueue: (
    cardId: string,
    afterCardId: string,
    sessionMode: QueueSessionMode
  ) => Promise<KanbanCard>;
  onClearBoardError: () => void;
  onReportBoardAlert: (title: string, message: string) => void;
}

const DEFAULT_QUEUE_SESSION_MODE: QueueSessionMode = "new_session";
export type CreateLaunchTiming = "later" | "schedule";

export interface CreateLaunchUiState {
  primaryActionLabel: "CREATE" | "CREATE & SCHEDULE";
  queueDisabledReason: string | null;
  scheduleDisabledReason: string | null;
}

export function deriveCreateLaunchUiState(
  launchTiming: CreateLaunchTiming,
  queueAfterId: string,
): CreateLaunchUiState {
  if (launchTiming === "schedule") {
    return {
      primaryActionLabel: "CREATE & SCHEDULE",
      queueDisabledReason: "예약 시작이 설정되어 있어 Queue After를 사용할 수 없습니다. 예약 시작을 끄면 Queue를 설정할 수 있습니다.",
      scheduleDisabledReason: null,
    };
  }

  if (queueAfterId) {
    return {
      primaryActionLabel: "CREATE",
      queueDisabledReason: null,
      scheduleDisabledReason: "Queue After가 설정되어 있어 예약 시작을 사용할 수 없습니다. queue target을 해제하면 예약할 수 있습니다.",
    };
  }

  return {
    primaryActionLabel: "CREATE",
    queueDisabledReason: null,
    scheduleDisabledReason: null,
  };
}

export const CreateCardDialog: React.FC<CreateCardDialogProps> = ({
  allCards,
  onClose,
  onCreate,
  onQueue,
  onClearBoardError,
  onReportBoardAlert,
}) => {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [model, setModel] = useState("");
  const [queueAfterId, setQueueAfterId] = useState("");
  const [queueSessionMode, setQueueSessionMode] = useState<QueueSessionMode>(
    DEFAULT_QUEUE_SESSION_MODE
  );
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [launchTiming, setLaunchTiming] = useState<CreateLaunchTiming>("later");
  const [scheduledAtInput, setScheduledAtInput] = useState(() => buildDefaultScheduleInput(new Date()));
  const [currentNow, setCurrentNow] = useState(() => new Date());
  const [agentType, setAgentType] = useState("sisyphus");
  const {
    prefs,
    setCodexReasoningEffort: saveCodexReasoningEffortDefault,
    setCodexSandbox: saveCodexSandboxDefault,
    setCodexBypassApprovalsAndSandbox,
    setClaudePermissionMode,
    setClaudeDangerouslySkipPermissions,
  } = useRuntimeDefaults();
  const [runtime, setRuntime] = useState<AgentRuntime>(prefs.runtime ?? "opencode");
  const [codexReasoningEffort, setCodexReasoningEffort] = useState<CodexReasoningEffort>(
    prefs.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT
  );
  const [codexSandbox, setCodexSandbox] = useState<CodexSandboxMode>(
    prefs.codexSandbox ?? DEFAULT_CODEX_SANDBOX
  );
  const [codexSkipGitRepoCheck, setCodexSkipGitRepoCheck] = useState(true);
  const [codexBypassApprovalsAndSandbox, setLocalCodexBypassApprovalsAndSandbox] = useState(
    prefs.codexBypassApprovalsAndSandbox ?? false
  );
  const [claudePermissionMode, setLocalClaudePermissionMode] = useState<ClaudePermissionMode>(
    prefs.claudePermissionMode ?? "acceptEdits"
  );
  const [claudeDangerouslySkipPermissions, setLocalClaudeDangerouslySkipPermissions] = useState(
    prefs.claudeDangerouslySkipPermissions ?? false
  );
  const [command, setCommand] = useState<CommandId | "">("");
  const [commandArguments, setCommandArguments] = useState("");
  const [commandExpanded, setCommandExpanded] = useState(false);
  const [scheduleExpanded, setScheduleExpanded] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMode, setSubmitMode] = useState<CreateLaunchTiming | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pendingPreviews, setPendingPreviews] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [resumeSessionId, setResumeSessionId] = useState<string | undefined>(undefined);

  const firstInputRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const screenshotInputRef = useRef<HTMLInputElement>(null);
  const runtimeTouchedRef = useRef(false);
  const codexReasoningTouchedRef = useRef(false);
  const codexSandboxTouchedRef = useRef(false);
  const codexBypassTouchedRef = useRef(false);
  const claudePermissionsTouchedRef = useRef(false);
  const [submitError, setSubmitError] = useState<{ title: string; message: string } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ title?: string; description?: string }>({});

  const { saveDirToHistory } = useDirectoryHistory();
  const {
    orderedRuntimes,
    displayedModels,
    getDefaultModelForRuntime,
    isModelAvailableForRuntime,
    persistRuntimeSelection,
    persistModelSelection,
  } = useRuntimeModelSelection(runtime, agentType);

  useEffect(() => {
    if (!prefs.runtime || runtimeTouchedRef.current) return;
    setRuntime(prefs.runtime);
  }, [prefs.runtime]);

  useEffect(() => {
    if (!prefs.claudePermissionMode || claudePermissionsTouchedRef.current) return;
    setLocalClaudePermissionMode(prefs.claudePermissionMode);
  }, [prefs.claudePermissionMode]);

  useEffect(() => {
    if (typeof prefs.claudeDangerouslySkipPermissions !== "boolean" || claudePermissionsTouchedRef.current) return;
    setLocalClaudeDangerouslySkipPermissions(prefs.claudeDangerouslySkipPermissions);
  }, [prefs.claudeDangerouslySkipPermissions]);

  useEffect(() => {
    if (typeof prefs.codexBypassApprovalsAndSandbox !== "boolean" || codexBypassTouchedRef.current) return;
    setLocalCodexBypassApprovalsAndSandbox(prefs.codexBypassApprovalsAndSandbox);
  }, [prefs.codexBypassApprovalsAndSandbox]);

  useEffect(() => {
    if (!prefs.codexReasoningEffort || codexReasoningTouchedRef.current) return;
    setCodexReasoningEffort(prefs.codexReasoningEffort);
  }, [prefs.codexReasoningEffort]);

  useEffect(() => {
    if (!prefs.codexSandbox || codexSandboxTouchedRef.current) return;
    setCodexSandbox(prefs.codexSandbox);
  }, [prefs.codexSandbox]);

  const filteredCommands = useMemo(() => getFilteredCommandsForRuntime(runtime), [runtime]);
  const scheduleValidation = useMemo(
    () => validateScheduleInputKst(scheduledAtInput, currentNow),
    [scheduledAtInput, currentNow],
  );
  const launchUiState = useMemo(
    () => deriveCreateLaunchUiState(launchTiming, queueAfterId),
    [launchTiming, queueAfterId],
  );
  const scheduleSelected = launchTiming === "schedule";
  const queueDisabled = scheduleSelected;
  const scheduleDisabled = Boolean(queueAfterId);

  const selectedCommandMeta = command ? getCommandHint(command) : undefined;
  const selectedCommandMode = selectedCommandMeta?.executionMode;
  const isCommandOnly = selectedCommandMode === 'command_only';
  const isCommandWithPrompt = selectedCommandMode === 'command_with_prompt';

  const commandArgumentPlaceholder = command
    ? getCommandHint(command)?.argumentPlaceholder || "No arguments required"
    : "e.g., --workers 3 --timeout 120";

  useEffect(() => {
    if (!command) {
      setCommandArguments("");
    }
  }, [command]);

  useEffect(() => {
    if (!isCommandAvailableForRuntime(command, runtime)) {
      setCommand("");
      setCommandArguments("");
    }
  }, [command, runtime]);

  useEffect(() => {
    if (isCommandOnly) {
      setDescription("");
    }
  }, [isCommandOnly]);

  useEffect(() => {
    if (model && isModelAvailableForRuntime(model, runtime, agentType)) return;
    const nextModel = getDefaultModelForRuntime(runtime, agentType);
    if (nextModel) setModel(nextModel);
  }, [agentType, getDefaultModelForRuntime, isModelAvailableForRuntime, model, runtime]);

  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setCurrentNow(new Date()), 30000);
    return () => clearInterval(timer);
  }, []);

  const clearFieldError = useCallback((field: 'title' | 'description') => {
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      return { ...prev, [field]: undefined };
    });
  }, []);

  const validateBeforeSubmit = useCallback(() => {
    const nextErrors: { title?: string; description?: string } = {};

    if (!title.trim()) {
      nextErrors.title = 'Add a short task title.';
    }

    if ((!command && !description.trim()) || (isCommandWithPrompt && !description.trim())) {
      nextErrors.description = 'Add the prompt details before creating this task.';
    }

    if (launchTiming === "schedule" && !scheduleValidation.scheduledAtUtc) {
      setSubmitError({
        title: 'Invalid schedule',
        message: scheduleValidation.error ?? 'Choose a future KST date/time before scheduling this task.',
      });
      return false;
    }

    if (nextErrors.title || nextErrors.description) {
      setFieldErrors(nextErrors);
      setSubmitError({
        title: 'Missing required information',
        message: 'Fill in the highlighted fields before creating or starting this task.',
      });

      if (nextErrors.title) {
        firstInputRef.current?.focus();
      } else if (nextErrors.description) {
        descriptionRef.current?.focus();
      }

      return false;
    }

    setFieldErrors({});
    setSubmitError(null);
    return true;
  }, [command, description, isCommandWithPrompt, launchTiming, scheduleValidation.error, scheduleValidation.scheduledAtUtc, title]);

  useEffect(() => {
    return () => {
      pendingPreviews.forEach((url) => {
        URL.revokeObjectURL(url);
      });
    };
  }, [pendingPreviews]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...files]);
    setPendingPreviews((prev) => [...prev, ...files.map((f) => URL.createObjectURL(f))]);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLElement>) => {
    const imageFiles = Array.from(e.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);

    // 이미지가 없으면 기본 동작(텍스트 붙여넣기)에 맡긴다.
    if (imageFiles.length === 0) return;

    e.preventDefault();
    setPendingFiles((prev) => [...prev, ...imageFiles]);
    setPendingPreviews((prev) => [...prev, ...imageFiles.map((file) => URL.createObjectURL(file))]);
  }, []);

  const handleScreenshotUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    setPendingFiles((prev) => [...prev, ...files]);
    setPendingPreviews((prev) => [...prev, ...files.map((file) => URL.createObjectURL(file))]);
    e.target.value = "";
  }, []);

  const handleClickDropZone = useCallback(() => {
    if (isSubmitting) return;
    screenshotInputRef.current?.click();
  }, [isSubmitting]);

  const handleDropZoneKeyDown = useCallback((e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClickDropZone();
    }
  }, [handleClickDropZone]);

  const handleRemovePending = useCallback((index: number) => {
    setPendingPreviews((prev) => {
      URL.revokeObjectURL(prev[index]);
      return prev.filter((_, i) => i !== index);
    });
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSubmit = async (mode: CreateLaunchTiming) => {
    if (!validateBeforeSubmit()) return;

    setIsSubmitting(true);
    setSubmitMode(mode);
    setSubmitError(null);
    const resolvedModel = model || getDefaultModelForRuntime(runtime, agentType);
    if (resolvedModel && resolvedModel !== model) {
      setModel(resolvedModel);
    }

    let newCard: KanbanCard;
    try {
      newCard = await onCreate({
        title,
        description: isCommandOnly ? '' : description,
        projectDir: projectDir.trim() || undefined,
        model: resolvedModel || undefined,
        agentRuntime: runtime,
        codexOptions: runtime === "codex" ? {
          reasoningEffort: codexReasoningEffort,
          sandbox: codexSandbox,
          skipGitRepoCheck: codexSkipGitRepoCheck,
          bypassApprovalsAndSandbox: codexBypassApprovalsAndSandbox,
        } : undefined,
        claudeOptions: runtime === "claude" ? {
          permissionMode: claudePermissionMode,
          dangerouslySkipPermissions: claudeDangerouslySkipPermissions,
        } : undefined,
        agentType: runtime === "opencode" ? agentType || undefined : undefined,
        command: command || undefined,
        arguments: commandArguments.trim() || undefined,
        resumeSessionId: resumeSessionId || undefined,
        scheduledDispatch: mode === "schedule" && scheduleValidation.scheduledAtUtc
          ? { scheduledAt: scheduleValidation.scheduledAtUtc }
          : undefined,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'The task could not be created.';
      setSubmitError({
        title: 'Task was not created',
        message,
      });
      onClearBoardError();
      setIsSubmitting(false);
      setSubmitMode(null);
      return;
    }

    saveDirToHistory(projectDir);

    const followUpIssues: string[] = [];

    if (pendingFiles.length > 0) {
      const failedUploads: string[] = [];
      setUploadProgress(`Uploading screenshots 0/${pendingFiles.length}...`);

      for (let i = 0; i < pendingFiles.length; i++) {
        setUploadProgress(`Uploading screenshots ${i + 1}/${pendingFiles.length}...`);
        try {
          await uploadScreenshot(newCard.id, pendingFiles[i]);
        } catch {
          failedUploads.push(pendingFiles[i]?.name || `image ${i + 1}`);
        }
      }

      setUploadProgress("");

      if (failedUploads.length > 0) {
        followUpIssues.push(
          failedUploads.length === 1
            ? `Screenshot upload failed for ${failedUploads[0]}. Add it again from the task details.`
            : `${failedUploads.length} screenshots failed to upload. Add them again from the task details.`
        );
      }
    }

    if (queueAfterId) {
      try {
        await onQueue(newCard.id, queueAfterId, queueSessionMode);
      } catch (err: unknown) {
        onClearBoardError();
        const message = err instanceof Error ? err.message : 'Queue setup failed.';
        followUpIssues.push(`Queue setup failed: ${message}`);
      }
    }

    setIsSubmitting(false);
    setSubmitMode(null);

    if (followUpIssues.length > 0) {
      onReportBoardAlert('Task created with follow-up issues', `The task was created successfully, but ${followUpIssues.join(' ')}`);
    }

    onClose();
  };

  const queueOptions = allCards
    .filter((c) => !c.parentCardId && (c.status === "in_progress" || c.status === "todo"))
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "in_progress" ? -1 : 1;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  const hasPendingScreenshots = pendingPreviews.length > 0;
  const promptRequired = !command || isCommandWithPrompt;
  const commandPanelId = "create-card-command-panel";
  const schedulePanelId = "create-card-schedule-panel";
  return (
    <DialogSkeleton onClose={onClose} width="860px" className="kv2-dialog--create kv2-dialog--status-todo" persistSizeKey="kanban-dialog-size-create">
      <div className="kv2-create-shell">
        <div className="kv2-create-header">
          <span className="kv2-create-header-title">+ New Task</span>
          <button type="button" className="kv2-dialog-close" onClick={onClose} aria-label="Close dialog">×</button>
        </div>

        <div className="kv2-create-body">
          {submitError && (
            <ErrorAlert
              variant="inline"
              className="kv2-create-alert"
              title={submitError.title}
              message={submitError.message}
              onDismiss={() => setSubmitError(null)}
            />
          )}

          <div className="kv2-create-field">
            <label className="kv2-create-label" htmlFor="create-card-title-input">Title *</label>
            <input
              id="create-card-title-input"
              ref={firstInputRef}
              className={`kv2-create-input${fieldErrors.title ? ' kv2-create-input--error' : ''}`}
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                clearFieldError('title');
              }}
              onPaste={handlePaste}
              placeholder="What needs to be done?"
              disabled={isSubmitting}
              aria-invalid={fieldErrors.title ? 'true' : 'false'}
              aria-describedby={fieldErrors.title ? 'create-card-title-error' : undefined}
            />
            {fieldErrors.title && (
              <span id="create-card-title-error" className="kv2-create-helper kv2-create-helper--error">
                {fieldErrors.title}
              </span>
            )}
          </div>

          <div className="kv2-create-field">
            <label className="kv2-create-label" htmlFor="create-card-description-input">Prompt {promptRequired ? '*' : '(ignored)'}</label>
            <textarea
              id="create-card-description-input"
              ref={descriptionRef}
              className={`kv2-create-textarea${isCommandOnly ? ' kv2-create-textarea--ignored' : ''}${fieldErrors.description ? ' kv2-create-textarea--error' : ''}`}
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
                clearFieldError('description');
              }}
              onPaste={handlePaste}
              placeholder={isCommandOnly
                ? 'Ignored for this command type'
                : 'Describe the task in detail. Be specific about requirements, constraints, and expected outcomes. (스크린샷은 붙여넣기로 첨부할 수 있습니다)'}
              rows={3}
              disabled={isSubmitting || isCommandOnly}
              aria-invalid={fieldErrors.description ? 'true' : 'false'}
              aria-describedby={fieldErrors.description ? 'create-card-description-error' : undefined}
            />
            {fieldErrors.description && (
              <span id="create-card-description-error" className="kv2-create-helper kv2-create-helper--error">
                {fieldErrors.description}
              </span>
            )}
            {isCommandOnly && (
              <span className="kv2-create-helper kv2-create-helper--warning">
                This command runs by itself. Any prompt text is ignored.
              </span>
            )}
            {isCommandWithPrompt && (
              <span className="kv2-create-helper">
                This command consumes the prompt as part of one command execution.
              </span>
            )}
          </div>

          <div className="kv2-create-field">
            <label className="kv2-create-label" htmlFor="create-card-directory-input">Directory</label>
            <DirectoryPicker
              id="create-card-directory-input"
              value={projectDir}
              onChange={setProjectDir}
              disabled={isSubmitting}
            />
            <span className="kv2-create-helper">Recent directories are saved in this browser after use.</span>
          </div>

          <RuntimeModelFields
            runtime={runtime}
            model={model}
            orderedRuntimes={orderedRuntimes}
            displayedModels={displayedModels}
            runtimeInputId="create-card-runtime-group"
            modelInputId="create-card-model-select"
            disabled={isSubmitting}
            selectorVariant="cards"
            onRuntimeChange={(nextRuntime) => {
              runtimeTouchedRef.current = true;
              setRuntime(nextRuntime);
              persistRuntimeSelection(nextRuntime);
              setModel(getDefaultModelForRuntime(nextRuntime, agentType));
            }}
            onModelChange={(nextModel) => {
              setModel(nextModel);
              if (nextModel) {
                persistModelSelection(runtime, nextModel, agentType);
              }
            }}
          />

          {runtime === "opencode" && (
          <div className="kv2-create-field">
            <div className="kv2-create-label">Agent</div>
            <div className="kv2-create-agent-row">
              {AGENT_CONFIGS.map((agent) => (
                <button
                  key={agent.key}
                  type="button"
                  className={`kv2-create-agent-chip ${agentType === agent.key ? "kv2-create-agent-chip--active" : ""}`}
                  onClick={() => {
                    setAgentType(agent.key);
                    setModel(getDefaultModelForRuntime("opencode", agent.key));
                  }}
                  disabled={isSubmitting}
                >
                  {agent.emoji} {agent.label}
                </button>
              ))}
            </div>
          </div>
          )}

          {runtime === "codex" && (
            <div className="kv2-create-field">
              <div className="kv2-create-label">Codex Options</div>
              <div className="kv2-create-input-row">
                <select
                  className="kv2-create-select"
                  value={codexReasoningEffort}
                  onChange={(e) => {
                    const value = e.target.value as CodexReasoningEffort;
                    codexReasoningTouchedRef.current = true;
                    setCodexReasoningEffort(value);
                    saveCodexReasoningEffortDefault(value);
                  }}
                  disabled={isSubmitting}
                  aria-label="Codex reasoning effort"
                >
                  <option value="low">Reasoning: low</option>
                  <option value="medium">Reasoning: medium</option>
                  <option value="high">Reasoning: high</option>
                  <option value="xhigh">Reasoning: xhigh</option>
                </select>
                <select
                  className="kv2-create-select"
                  value={codexSandbox}
                  onChange={(e) => {
                    const value = e.target.value as CodexSandboxMode;
                    codexSandboxTouchedRef.current = true;
                    setCodexSandbox(value);
                    saveCodexSandboxDefault(value);
                  }}
                  disabled={isSubmitting}
                  aria-label="Codex sandbox"
                >
                  <option value="read-only">Sandbox: read-only</option>
                  <option value="workspace-write">Sandbox: workspace-write</option>
                  <option value="danger-full-access">Sandbox: danger-full-access</option>
                </select>
              </div>
              <label className="kv2-create-radio-label">
                <input
                  type="checkbox"
                  checked={codexSkipGitRepoCheck}
                  onChange={(e) => setCodexSkipGitRepoCheck(e.target.checked)}
                  disabled={isSubmitting}
                />
                <div>
                  <div className="kv2-create-radio-title">Skip git repo check</div>
                </div>
              </label>
              <label className="kv2-create-radio-label">
                <input
                  type="checkbox"
                  checked={codexBypassApprovalsAndSandbox}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    codexBypassTouchedRef.current = true;
                    setLocalCodexBypassApprovalsAndSandbox(checked);
                    setCodexBypassApprovalsAndSandbox(checked);
                  }}
                  disabled={isSubmitting}
                />
                <div>
                  <div className="kv2-create-radio-title">Bypass approvals and sandbox</div>
                </div>
              </label>
            </div>
          )}

          {runtime === "claude" && (
            <div className="kv2-create-field">
              <div className="kv2-create-label">Claude Permissions</div>
              <div className="kv2-create-input-row">
                <select
                  className="kv2-create-select"
                  value={claudePermissionMode}
                  onChange={(e) => {
                    const value = e.target.value as ClaudePermissionMode;
                    claudePermissionsTouchedRef.current = true;
                    setLocalClaudePermissionMode(value);
                    setClaudePermissionMode(value);
                  }}
                  disabled={isSubmitting || claudeDangerouslySkipPermissions}
                >
                  <option value="acceptEdits">Accept edits</option>
                  <option value="bypassPermissions">Bypass permissions</option>
                  <option value="plan">Plan</option>
                  <option value="dontAsk">Do not ask</option>
                </select>
              </div>
              <label className="kv2-create-radio-label">
                <input
                  type="checkbox"
                  checked={claudeDangerouslySkipPermissions}
                  onChange={(e) => {
                    claudePermissionsTouchedRef.current = true;
                    setLocalClaudeDangerouslySkipPermissions(e.target.checked);
                    setClaudeDangerouslySkipPermissions(e.target.checked);
                  }}
                  disabled={isSubmitting}
                />
                <div>
                  <div className="kv2-create-radio-title">Dangerously skip permissions</div>
                </div>
              </label>
            </div>
          )}

          <div className="kv2-create-field kv2-create-field--command">
            <button
              type="button"
              id="create-card-command-label"
              className={`kv2-create-command-toggle${commandExpanded ? " is-open" : ""}`}
              aria-expanded={commandExpanded}
              aria-controls={commandPanelId}
              onClick={() => setCommandExpanded((current) => !current)}
              disabled={isSubmitting}
            >
              <span className="kv2-create-command-toggle-main">
                <span>Command</span>
                {command && <span className="kv2-create-command-value">/{command}</span>}
              </span>
              <span className="kv2-chevron" aria-hidden="true">▼</span>
            </button>
            <div className="kv2-session-helper">필요할 때만 command를 선택해 실행 방식을 지정합니다.</div>

            {commandExpanded && (
              <div id={commandPanelId} className="kv2-create-command-panel">
                <CommandPicker
                  id="create-card-command-picker"
                  runtime={runtime}
                  value={command}
                  commands={filteredCommands}
                  onChange={setCommand}
                  disabled={isSubmitting}
                  autoOpen
                />

                {command && (
                  <div className="kv2-create-field kv2-create-command-arguments">
                    <label className="kv2-create-label" htmlFor="create-card-arguments-input">Command 파라미터</label>
                    <input
                      id="create-card-arguments-input"
                      className="kv2-create-input"
                      value={commandArguments}
                      onChange={(e) => setCommandArguments(e.target.value)}
                      placeholder={commandArgumentPlaceholder}
                      disabled={isSubmitting}
                    />
                    <span className="kv2-create-helper">선택한 command에 전달할 추가 파라미터입니다.</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="kv2-create-field kv2-create-field--command">
            <button
              type="button"
              id="create-card-schedule-label"
              className={`kv2-create-command-toggle${scheduleExpanded ? " is-open" : ""}`}
              aria-expanded={scheduleExpanded}
              aria-controls={schedulePanelId}
              onClick={() => setScheduleExpanded((current) => !current)}
              disabled={isSubmitting}
            >
              <span className="kv2-create-command-toggle-main">
                <span>Schedule</span>
              </span>
              <span className="kv2-chevron" aria-hidden="true">▼</span>
            </button>
            <div className="kv2-session-helper">설정한 KST 시각에 이 작업을 한 번 자동으로 시작합니다.</div>
            {scheduleExpanded && (
              <div id={schedulePanelId} className="kv2-create-command-panel">
                <div className="kv2-create-launch-grid kv2-create-launch-grid--single">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={launchTiming === "schedule"}
                    className={`kv2-create-launch-option${launchTiming === "schedule" ? " kv2-create-launch-option--active" : ""}`}
                    onClick={() => setLaunchTiming((current) => current === "schedule" ? "later" : "schedule")}
                    disabled={isSubmitting || scheduleDisabled}
                    aria-describedby={scheduleDisabled ? "create-card-schedule-disabled-reason" : undefined}
                  >
                    <span className="kv2-create-launch-option-copy">
                      <span className="kv2-create-launch-option-title">예약 시작</span>
                      <span className="kv2-create-launch-option-desc">
                        {scheduleSelected
                          ? "설정한 KST 시각에 한 번 자동 dispatch합니다."
                          : "사용하지 않으면 todo 상태로만 생성합니다."}
                      </span>
                    </span>
                    <span className="kv2-create-launch-switch" aria-hidden="true">
                      <span className="kv2-create-launch-switch-knob" />
                    </span>
                  </button>
                </div>
                {launchUiState.scheduleDisabledReason && (
                  <div
                    id="create-card-schedule-disabled-reason"
                    className="kv2-session-helper kv2-session-helper--warn"
                    role="note"
                  >
                    {launchUiState.scheduleDisabledReason}
                  </div>
                )}
                {scheduleSelected && (
                  <div className="kv2-session-config-card">
                    <ScheduledDispatchEditor
                      currentNow={currentNow}
                      inputId="create-card-schedule-datetime"
                      noteLabel="현재 KST보다 미래인 시각만 예약할 수 있습니다."
                      value={scheduledAtInput}
                      onChange={setScheduledAtInput}
                      disabled={isSubmitting}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="kv2-create-field">
            <button
              type="button"
              id="create-card-queue-label"
              className="kv2-session-title"
              style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
              aria-expanded={queueExpanded || Boolean(queueAfterId)}
              onClick={() => setQueueExpanded((current) => !current)}
              disabled={queueDisabled}
              aria-describedby={queueDisabled ? "create-card-queue-disabled-reason" : undefined}
            >
              Queue After
              <span
                className="kv2-chevron"
                style={{ transform: queueExpanded || queueAfterId ? 'rotate(0deg)' : 'rotate(-90deg)' }}
              >
                ▼
              </span>
            </button>
            <div className="kv2-session-helper">선택한 작업이 끝난 뒤 이 작업을 이어서 시작합니다.</div>
            {launchUiState.queueDisabledReason && (
              <div
                id="create-card-queue-disabled-reason"
                className="kv2-session-helper kv2-session-helper--warn"
                role="note"
              >
                {launchUiState.queueDisabledReason}
              </div>
            )}

            {(queueExpanded || queueAfterId) && (
              <div className="kv2-session-config-card">
                <QueueTargetList
                  value={queueAfterId}
                  options={queueOptions}
                  onChange={setQueueAfterId}
                  disabled={isSubmitting || queueDisabled}
                />

                {queueAfterId && (
                  <QueueSessionModePicker
                    value={queueSessionMode}
                    onChange={setQueueSessionMode}
                    disabled={isSubmitting || queueDisabled}
                  />
                )}
              </div>
            )}
          </div>

          <div className="kv2-create-field">
            <SessionPickerPanel
              layout="embedded"
              resumeSessionId={resumeSessionId}
              onSessionChange={setResumeSessionId}
              onSelectSession={() => {}}
              onClearSession={() => {}}
            />
          </div>

          <div className="kv2-create-field">
            <div className="kv2-create-label">Screenshots</div>

            {hasPendingScreenshots ? (
              <div
                role="button"
                tabIndex={isSubmitting ? -1 : 0}
                aria-disabled={isSubmitting}
                className={`kv2-screenshot-grid kv2-screenshot-grid--create kv2-screenshot-grid--upload-target${isDragging ? ' kv2-screenshot-grid--dragging' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClickDropZone}
                onKeyDown={handleDropZoneKeyDown}
              >
                {isDragging && <span className="kv2-screenshot-drop-hint">이미지를 놓으면 추가됩니다.</span>}
                {pendingPreviews.map((url, idx) => (
                  <div key={url} className="kv2-screenshot-card">
                    <img src={url} alt={pendingFiles[idx]?.name} className="kv2-screenshot-img" />
                    <button
                      type="button"
                      className="kv2-screenshot-delete"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleRemovePending(idx);
                      }}
                      title="Remove"
                      disabled={isSubmitting}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <button
                type="button"
                className={`kv2-create-drop-zone kv2-screenshot-grid--upload-target${isDragging ? ' kv2-create-drop-zone--dragging kv2-screenshot-grid--dragging' : ''}`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onClick={handleClickDropZone}
                onKeyDown={handleDropZoneKeyDown}
                disabled={isSubmitting}
              >
                {isDragging ? '이미지를 놓으면 추가됩니다.' : 'Click or drop screenshots'}
              </button>
            )}

            <input
              ref={screenshotInputRef}
              id="create-card-screenshot-upload"
              type="file"
              accept="image/*"
              multiple
              onChange={handleScreenshotUpload}
              disabled={isSubmitting}
              style={{ display: "none" }}
            />

            {uploadProgress && <div className="kv2-create-upload-progress">{uploadProgress}</div>}
          </div>
        </div>

        <div className="kv2-detail-divider" />

        {isSubmitting && (
          <div className="kv2-create-progress" role="status" aria-live="polite">
            <div className="kv2-create-progress-track">
              <div className="kv2-create-progress-indicator" />
            </div>
            <span className="kv2-create-progress-label">
              {uploadProgress
                || (submitMode === 'schedule'
                    ? 'Creating task & saving schedule…'
                    : 'Creating task…')}
            </span>
          </div>
        )}

        <div className="kv2-create-footer">
          <button
            type="button"
            className="kv2-btn kv2-btn--outline"
            onClick={onClose}
            disabled={isSubmitting}
          >
            Cancel
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            onClick={() => handleSubmit(launchTiming)}
            disabled={isSubmitting || (scheduleSelected && !scheduleValidation.scheduledAtUtc)}
            aria-busy={isSubmitting && submitMode === launchTiming}
          >
            {isSubmitting && submitMode === launchTiming ? (
              <>
                <span className="kv2-action-spinner" aria-hidden="true" />
                {launchTiming === "schedule"
                    ? " Scheduling…"
                    : " Creating…"}
              </>
            ) : (
              launchUiState.primaryActionLabel
            )}
          </button>
        </div>
      </div>
    </DialogSkeleton>
  );
};
