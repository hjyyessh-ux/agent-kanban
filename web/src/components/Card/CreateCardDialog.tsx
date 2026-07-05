import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { fetchModels, uploadScreenshot, type ModelInfo } from "../../hooks/useKanbanApi";
import { KanbanCard, CreateCardInput, QueueSessionMode, AgentRuntime, ClaudePermissionMode, CodexReasoningEffort, CodexSandboxMode } from "../../../../src/core/types";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from "../../../../src/core/runtime-config";
import { useRuntimes } from "../../hooks/useRuntimes";
import { readEnabledSet, isModelVisible } from "../../hooks/useModelCatalog";
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
import { RuntimeBadgeIcon } from "../Board/BoardCardSections";

const AGENT_MODEL_PREFERENCE_KEY = "kanban-agent-model-preference";
const CREATE_RUNTIME_ORDER: AgentRuntime[] = ["codex", "claude", "opencode"];

function getFallbackModelForAgent(agentKey: string, availableModels: ModelInfo[]): string {
  if (availableModels.length === 0) return "";

  const configuredDefault = AGENT_CONFIGS.find((agent) => agent.key === agentKey)?.model;
  if (configuredDefault && availableModels.some((model) => model.id === configuredDefault)) {
    return configuredDefault;
  }

  if (agentKey === "atlas") {
    const atlasLike = availableModels.find((model) =>
      /sonnet|executor/i.test(`${model.id} ${model.name}`)
    );
    if (atlasLike) return atlasLike.id;
  }

  const generalDefault = availableModels.find((model) =>
    /gpt-5\.4|opus|claude/i.test(`${model.id} ${model.name}`)
  );
  if (generalDefault) return generalDefault.id;

  return availableModels[0]?.id ?? "";
}

function readAgentModelPreference(): Record<string, string> {
  try {
    const raw = localStorage.getItem(AGENT_MODEL_PREFERENCE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return Object.entries(parsed).reduce<Record<string, string>>((acc, [key, value]) => {
        if (typeof value === "string" && value.trim()) acc[key] = value;
        return acc;
      }, {});
    }
  } catch {
    return {};
  }
  return {};
}

function writeAgentModelPreference(agentKey: string, modelId: string): void {
  if (!agentKey || !modelId) return;
  const current = readAgentModelPreference();
  current[agentKey] = modelId;
  try {
    localStorage.setItem(AGENT_MODEL_PREFERENCE_KEY, JSON.stringify(current));
  } catch {
    return;
  }
}

interface CreateCardDialogProps {
  allCards: KanbanCard[];
  onClose: () => void;
  onCreate: (input: CreateCardInput) => Promise<KanbanCard>;
  onDispatch: (id: string) => Promise<void>;
  onQueue: (
    cardId: string,
    afterCardId: string,
    sessionMode: QueueSessionMode
  ) => Promise<KanbanCard>;
  onClearBoardError: () => void;
  onReportBoardAlert: (title: string, message: string) => void;
}

const DEFAULT_QUEUE_SESSION_MODE: QueueSessionMode = "new_session";

export const CreateCardDialog: React.FC<CreateCardDialogProps> = ({
  allCards,
  onClose,
  onCreate,
  onDispatch,
  onQueue,
  onClearBoardError,
  onReportBoardAlert,
}) => {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [queueAfterId, setQueueAfterId] = useState("");
  const [queueSessionMode, setQueueSessionMode] = useState<QueueSessionMode>(
    DEFAULT_QUEUE_SESSION_MODE
  );
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [agentType, setAgentType] = useState("sisyphus");
  const { runtimes } = useRuntimes();
  const {
    prefs,
    setDefault,
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
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitMode, setSubmitMode] = useState<'create' | 'start' | null>(null);
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

  useEffect(() => {
    fetchModels()
      .then(setModels)
      .catch(() => setModels([]));
  }, []);

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

  const filteredModels = useMemo(() => {
    try {
      const stored = localStorage.getItem("kanban-enabled-models");
      if (stored) {
        const enabledIds = new Set<string>(JSON.parse(stored));
        return models.filter((m) => enabledIds.has(m.id));
      }
    } catch {
      return models;
    }
    return models;
  }, [models]);

  const filteredCommands = useMemo(() => getFilteredCommandsForRuntime(runtime), [runtime]);

  const claudeModels = useMemo(
    () => runtimes.find((entry) => entry.runtime === "claude")?.models ?? [],
    [runtimes],
  );
  const codexModels = useMemo(
    () => runtimes.find((entry) => entry.runtime === "codex")?.models ?? [],
    [runtimes],
  );
  const orderedRuntimes = useMemo(
    () => [...runtimes].sort((a, b) => {
      const aIndex = CREATE_RUNTIME_ORDER.indexOf(a.runtime);
      const bIndex = CREATE_RUNTIME_ORDER.indexOf(b.runtime);
      return (aIndex === -1 ? CREATE_RUNTIME_ORDER.length : aIndex)
        - (bIndex === -1 ? CREATE_RUNTIME_ORDER.length : bIndex);
    }),
    [runtimes],
  );

  const displayedModels = useMemo(() => {
    const enabled = readEnabledSet();
    if (runtime === "codex") {
      return codexModels
        .filter((m) => isModelVisible(m.id, enabled))
        .map((m) => ({
          id: m.id,
          label: `${m.label}${m.tier ? ` (${m.tier})` : ""}`,
        }));
    }
    if (runtime === "claude") {
      return claudeModels
        .filter((m) => isModelVisible(m.id, enabled))
        .map((m) => ({
          id: m.id,
          label: `${m.label}${m.tier ? ` (${m.tier})` : ""}`,
        }));
    }
    return filteredModels.map((m) => ({
      id: m.id,
      label: `${m.name} (${m.providerName})`,
    }));
  }, [claudeModels, codexModels, filteredModels, runtime]);

  const resolveModelForRuntime = () => {
    if (model) return model;

    if (runtime === "codex") {
      return prefs.codex && codexModels.some((m) => m.id === prefs.codex)
        ? prefs.codex
        : codexModels[0]?.id ?? DEFAULT_CODEX_MODEL;
    }

    if (runtime === "claude") {
      return prefs.claude && claudeModels.some((m) => m.id === prefs.claude)
        ? prefs.claude
        : claudeModels[0]?.id ?? DEFAULT_CLAUDE_MODEL;
    }

    const preferred = readAgentModelPreference()[agentType];
    return preferred && filteredModels.some((m) => m.id === preferred)
      ? preferred
      : getFallbackModelForAgent(agentType, filteredModels);
  };

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
    if (!agentType || filteredModels.length === 0 || model) return;
    const preferred = readAgentModelPreference()[agentType];
    if (preferred && filteredModels.some((m) => m.id === preferred)) {
      setModel(preferred);
      return;
    }
    const fallback = getFallbackModelForAgent(agentType, filteredModels);
    if (fallback) setModel(fallback);
  }, [agentType, model, filteredModels]);

  useEffect(() => {
    if (runtime !== "codex") return;
    if (model && codexModels.some((m) => m.id === model)) return;
    const nextModel = prefs.codex && codexModels.some((m) => m.id === prefs.codex)
      ? prefs.codex
      : codexModels[0]?.id ?? DEFAULT_CODEX_MODEL;
    setModel(nextModel);
  }, [codexModels, model, prefs.codex, runtime]);

  useEffect(() => {
    if (runtime !== "claude") return;
    if (model && claudeModels.some((m) => m.id === model)) return;
    const nextModel = prefs.claude && claudeModels.some((m) => m.id === prefs.claude)
      ? prefs.claude
      : claudeModels[0]?.id ?? DEFAULT_CLAUDE_MODEL;
    setModel(nextModel);
  }, [claudeModels, model, prefs.claude, runtime]);

  useEffect(() => {
    firstInputRef.current?.focus();
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
  }, [command, description, isCommandWithPrompt, title]);

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

  const handleSubmit = async (shouldDispatch: boolean) => {
    if (!validateBeforeSubmit()) return;

    setIsSubmitting(true);
    setSubmitMode(shouldDispatch ? 'start' : 'create');
    setSubmitError(null);
    const resolvedModel = resolveModelForRuntime();
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

    if (shouldDispatch) {
      try {
        await onDispatch(newCard.id);
      } catch (err: unknown) {
        onClearBoardError();
        const message = err instanceof Error ? err.message : 'Start failed.';
        followUpIssues.push(`Start failed: ${message}`);
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

          <div className="kv2-create-field">
            <div className="kv2-create-label">Runtime</div>
            <div className="kv2-create-agent-row">
              {orderedRuntimes.map((entry) => {
                const unavailable = entry.disabled || entry.available === false;
                return (
                  <button
                    key={entry.runtime}
                    type="button"
                    className={`kv2-create-agent-chip kv2-create-agent-chip--runtime-${entry.runtime} ${runtime === entry.runtime ? "kv2-create-agent-chip--active" : ""} ${unavailable ? "kv2-create-agent-chip--unavailable" : ""}`}
                    onClick={() => {
                      if (unavailable) return;
                      runtimeTouchedRef.current = true;
                      setRuntime(entry.runtime);
                      setDefault("runtime", entry.runtime);
                      if (entry.runtime === "claude") {
                        const preferred = prefs.claude;
                        const nextModel = preferred && entry.models?.some((m) => m.id === preferred)
                          ? preferred
                          : entry.models?.[0]?.id ?? DEFAULT_CLAUDE_MODEL;
                        setModel(nextModel);
                      } else if (entry.runtime === "codex") {
                        const preferred = prefs.codex;
                        const nextModel = preferred && entry.models?.some((m) => m.id === preferred)
                          ? preferred
                          : entry.models?.[0]?.id ?? DEFAULT_CODEX_MODEL;
                        setModel(nextModel);
                      } else if (entry.runtime === "opencode") {
                        const preferred = readAgentModelPreference()[agentType];
                        setModel(preferred && filteredModels.some((m) => m.id === preferred)
                          ? preferred
                          : getFallbackModelForAgent(agentType, filteredModels));
                      }
                    }}
                    disabled={isSubmitting || unavailable}
                    title={entry.unavailableReason}
                  >
                    <span className={`kv2-create-agent-chip-icon kv2-create-agent-chip-icon--${entry.runtime}`} aria-hidden="true">
                      <RuntimeBadgeIcon runtime={entry.runtime} />
                    </span>
                    <span className="kv2-create-agent-chip-label">{entry.label}</span>
                    {unavailable && <span className="kv2-create-agent-chip-badge">Unavailable</span>}
                  </button>
                );
              })}
            </div>
          </div>

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
                    const preferred = readAgentModelPreference()[agent.key];
                    if (preferred && filteredModels.some((m) => m.id === preferred)) {
                      setModel(preferred);
                      return;
                    }
                    setModel(getFallbackModelForAgent(agent.key, filteredModels));
                  }}
                  disabled={isSubmitting}
                >
                  {agent.emoji} {agent.label}
                </button>
              ))}
            </div>
          </div>
          )}

          <div className="kv2-create-field">
            <label className="kv2-create-label" htmlFor="create-card-model-select">Model</label>
            <select
              id="create-card-model-select"
              className="kv2-create-select"
              value={model}
              onChange={(e) => {
                const selected = e.target.value;
                setModel(selected);
                if (runtime === "opencode" && selected) writeAgentModelPreference(agentType, selected);
                if (runtime === "codex" && selected) setDefault("codex", selected);
                if (runtime === "claude" && selected) setDefault("claude", selected);
              }}
              disabled={isSubmitting}
            >
              <option value="">-- Default model --</option>
              {displayedModels.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

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

          <div className="kv2-create-field">
            <button
              type="button"
              id="create-card-queue-label"
              className="kv2-session-title"
              style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
              aria-expanded={queueExpanded || Boolean(queueAfterId)}
              onClick={() => setQueueExpanded((current) => !current)}
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

            {(queueExpanded || queueAfterId) && (
              <div className="kv2-session-config-card">
                <QueueTargetList
                  value={queueAfterId}
                  options={queueOptions}
                  onChange={setQueueAfterId}
                  disabled={isSubmitting}
                />

                {queueAfterId && (
                  <QueueSessionModePicker
                    value={queueSessionMode}
                    onChange={setQueueSessionMode}
                    disabled={isSubmitting}
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
                || (submitMode === 'start'
                  ? 'Creating task & starting agent…'
                  : 'Creating task…')}
            </span>
          </div>
        )}

        <div className="kv2-create-footer">
          <button
            type="button"
            className="kv2-btn kv2-btn--outline"
            onClick={() => handleSubmit(false)}
            disabled={isSubmitting}
            aria-busy={isSubmitting && submitMode === 'create'}
          >
            {isSubmitting && submitMode === 'create' ? (
              <>
                <span className="kv2-action-spinner" aria-hidden="true" /> Creating…
              </>
            ) : (
              'CREATE'
            )}
          </button>
          <button
            type="button"
            className="kv2-btn kv2-btn--primary"
            onClick={() => handleSubmit(true)}
            disabled={isSubmitting}
            aria-busy={isSubmitting && submitMode === 'start'}
          >
            {isSubmitting && submitMode === 'start' ? (
              <>
                <span className="kv2-action-spinner" aria-hidden="true" /> Starting…
              </>
            ) : (
              'CREATE & START'
            )}
          </button>
        </div>
      </div>
    </DialogSkeleton>
  );
};
