import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  KanbanCard,
  KanbanStatus,
  QueueSessionMode,
  UpdateCardInput,
  Screenshot,
  AgentRuntime,
} from "../../../../src/core/types";
import { QuestionRequest } from "../../hooks/useQuestionsApi";
import { fetchModels, ModelInfo, uploadScreenshot } from "../../hooks/useKanbanApi";
import { useRuntimes } from "../../hooks/useRuntimes";
import { readEnabledSet, isModelVisible } from "../../hooks/useModelCatalog";
import {
  DEFAULT_CLAUDE_MODEL,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from "../../../../src/core/runtime-config";
import { useRuntimeDefaults } from "../../hooks/useRuntimeDefaults";
import { useCardProgress } from "../../hooks/useCardProgress";
import { DialogSkeleton } from "./DialogSkeleton";
import { CardMetaPanel, CommandMetaRow, EditingField } from "./CardMetaPanel";
import { CardPhases } from "./CardPhases";
import { QueueSettingsPanel } from "./QueueSettingsPanel";
import { SessionPickerPanel } from "./SessionPickerPanel";
import { ScreenshotPanel } from "./ScreenshotPanel";
import { QuestionPanel } from "./QuestionPanel";
import { FeedbackPanel } from "./FeedbackPanel";
import { formatAgentTypeLabel } from "../../utils/agent-label";
import { formatDuration } from "../../utils/format-duration";
import { getAgentConfig } from "../../constants/agents";
import { FavoriteToggleButton, formatRuntimeLabel, TelegramBadge } from "../Board/BoardCardSections";
import { buildResumeCommand } from "../../utils/resume-command";

const AGENT_ROW_COLORS: Record<string, { border: string; bg: string }> = {
  explore:              { border: "var(--kv2-agent-explore)", bg: "var(--kv2-info-surface-pale)" },
  sisyphus:             { border: "var(--kv2-agent-sisyphus-junior)", bg: "var(--kv2-info-surface)" },
  "sisyphus-junior":    { border: "var(--kv2-agent-sisyphus-junior)", bg: "var(--kv2-info-surface)" },
  oracle:               { border: "var(--kv2-purple-accent)", bg: "var(--kv2-purple-surface)" },
  librarian:            { border: "var(--kv2-agent-librarian)", bg: "var(--kv2-purple-surface-faint)" },
  atlas:                { border: "var(--kv2-success-accent-deep)", bg: "var(--kv2-success-surface-faint)" },
  plan:                 { border: "var(--kv2-teal-accent-deep)", bg: "var(--kv2-teal-surface)" },
  metis:                { border: "var(--kv2-warn-accent)", bg: "var(--kv2-warn-surface-pale)" },
  momus:                { border: "var(--kv2-danger-accent)", bg: "var(--kv2-danger-surface)" },
  "multimodal-looker":  { border: "var(--kv2-teal-text-deep)", bg: "var(--kv2-teal-surface)" },
  hephaestus:           { border: "var(--kv2-orange-accent)", bg: "var(--kv2-orange-surface-soft)" },
  prometheus:           { border: "var(--kv2-pink-accent-bright)", bg: "var(--kv2-pink-surface-pale)" },
};

function getChildRowStyle(agentType?: string): { border: string; bg: string } {
  if (!agentType) return { border: "var(--kv2-neutral-400)", bg: "var(--kv2-surface-sunken)" };
  const key = agentType.trim().toLowerCase().replace(/\s*\(.*\)/, "");
  const match = AGENT_ROW_COLORS[key];
  if (match) return match;
  // fallback: use getAgentConfig color with fixed tint
  const cfg = getAgentConfig(agentType);
  if (cfg?.color) return { border: cfg.color, bg: "var(--kv2-surface-sunken)" };
  return { border: "var(--kv2-neutral-400)", bg: "var(--kv2-surface-sunken)" };
}

const AGENT_MODEL_PREFERENCE_KEY = "kanban-agent-model-preference";

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

const DEFAULT_QUEUE_SESSION_MODE: QueueSessionMode = "new_session";
const DEFAULT_COLLAPSED_PHASES: Record<string, boolean> = {
  prompt: true,
  progress: true,
  result: true,
  question: true,
  runmeta: true,
};

function getDefaultCollapsedPhases(card: Pick<KanbanCard, "status" | "result">): Record<string, boolean> {
  return {
    ...DEFAULT_COLLAPSED_PHASES,
    // Prompt is always shown (expanded) by default in every status.
    prompt: false,
    result: !!card.result && (card.status === "complete" || card.status === "done") ? false : DEFAULT_COLLAPSED_PHASES.result,
  };
}

function getQueueSessionModeSummary(mode?: QueueSessionMode): {
  title: string;
  description: string;
} {
  if (mode === "continue_queued_after_session") {
    return {
      title: "Continue After Session",
      description: "앞 카드의 세션에서 이어갑니다.",
    };
  }

  return {
    title: "New Session",
    description: "새 세션으로 시작합니다.",
  };
}

export interface CardDetailDialogProps {
  card: KanbanCard;
  allCards?: KanbanCard[];
  onClose: () => void;
  onStatusChange: (id: string, status: KanbanStatus) => Promise<boolean> | boolean;
  onDelete: (id: string) => Promise<boolean> | boolean;
  onToggleFavorite?: (id: string) => Promise<boolean> | boolean;
  onDispatch?: (id: string) => Promise<boolean> | boolean;
  onNavigateToCard?: (card: KanbanCard) => void;
  onQueue?: (
    cardId: string,
    afterCardId: string,
    sessionMode: QueueSessionMode
  ) => Promise<KanbanCard> | void;
  onUnqueue?: (cardId: string) => Promise<KanbanCard> | void;
  onSetResumeSession?: (cardId: string, sessionId: string) => Promise<void>;
  onClearResumeSession?: (cardId: string) => Promise<void>;
  onUpdate?: (id: string, updates: UpdateCardInput) => void;
  onCreateFeedback?: (cardId: string, feedback: string, shouldDispatch: boolean, screenshots?: File[]) => Promise<void>;
  onScreenshotUploaded?: (screenshot: Screenshot) => void;
  onScreenshotDeleted?: (screenshotId: string) => void;
  question?: QuestionRequest;
  onAnswerQuestion?: (questionId: string, answers: string[][]) => Promise<void>;
  onRejectQuestion?: (questionId: string) => Promise<void>;
}

export const CardDetailDialog: React.FC<CardDetailDialogProps> = ({
  card,
  allCards,
  onClose,
  onStatusChange,
  onDelete,
  onToggleFavorite,
  onDispatch,
  onNavigateToCard,
  onQueue,
  onUnqueue,
  onSetResumeSession,
  onClearResumeSession,
  onUpdate,
  onCreateFeedback,
  onScreenshotUploaded,
  onScreenshotDeleted,
  question,
  onAnswerQuestion,
  onRejectQuestion,
}) => {
  const [collapsedPhases, setCollapsedPhases] = useState<Record<string, boolean>>(() => getDefaultCollapsedPhases(card));
  const [editingField, setEditingField] = useState<EditingField>(null);
  const [editValue, setEditValue] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [copiedResumeCommand, setCopiedResumeCommand] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [queueTargetId, setQueueTargetId] = useState("");
  const [queueSessionMode, setQueueSessionMode] = useState<QueueSessionMode>(
    card.queueSessionMode ?? DEFAULT_QUEUE_SESSION_MODE
  );
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const { runtimes } = useRuntimes();
  const { prefs } = useRuntimeDefaults();

  const editInputRef = useRef<HTMLInputElement>(null);
  const activeCardIdRef = useRef(card.id);

  const isTodo = card.status === "todo";
  const runProgress = useCardProgress(card.id, card.status === "in_progress");
  const canEdit = !!onUpdate;
  const cardRuntime = card.agentRuntime ?? "opencode";
  const resumeCommand = card.sessionId
    ? buildResumeCommand(cardRuntime, card.sessionId, card.projectDir)
    : null;
  const queueModeSummary = getQueueSessionModeSummary(card.queueSessionMode);
  const createdLabel = new Date(card.createdAt).toLocaleString();
  const updatedLabel = new Date(card.updatedAt).toLocaleString();
  const startedLabel = card.startedAt ? new Date(card.startedAt).toLocaleString() : null;
  const completedLabel = card.completedAt ? new Date(card.completedAt).toLocaleString() : null;
  const durationLabel = typeof card.durationMs === "number"
    ? formatDuration(card.durationMs)
    : (card.startedAt && card.completedAt
        ? formatDuration(new Date(card.completedAt).getTime() - new Date(card.startedAt).getTime())
        : null);
  const telegramMetaLabel = card.originChannel === "telegram"
    ? [
        card.telegramMessageId ? `Message ${card.telegramMessageId}` : null,
        `Reply ${card.telegramReplyStatus ?? 'pending'}${typeof card.telegramReplyMessageId === 'number' ? ` (#${card.telegramReplyMessageId})` : ''}`,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;

  useEffect(() => {
    if (isTodo && canEdit && cardRuntime === "opencode") {
      fetchModels()
        .then(setModels)
        .catch(() => setModels([]));
    }
  }, [isTodo, canEdit, cardRuntime]);

  useEffect(() => {
    activeCardIdRef.current = card.id;
    setCollapsedPhases(getDefaultCollapsedPhases(card));
    setEditingField(null);
    setEditValue("");
    setCopiedId(null);
    setCopiedResumeCommand(null);
    setQueueTargetId("");
    setQueueSessionMode(card.queueSessionMode ?? DEFAULT_QUEUE_SESSION_MODE);
    setIsSubmittingFeedback(false);
  }, [card.id, card.queueSessionMode, card.result, card.status]);

  useEffect(() => {
    if (editingField === "title") {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingField]);

  const filteredModels = React.useMemo(() => {
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

  const runtimeModelOptions = React.useMemo<ModelInfo[]>(() => {
    if (cardRuntime === "opencode") return filteredModels;

    const runtimeEntry = runtimes.find((entry) => entry.runtime === cardRuntime);
    const enabled = readEnabledSet();
    const mappedModels = (runtimeEntry?.models ?? [])
      .filter((modelEntry) => isModelVisible(modelEntry.id, enabled))
      .map((modelEntry) => ({
        id: modelEntry.id,
        name: modelEntry.label,
        providerID: cardRuntime,
        providerName: runtimeEntry?.label ?? cardRuntime,
      }));

    if (card.model && !mappedModels.some((modelEntry) => modelEntry.id === card.model)) {
      const currentCatalogModel = runtimeEntry?.models?.find((modelEntry) => modelEntry.id === card.model);
      return [
        {
          id: card.model,
          name: currentCatalogModel?.label ?? card.model,
          providerID: cardRuntime,
          providerName: "Current",
        },
        ...mappedModels,
      ];
    }

    return mappedModels;
  }, [card.model, cardRuntime, filteredModels, runtimes]);

  const statusLabel = {
    todo: 'Todo',
    in_progress: 'In Progress',
    complete: 'Complete',
    done: 'Done',
  }[card.status];

  const resolveModelForRuntime = useCallback(
    (runtime: AgentRuntime): string | undefined => {
      if (runtime === "codex") {
        const codexModels = runtimes.find((entry) => entry.runtime === "codex")?.models ?? [];
        return codexModels[0]?.id ?? DEFAULT_CODEX_MODEL;
      }

      if (runtime === "claude") {
        const claudeModels = runtimes.find((entry) => entry.runtime === "claude")?.models ?? [];
        return claudeModels[0]?.id ?? DEFAULT_CLAUDE_MODEL;
      }

      const agentKey = card.agentType ?? "sisyphus";
      const preferred = readAgentModelPreference()[agentKey];
      if (preferred && filteredModels.some((modelEntry) => modelEntry.id === preferred)) {
        return preferred;
      }

      const configured = getAgentConfig(agentKey)?.model;
      if (configured && filteredModels.some((modelEntry) => modelEntry.id === configured)) {
        return configured;
      }

      return filteredModels[0]?.id;
    },
    [card.agentType, filteredModels, runtimes],
  );

  const handleRuntimeChange = useCallback(
    (runtime: AgentRuntime) => {
      if (!onUpdate || runtime === cardRuntime || !isTodo) return;

      const nextAgentType = runtime === "opencode" ? card.agentType ?? "sisyphus" : undefined;
      const nextModel = resolveModelForRuntime(runtime);
      const updates: UpdateCardInput = {
        agentRuntime: runtime,
        model: nextModel ?? null,
        agentType: nextAgentType ?? null,
        codexOptions: runtime === "codex"
          ? {
              reasoningEffort: prefs.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
              sandbox: prefs.codexSandbox ?? DEFAULT_CODEX_SANDBOX,
              skipGitRepoCheck: true,
              bypassApprovalsAndSandbox: prefs.codexBypassApprovalsAndSandbox ?? false,
            }
          : null,
        claudeOptions: runtime === "claude"
          ? { permissionMode: "acceptEdits", dangerouslySkipPermissions: false }
          : null,
        command: null,
        arguments: null,
        resumeSessionId: null,
      };

      if (card.queueSessionMode === "continue_queued_after_session") {
        updates.queueSessionMode = "new_session";
      }

      onUpdate(card.id, updates);
    },
    [
      card.agentType,
      card.id,
      card.queueSessionMode,
      cardRuntime,
      isTodo,
      onUpdate,
      prefs.codexBypassApprovalsAndSandbox,
      prefs.codexReasoningEffort,
      prefs.codexSandbox,
      resolveModelForRuntime,
    ],
  );

  const togglePhase = (phase: string) => {
    setCollapsedPhases((prev) => ({ ...prev, [phase]: !prev[phase] }));
  };

  const handleCopyId = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(id);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1500);
  };

  const handleCopyResumeCommand = (e: React.MouseEvent, command: string) => {
    e.stopPropagation();
    navigator.clipboard.writeText(command);
    setCopiedResumeCommand(command);
    setTimeout(() => setCopiedResumeCommand(null), 1500);
  };

  const startEditing = useCallback(
    (field: EditingField) => {
      if (!canEdit) return;
      if (!field) return;
      if (!isTodo && field !== "title") return;

      setEditingField(field);
      switch (field) {
        case "title":
          setEditValue(card.title);
          break;
        case "description":
          setEditValue(card.description);
          break;
        case "projectDir":
          setEditValue(card.projectDir ?? "");
          break;
        case "model":
          setEditValue(card.model ?? "");
          break;
        case "agentType":
          setEditValue(card.agentType ?? "");
          break;
        case "arguments":
          setEditValue(card.arguments ?? "");
          break;
      }
    },
    [canEdit, isTodo, card]
  );

  const saveEdit = useCallback(() => {
    if (!editingField || !onUpdate) return;
    const trimmed = editValue.trim();

    if (editingField === "title" && !trimmed) {
      setEditingField(null);
      return;
    }

    const updates: UpdateCardInput = {};
    switch (editingField) {
      case "title":
        if (trimmed !== card.title) updates.title = trimmed;
        break;
      case "description":
        if (trimmed !== card.description) updates.description = trimmed;
        break;
      case "projectDir":
        if (trimmed !== (card.projectDir ?? "")) updates.projectDir = trimmed;
        break;
      case "model":
        if (trimmed !== (card.model ?? "")) updates.model = trimmed || undefined;
        break;
      case "agentType":
        if (trimmed !== (card.agentType ?? "")) {
          updates.agentType = trimmed || undefined;
        }
        break;
      case "arguments":
        if (trimmed !== (card.arguments ?? "")) {
          updates.arguments = trimmed || null;
        }
        break;
    }

    if (Object.keys(updates).length > 0) {
      onUpdate(card.id, updates);
    }
    setEditingField(null);
  }, [editingField, editValue, onUpdate, card]);

  const saveProjectDirEdit = useCallback((nextValue: string) => {
    if (!onUpdate) return;
    const trimmed = nextValue.trim();
    if (trimmed !== (card.projectDir ?? "")) {
      onUpdate(card.id, { projectDir: trimmed });
    }
    setEditingField(null);
    setEditValue("");
  }, [onUpdate, card]);

  const cancelEdit = useCallback(() => {
    setEditingField(null);
    setEditValue("");
  }, []);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      }
    },
    [saveEdit, cancelEdit]
  );

  const handleTextareaKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelEdit();
      }
    },
    [saveEdit, cancelEdit]
  );

  const handleDescriptionPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const imageFiles = Array.from(e.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);

      // 이미지가 없으면 기본 동작(텍스트 붙여넣기)에 맡긴다.
      if (imageFiles.length === 0) return;

      e.preventDefault();
      void (async () => {
        for (const file of imageFiles) {
          try {
            const screenshot = await uploadScreenshot(card.id, file);
            onScreenshotUploaded?.(screenshot);
          } catch {
            // 개별 업로드 실패는 무시하고 나머지를 계속 시도한다.
          }
        }
      })();
    },
    [card.id, onScreenshotUploaded]
  );

  const closeOnSuccess = useCallback(
    (action: () => Promise<boolean> | boolean) => {
      void (async () => {
        const ok = await action();
        if (ok) {
          onClose();
        }
      })();
    },
    [onClose]
  );

  const handleStartTask = useCallback(() => {
    if (!onDispatch) return;
    closeOnSuccess(() => onDispatch(card.id));
  }, [card.id, closeOnSuccess, onDispatch]);

  const handleStatusAction = useCallback(
    (status: KanbanStatus) => {
      closeOnSuccess(() => onStatusChange(card.id, status));
    },
    [card.id, closeOnSuccess, onStatusChange]
  );

  const handleDeleteCard = useCallback(() => {
    if (!window.confirm("Move this card to trash? You can restore it later.")) {
      return;
    }
    closeOnSuccess(() => onDelete(card.id));
  }, [card.id, closeOnSuccess, onDelete]);

  const parentNavigation = (() => {
    if (card.parentCardId && allCards && onNavigateToCard) {
      const parentCard = allCards.find((c) => c.id === card.parentCardId);
      if (!parentCard) return null;
      return {
        label: `Back to parent: ${parentCard.title}`,
        target: parentCard,
      };
    }

    if (card.feedbackForCardId && allCards && onNavigateToCard) {
      const originalCard = allCards.find((c) => c.id === card.feedbackForCardId);
      if (!originalCard) return null;
      return {
        label: `Feedback for: ${originalCard.title}`,
        target: originalCard,
      };
    }

    return null;
  })();

  const childRelationshipPanel = (() => {
    if (!allCards || !onNavigateToCard) return null;
    const children = allCards.filter((c) => c.parentCardId === card.id);
    if (children.length === 0) return null;

    const nested = children.filter((c) => c.linkKind === 'nested');
    const workers = children.filter((c) => c.linkKind === 'worker');
    const others = children.filter((c) => c.linkKind !== 'nested' && c.linkKind !== 'worker');

    const renderItems = (items: KanbanCard[], fallbackLabel: string) =>
      items.map((child, idx) => {
        const agentLabel = child.agentType
          ? `${formatAgentTypeLabel(child.agentType) ?? child.agentType} #${idx + 1}`
          : `${fallbackLabel} #${idx + 1}`;
        const rowStyle = getChildRowStyle(child.agentType);
        const statusDot =
          child.status === "complete" || child.status === "done"
            ? "✅"
            : child.status === "in_progress"
              ? "⏳"
              : "○";
        const modelShort = child.model
          ? child.model.split(" ")[0].replace(/^claude-/, "").replace(/-\d{8}$/, "")
          : null;
        return (
          <li key={child.id} className="kv2-child-item">
            <button
              type="button"
              className="kv2-child-link"
              style={{ borderLeftColor: rowStyle.border, background: rowStyle.bg }}
              onClick={() => onNavigateToCard(child)}
            >
              <span className="kv2-child-status">{statusDot}</span>
              <span className="kv2-child-title">{agentLabel}</span>
              {modelShort && <span className="kv2-child-model">({modelShort})</span>}
            </button>
          </li>
        );
      });

    return (
      <div className="kv2-children kv2-relationship-panel">
        {nested.length > 0 && (
          <>
            <div className="kv2-children-label">Nested Tasks ({nested.length})</div>
            <ul className="kv2-children-list">{renderItems(nested, 'Task')}</ul>
          </>
        )}
        {workers.length > 0 && (
          <>
            <div className="kv2-children-label">Worker Runtimes ({workers.length})</div>
            <ul className="kv2-children-list">{renderItems(workers, 'Worker')}</ul>
          </>
        )}
        {others.length > 0 && (
          <>
            <div className="kv2-children-label">Subtasks ({others.length})</div>
            <ul className="kv2-children-list">{renderItems(others, 'Subtask')}</ul>
          </>
        )}
      </div>
    );
  })();

  const feedbackRelationshipPanel = (() => {
    if (!allCards || !onNavigateToCard) return null;
    const feedbackCards = allCards.filter((c) => c.feedbackForCardId === card.id);
    if (feedbackCards.length === 0) return null;
    return (
      <div className="kv2-children kv2-relationship-panel">
        <div className="kv2-children-label">Feedback ({feedbackCards.length})</div>
        <ul className="kv2-children-list">
          {feedbackCards.map((fb) => {
            const rowStyle = getChildRowStyle(fb.agentType);
            const statusDot =
              fb.status === "complete" || fb.status === "done"
                ? "✅"
                : fb.status === "in_progress"
                  ? "⏳"
                  : "○";
            const modelShort = fb.model
              ? fb.model.split(" ")[0].replace(/^claude-/, "").replace(/-\d{8}$/, "")
              : null;
            return (
              <li key={fb.id} className="kv2-child-item">
                <button
                  type="button"
                  className="kv2-child-link"
                  style={{ borderLeftColor: rowStyle.border, background: rowStyle.bg }}
                  onClick={() => onNavigateToCard(fb)}
                >
                  <span className="kv2-child-status">{statusDot}</span>
                  <span className="kv2-child-title">{fb.title}</span>
                  {modelShort && <span className="kv2-child-model">({modelShort})</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  })();

  const footerPrimaryAction = (() => {
    if (card.status === "todo" && onDispatch) {
      return (
        <button type="button" className="kv2-btn kv2-btn--primary kv2-btn--primary-strong" onClick={handleStartTask}>
          START TASK
        </button>
      );
    }

    if (card.status === "in_progress") {
      return (
        <button type="button" className="kv2-btn kv2-btn--success kv2-btn--primary-strong" onClick={() => handleStatusAction("complete")}>
          DONE
        </button>
      );
    }

    if (card.status === "complete") {
      return (
        <button type="button" className="kv2-btn kv2-btn--success kv2-btn--primary-strong" onClick={() => handleStatusAction("done")}>
          DONE
        </button>
      );
    }

    if (card.status === "done") {
      return (
        <button type="button" className="kv2-btn kv2-btn--outline kv2-btn--primary-strong" onClick={() => handleStatusAction("todo")}>
          REOPEN
        </button>
      );
    }

    return null;
  })();

  const footerSecondaryActions = (() => {
    if (card.status === "in_progress" || card.status === "complete") {
      return (
        <button type="button" className="kv2-btn kv2-btn--outline kv2-btn--primary-strong" onClick={() => handleStatusAction("todo")}>
          REOPEN
        </button>
      );
    }

    return null;
  })();

  const metaPanel = (
    <CardMetaPanel
      card={card}
      isTodo={isTodo}
      canEdit={canEdit}
      editingField={editingField}
      editValue={editValue}
      setEditValue={setEditValue}
      startEditing={startEditing}
      saveEdit={saveEdit}
      cancelEdit={cancelEdit}
      saveProjectDirEdit={saveProjectDirEdit}
      handleEditKeyDown={handleEditKeyDown}
      filteredModels={runtimeModelOptions}
      runtimes={runtimes}
      writeAgentModelPreference={writeAgentModelPreference}
      readAgentModelPreference={readAgentModelPreference}
      onRuntimeChange={handleRuntimeChange}
      onUpdate={onUpdate}
    />
  );

  const promptSection = (
    <section className="kv2-detail-primary-block">
      <CardPhases
        card={card}
        progress={runProgress}
        isTodo={isTodo}
        canEdit={canEdit}
        editingField={editingField}
        editValue={editValue}
        setEditValue={setEditValue}
        startEditing={startEditing}
        saveEdit={saveEdit}
        cancelEdit={cancelEdit}
        handleTextareaKeyDown={handleTextareaKeyDown}
        onDescriptionPaste={handleDescriptionPaste}
        collapsedPhases={collapsedPhases}
        togglePhase={togglePhase}
      />
    </section>
  );

  return (
    <DialogSkeleton
      onClose={onClose}
      width="860px"
      className={`kv2-dialog--detail kv2-dialog--status-${card.status}`}
      persistSizeKey="kanban-dialog-size-detail"
    >
      <div className="kv2-detail-shell">
        <div className="kv2-status-row kv2-status-row--hero">
          <span className={`kv2-status-badge kv2-status-badge--${card.status}`}>
            {statusLabel}
          </span>
          <div className="kv2-status-row-meta">
            {onToggleFavorite && (
              <FavoriteToggleButton
                active={!!card.favorite}
                onToggle={() => {
                  void onToggleFavorite(card.id);
                }}
                className="kv2-favorite-toggle--detail"
              />
            )}
            <button
              type="button"
              className={`kv2-card-id-meta ${copiedId ? 'kv2-card-id-meta--copied' : ''}`}
              onClick={(e) => handleCopyId(e, card.id)}
              title="Click to copy full ID"
            >
              🆔 {copiedId ? 'Copied!' : card.id.slice(0, 8)}
            </button>
            <button
              type="button"
              className="kv2-dialog-close"
              onClick={onClose}
              aria-label="Close dialog"
            >
              ×
            </button>
          </div>
        </div>

        {parentNavigation && onNavigateToCard && (
          <div className="kv2-detail-nav-row">
            <button type="button" className="kv2-back-btn" onClick={() => onNavigateToCard(parentNavigation.target)}>
              ↩ {parentNavigation.label}
            </button>
          </div>
        )}

        <section className="kv2-detail-overview">
          <div className="kv2-title-row">
            <div className="kv2-title-block">
              {editingField === "title" ? (
                <input
                  ref={editInputRef}
                  className="kv2-input kv2-title-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  onBlur={saveEdit}
                  style={{ flex: 1 }}
                />
              ) : (
                <h2 className="kv2-title-text" title="Click to edit">
                  <button
                    type="button"
                    className="kv2-editable-text kv2-unstyled-button"
                    onClick={() => startEditing("title")}
                  >
                    {card.title}
                  </button>
                </h2>
              )}
            </div>
          </div>

          {metaPanel}
        </section>

        <div className="kv2-detail-layout">
          <div className="kv2-detail-main">
            {promptSection}

            {question && (
              <QuestionPanel
                key={question.id}
                question={question}
                onAnswerQuestion={onAnswerQuestion}
                onRejectQuestion={onRejectQuestion}
                collapsed={collapsedPhases["question"]}
                togglePhase={() => togglePhase("question")}
              />
            )}

            {card.status === "complete" && onCreateFeedback && !card.parentCardId && (
              <FeedbackPanel
                cardId={card.id}
                isSubmittingFeedback={isSubmittingFeedback}
                setIsSubmittingFeedback={setIsSubmittingFeedback}
                onCreateFeedback={onCreateFeedback}
                onClose={onClose}
              />
            )}
          </div>

          <div className="kv2-detail-sidebar">
            {!card.parentCardId && (
              <ScreenshotPanel
                cardId={card.id}
                screenshots={card.screenshots}
                onScreenshotUploaded={onScreenshotUploaded}
                onScreenshotDeleted={onScreenshotDeleted}
              />
            )}

            {isTodo && (
              <CommandMetaRow
                card={card}
                isTodo={isTodo}
                canEdit={canEdit}
                onUpdate={onUpdate}
              />
            )}

            {card.status === "todo" && !card.parentCardId && (onQueue || onUnqueue) && (
              <QueueSettingsPanel
                card={card}
                allCards={allCards}
                queueModeSummary={queueModeSummary}
                queueTargetId={queueTargetId}
                queueSessionMode={queueSessionMode}
                onQueueTargetChange={setQueueTargetId}
                onQueueSessionModeChange={setQueueSessionMode}
                onQueue={onQueue}
                onUnqueue={onUnqueue}
              />
            )}

            {card.status === "todo" && !card.parentCardId && onSetResumeSession && onClearResumeSession && (
              <SessionPickerPanel
                layout="sidebar"
                card={card}
                onSelectSession={onSetResumeSession}
                onClearSession={onClearResumeSession}
              />
            )}

            {childRelationshipPanel}
            {feedbackRelationshipPanel}
          </div>
        </div>

        {!card.parentCardId && (
          <div className="kv2-dialog-actions kv2-dialog-actions--detail">
            <div className="kv2-dialog-actions-rail">
              <div className="kv2-dialog-actions-group kv2-dialog-actions-group--detail-priority">
                {footerPrimaryAction}
                {footerSecondaryActions}
              </div>

              <div className="kv2-dialog-danger-row">
                {card.status === "todo" && card.result && (
                  <button
                    type="button"
                    className="kv2-btn kv2-btn--success"
                    onClick={() => handleStatusAction("complete")}
                  >
                    MARK COMPLETE
                  </button>
                )}
                <button type="button" className="kv2-btn kv2-btn--subtle-danger" onClick={handleDeleteCard}>
                  DELETE
                </button>
              </div>
            </div>

            <div className="kv2-detail-divider" />

            {(card.sessionId || card.sessionCreatedAt) && (
              <div className="kv2-dialog-footer-session">
                {card.sessionId && (
                  <span style={{ display: "flex", flexDirection: "column", gap: 2, alignItems: "flex-end" }}>
                    {card.sessionTitle && <span>💬 {card.sessionTitle}</span>}
                    {resumeCommand ? (
                      <button
                        type="button"
                        className="kv2-dialog-footer-session-copy"
                        onClick={(e) => handleCopyResumeCommand(e, resumeCommand)}
                        title={`Copy ${formatRuntimeLabel(cardRuntime)} resume command: ${resumeCommand}`}
                        aria-label={`Copy ${formatRuntimeLabel(cardRuntime)} resume command`}
                      >
                        <span>🪪 {copiedResumeCommand === resumeCommand ? "Copied resume command" : card.sessionId}</span>
                      </button>
                    ) : (
                      <span>🪪 {card.sessionId}</span>
                    )}
                  </span>
                )}
                {card.sessionCreatedAt && (
                  <span>
                    🕐 Session created: {new Date(card.sessionCreatedAt).toLocaleString()}
                  </span>
                )}
              </div>
            )}

            {telegramMetaLabel && (
              <div
                className="kv2-dialog-footer-telegram"
                title={card.telegramReplyError ? `Telegram error: ${card.telegramReplyError}` : undefined}
              >
                <span className="kv2-dialog-footer-telegram-icon">
                  <TelegramBadge size={16} />
                </span>
                <span>{telegramMetaLabel}</span>
              </div>
            )}

            <div className="kv2-dialog-footer-meta kv2-dialog-footer-meta--detail">
              <span>Created: {createdLabel}</span>
              {startedLabel && <span>Started: {startedLabel}</span>}
              {completedLabel && <span>Completed: {completedLabel}</span>}
              {durationLabel && <span>Duration: {durationLabel}</span>}
              <span>Updated: {updatedLabel}</span>
            </div>
          </div>
        )}
      </div>
    </DialogSkeleton>
  );
};
