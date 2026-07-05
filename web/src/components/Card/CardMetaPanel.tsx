import React, { useRef, useEffect, useMemo, useState } from "react";
import {
  AgentRuntime,
  ClaudePermissionMode,
  CodexReasoningEffort,
  CodexSandboxMode,
  KanbanCard,
  UpdateCardInput,
} from "../../../../src/core/types";
import type { RuntimeCatalogEntry } from "../../../../src/core/runtime-config";
import {
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SANDBOX,
} from "../../../../src/core/runtime-config";
import { AGENT_CONFIGS, getAgentConfig } from "../../constants/agents";
import {
  getCommandHint,
  formatCommandName,
  getFilteredCommandsForRuntime,
  type CommandId,
} from "../../constants/commands";
import { ModelInfo } from "../../hooks/useKanbanApi";
import { useRuntimeDefaults } from "../../hooks/useRuntimeDefaults";
import { formatAgentTypeLabel } from "../../utils/agent-label";
import { RuntimeBadge, RuntimeBadgeIcon } from "../Board/BoardCardSections";
import { DirectoryPicker } from "./DirectoryPicker";
import { CommandPicker } from "./CommandPicker";
import { MetaPopoverPortal, MetaSelect, useAnchoredPopover, type MetaSelectOption } from "./MetaDropdown";

const CLAUDE_PERMISSION_LABELS: Record<ClaudePermissionMode, string> = {
  acceptEdits: "Accept edits",
  bypassPermissions: "Bypass permissions",
  plan: "Plan",
  dontAsk: "Don't ask",
};

const CODEX_REASONING_OPTIONS: MetaSelectOption[] = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Xhigh" },
];

const CODEX_SANDBOX_OPTIONS: MetaSelectOption[] = [
  { value: "read-only", label: "read-only" },
  { value: "workspace-write", label: "workspace-write" },
  { value: "danger-full-access", label: "danger-full-access" },
];

const CLAUDE_PERMISSION_OPTIONS: MetaSelectOption[] = [
  { value: "acceptEdits", label: "Accept edits" },
  { value: "bypassPermissions", label: "Bypass permissions" },
  { value: "plan", label: "Plan" },
  { value: "dontAsk", label: "Don't ask" },
];
const ClaudeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 26 27" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M5.07306 17.7192L9.99106 14.9614L10.0721 14.7199L9.99106 14.5854H9.74786L8.92369 14.5352L6.11341 14.46L3.68143 14.3597L1.31701 14.2344L0.722529 14.109L0.168579 13.3694L0.222623 13.0059L0.722529 12.6675L1.43861 12.7301L3.0194 12.843L5.39733 13.0059L7.11322 13.1062L9.66679 13.3694H10.0721L10.1262 13.2065L9.99106 13.1062L9.88297 13.0059L7.42397 11.3387L4.76231 9.58378L3.37068 8.56843L2.62758 8.05448L2.24927 7.57814L2.08714 6.52518L2.76269 5.77306L3.68143 5.83574L3.91112 5.89842L4.84338 6.61293L6.82949 8.15476L9.4236 10.0601L9.80191 10.3735L9.95424 10.2707L9.97755 10.198L9.80191 9.9097L8.39676 7.36504L6.89705 4.77024L6.2215 3.69221L6.04585 3.05291C5.97781 2.78463 5.93777 2.56267 5.93777 2.28826L6.70789 1.2353L7.14024 1.09741L8.18059 1.2353L8.61294 1.61136L9.26147 3.09052L10.3018 5.40954L11.9231 8.56843L12.396 9.50857L12.6527 10.3735L12.7473 10.6367H12.9094V10.4863L13.0445 8.70631L13.2877 6.52518L13.5309 3.71728L13.612 2.92756L14.0038 1.97488L14.7875 1.46093L15.3954 1.74925L15.8954 2.46376L15.8278 2.92756L15.5306 4.85799L14.9496 7.87899L14.5713 9.9097H14.7875L15.0442 9.64646L16.071 8.29265L17.7869 6.13659L18.5435 5.28419L19.4352 4.34404L20.0027 3.89277H21.0836L21.8672 5.07109L21.5159 6.28701L20.408 7.69096L19.4893 8.88181L18.172 10.6467L17.3545 12.0658L17.4278 12.1828L17.6248 12.166L20.5972 11.5267L22.205 11.2384L24.1235 10.9125L24.9882 11.3136L25.0828 11.7273L24.745 12.5672L22.6914 13.0686L20.2864 13.5575L16.7051 14.4005L16.6655 14.4324L16.7123 14.5018L18.3273 14.648L19.0164 14.6856H20.7053L23.8533 14.9238L24.6775 15.4628L25.1639 16.1272L25.0828 16.6411L23.8128 17.2804L22.1104 16.8793L18.1247 15.9266L16.7601 15.5882H16.5709V15.701L17.7058 16.8166L19.8 18.6969L22.4076 21.1288L22.5428 21.7304L22.205 22.2068L21.8537 22.1566L19.5568 20.4268L18.6651 19.6496L16.6655 17.9573H16.5304V18.1328L16.9897 18.8097L19.4352 22.4826L19.5568 23.6107L19.3812 23.9743L18.7462 24.1999L18.0571 24.0745L16.6114 22.0564L15.1387 19.8L13.9498 17.7693L13.8062 17.86L13.0986 25.4158L12.7743 25.8044L12.0177 26.0927L11.3827 25.6164L11.0449 24.8392L11.3827 23.2974L11.788 21.2917L12.1123 19.6997L12.4095 17.7192L12.5911 17.0575L12.575 17.0133L12.43 17.0376L10.9368 19.0855L8.66698 22.1566L6.87002 24.0745L6.43767 24.25L5.69457 23.8614L5.76212 23.172L6.18096 22.5578L8.66698 19.3989L10.1667 17.4309L11.1333 16.3012L11.1239 16.1378L11.0705 16.1332L4.46507 20.4393L3.28961 20.5897L2.7762 20.1134L2.84375 19.3362L3.08695 19.0855L5.07306 17.7192Z" fill="#D97757"/>
  </svg>
);

export type EditingField = "title" | "description" | "projectDir" | "model" | "agentType" | "arguments" | null;

interface CardMetaPanelProps {
  card: KanbanCard;
  isTodo: boolean;
  canEdit: boolean;
  editingField: EditingField;
  editValue: string;
  setEditValue: (val: string) => void;
  startEditing: (field: EditingField) => void;
  saveEdit: () => void;
  cancelEdit: () => void;
  saveProjectDirEdit: (value: string) => void;
  handleEditKeyDown: (e: React.KeyboardEvent) => void;
  filteredModels: ModelInfo[];
  runtimes: RuntimeCatalogEntry[];
  writeAgentModelPreference: (agentKey: string, modelId: string) => void;
  readAgentModelPreference: () => Record<string, string>;
  onRuntimeChange: (runtime: AgentRuntime) => void;
  onUpdate?: (id: string, updates: UpdateCardInput) => void;
}

interface RuntimePickerProps {
  value: AgentRuntime;
  runtimes: RuntimeCatalogEntry[];
  onChange: (runtime: AgentRuntime) => void;
}

const RuntimePicker: React.FC<RuntimePickerProps> = ({ value, runtimes, onChange }) => {
  const { open, setOpen, triggerRef, popoverRef, popoverStyle } = useAnchoredPopover(220);
  const selectedRuntime = runtimes.find((entry) => entry.runtime === value);

  return (
    <div className={`kv2-runtime-picker${open ? " is-open" : ""}`}>
      <button
        type="button"
        ref={triggerRef}
        className="kv2-runtime-trigger"
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Change runtime"
      >
        <span className={`kv2-runtime-trigger-icon kv2-runtime-trigger-icon--${value}`}>
          <RuntimeBadgeIcon runtime={value} />
        </span>
        <span className="kv2-runtime-trigger-label">{selectedRuntime?.label ?? value}</span>
        <span className="kv2-runtime-trigger-arrow" aria-hidden="true">▾</span>
      </button>

      {open && (
        <MetaPopoverPortal>
          <div
            ref={popoverRef}
            className="kv2-runtime-popover"
            role="listbox"
            aria-label="Runtime"
            style={popoverStyle}
          >
            <div className="kv2-runtime-popover-head">Runtime</div>
            <div className="kv2-runtime-list">
              {runtimes.map((entry) => {
                const unavailable = entry.disabled || entry.available === false;
                const selected = entry.runtime === value;
                return (
                  <button
                    key={entry.runtime}
                    type="button"
                    className={`kv2-runtime-option kv2-runtime-option--${entry.runtime}${selected ? " is-selected" : ""}`}
                    onClick={() => {
                      if (unavailable) return;
                      onChange(entry.runtime);
                      setOpen(false);
                    }}
                    disabled={unavailable}
                    role="option"
                    aria-selected={selected}
                    title={entry.unavailableReason}
                  >
                    <span className={`kv2-runtime-option-icon kv2-runtime-option-icon--${entry.runtime}`}>
                      <RuntimeBadgeIcon runtime={entry.runtime} />
                    </span>
                    <span className="kv2-runtime-option-copy">
                      <span className="kv2-runtime-option-label">{entry.label}</span>
                      {unavailable && <span className="kv2-runtime-option-note">Unavailable</span>}
                    </span>
                    {selected && <span className="kv2-runtime-option-check" aria-hidden="true">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </MetaPopoverPortal>
      )}
    </div>
  );
};

interface CommandMetaRowProps {
  card: KanbanCard;
  isTodo: boolean;
  canEdit: boolean;
  onUpdate?: (id: string, updates: UpdateCardInput) => void;
}

export const CommandMetaRow: React.FC<CommandMetaRowProps> = ({
  card,
  isTodo,
  canEdit,
  onUpdate,
}) => {
  const cardRuntime = card.agentRuntime ?? 'opencode';
  const filteredCommands = useMemo(() => getFilteredCommandsForRuntime(cardRuntime), [cardRuntime]);
  const commandValue = card.command ? formatCommandName(card.command) : 'No command';
  const argumentsValue = card.arguments || 'No arguments';
  const commandArgumentPlaceholder = card.command
    ? getCommandHint(card.command)?.argumentPlaceholder || 'No arguments required'
    : 'Select a command first';
  const showCommandDetails = (isTodo && canEdit) || Boolean(card.command || card.arguments);

  const commandPanelId = `card-${card.id}-command-panel`;
  const [commandExpanded, setCommandExpanded] = useState<boolean>(Boolean(card.command));
  const [argsDraft, setArgsDraft] = useState(card.arguments ?? "");
  // 카드가 바뀌거나(blur 커밋 후 포함) 외부에서 arguments가 갱신되면 draft를 동기화한다.
  useEffect(() => {
    setArgsDraft(card.arguments ?? "");
  }, [card.id, card.arguments]);

  const commitArguments = () => {
    if (!onUpdate) return;
    const next = argsDraft.length > 0 ? argsDraft : null;
    if ((next ?? null) === (card.arguments ?? null)) return;
    onUpdate(card.id, { arguments: next });
  };

  if (!showCommandDetails) return null;

  // TODO(편집 가능) 카드: 사이드바 Queue After / Session Resume 행과 동일한 접이식 패널 UI.
  if (isTodo && canEdit) {
    return (
      <div className="kv2-command-sidebar-panel">
        <div className="kv2-panel-heading">
          <button
            type="button"
            className="kv2-session-title"
            style={{ cursor: 'pointer', background: 'none', border: 'none', padding: 0, textAlign: 'left' }}
            aria-expanded={commandExpanded}
            aria-controls={commandPanelId}
            onClick={() => setCommandExpanded((current) => !current)}
          >
            Command
            <span className="kv2-chevron" style={{ transform: commandExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}>▼</span>
          </button>
          {card.command && <span className="kv2-create-command-value">/{card.command}</span>}
        </div>
        <div className="kv2-session-helper">필요할 때만 command를 선택해 실행 방식을 지정합니다.</div>

        {commandExpanded && (
          <div id={commandPanelId} className="kv2-create-command-panel">
            <CommandPicker
              id={`card-${card.id}-command-picker`}
              runtime={cardRuntime}
              value={(card.command as CommandId | undefined) ?? ""}
              commands={filteredCommands}
              onChange={(nextCommand) => {
                if (!onUpdate) return;
                onUpdate(card.id, {
                  command: nextCommand || null,
                  ...(nextCommand ? {} : { arguments: null }),
                });
              }}
              autoOpen
            />

            {card.command && (
              <div className="kv2-create-field kv2-create-command-arguments">
                <label className="kv2-create-label" htmlFor={`card-${card.id}-arguments-input`}>
                  Command 파라미터
                </label>
                <input
                  id={`card-${card.id}-arguments-input`}
                  className="kv2-create-input"
                  value={argsDraft}
                  onChange={(e) => setArgsDraft(e.target.value)}
                  onBlur={commitArguments}
                  placeholder={commandArgumentPlaceholder}
                />
                <span className="kv2-create-helper">선택한 command에 전달할 추가 파라미터입니다.</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // IN PROGRESS 이후(읽기 전용): 기존 박스 UI 유지.
  return (
    <div className="kv2-meta-command-row">
      <div className="kv2-meta-card kv2-meta-card--command">
        <span className="kv2-meta-label">Command</span>
        <span className={`kv2-meta-value kv2-meta-value--mono${card.command ? "" : " kv2-meta-placeholder"}`}>
          {commandValue}
        </span>
        <span className="kv2-meta-subtitle">Launch context for this card</span>
      </div>
      <div className="kv2-meta-card kv2-meta-card--arguments">
        <span className="kv2-meta-label">Arguments</span>
        <span className={`kv2-meta-value kv2-meta-value--mono${card.arguments ? "" : " kv2-meta-placeholder"}`}>
          {argumentsValue}
        </span>
      </div>
    </div>
  );
};

export const CardMetaPanel: React.FC<CardMetaPanelProps> = ({
  card,
  isTodo,
  canEdit,
  editingField,
  editValue,
  setEditValue,
  startEditing,
  cancelEdit,
  saveProjectDirEdit,
  filteredModels,
  runtimes,
  writeAgentModelPreference,
  readAgentModelPreference,
  onRuntimeChange,
  onUpdate,
}) => {
  const editInputRef = useRef<HTMLInputElement>(null);
  const cardRuntime = card.agentRuntime ?? 'opencode';
  const showAgentMeta = cardRuntime === 'opencode';
  const showCodexMeta = cardRuntime === 'codex';
  const showClaudeMeta = cardRuntime === 'claude';
  const showRuntimeOptions = showCodexMeta || showClaudeMeta;
  const {
    prefs,
    setCodexReasoningEffort,
    setCodexSandbox,
    setCodexBypassApprovalsAndSandbox,
    setClaudePermissionMode,
    setClaudeDangerouslySkipPermissions,
  } = useRuntimeDefaults();
  const hasStoredCodexOptions = Boolean(card.codexOptions);
  const codexReasoningEffort: CodexReasoningEffort =
    card.codexOptions?.reasoningEffort ?? prefs.codexReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
  const codexSandbox: CodexSandboxMode =
    card.codexOptions?.sandbox ?? prefs.codexSandbox ?? DEFAULT_CODEX_SANDBOX;
  const codexSkipGitRepoCheck = card.codexOptions?.skipGitRepoCheck ?? true;
  const codexBypassApprovalsAndSandbox = card.codexOptions?.bypassApprovalsAndSandbox
    ?? prefs.codexBypassApprovalsAndSandbox
    ?? false;
  const codexGitRepoDisplay = hasStoredCodexOptions
    ? (codexSkipGitRepoCheck ? "Skipped" : "Required")
    : "";
  const claudePermissionMode: ClaudePermissionMode = card.claudeOptions?.permissionMode ?? prefs.claudePermissionMode ?? "acceptEdits";
  const claudeDangerouslySkip = card.claudeOptions?.dangerouslySkipPermissions ?? prefs.claudeDangerouslySkipPermissions ?? false;
  const claudePermissionDisplay = claudeDangerouslySkip
    ? "Skip all (dangerous)"
    : CLAUDE_PERMISSION_LABELS[claudePermissionMode];
  const currentAgentConfig = getAgentConfig(card.agentType);
  const currentAgentStyle = currentAgentConfig
    ? ({ '--kv2-agent-accent': currentAgentConfig.color } as React.CSSProperties & Record<'--kv2-agent-accent', string>)
    : undefined;

  useEffect(() => {
    if (editingField === "projectDir") {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingField]);

  const modelOptions = useMemo<MetaSelectOption[]>(
    () => [
      { value: "", label: "Default model" },
      ...filteredModels.map((m) => ({ value: m.id, label: m.name, hint: m.providerName })),
    ],
    [filteredModels],
  );

  function formatModelName(modelId: string): string {
    if (!modelId) return 'Default model';
    // Prefer the exact label from the runtime catalog (e.g. "Opus 4.8").
    // This avoids mis-parsing dash-separated version ids like `claude-opus-4-8`.
    for (const entry of runtimes) {
      const catalogModel = entry.models?.find((m) => m.id === modelId);
      if (catalogModel) return catalogModel.label;
    }
    const lower = modelId.toLowerCase();
    const families = [
      { pattern: /opus[- ]?(\d+[-.]?\d*)/i, name: "Opus" },
      { pattern: /sonnet[- ]?(\d+[-.]?\d*)/i, name: "Sonnet" },
      { pattern: /haiku[- ]?(\d+[-.]?\d*)/i, name: "Haiku" },
      { pattern: /gpt[- ]?(4o|4[-.]?\d*|3\.5)/i, name: "GPT" },
      { pattern: /gemini[- ]?(\d+[-.]?\d*)/i, name: "Gemini" },
      { pattern: /o(\d+)[- ]?(mini|pro)?/i, name: "o" },
    ];
    for (const { pattern, name } of families) {
      const match = lower.match(pattern);
      if (match) {
        const version = (match[1] || "").replace(/-/g, ".");
        const suffix = match[2] ? ` ${match[2]}` : "";
        return `${name} ${version}${suffix}`.trim();
      }
    }
    const stripped = modelId
      .replace(/^[^/]+\//, "")
      .replace(/[-_]\d{8,}$/, "")
      .replace(/[-_]/g, " ");
    return stripped.length > 20 ? stripped.slice(0, 20) + "\u2026" : stripped;
  }

  const isClaudeCode = card.sourceContext === 'claude-code';
  const agentValue = currentAgentConfig
    ? `${currentAgentConfig.emoji} ${currentAgentConfig.label}`
    : isClaudeCode
      ? null
      : formatAgentTypeLabel(card.agentType) ?? card.agentType ?? 'No agent selected';

  const modelValue = formatModelName(card.model ?? '');
  const directoryValue = card.projectDir || 'No directory set';

  const updateCodexOptions = (updates: {
    reasoningEffort?: CodexReasoningEffort;
    sandbox?: CodexSandboxMode;
    skipGitRepoCheck?: boolean;
    bypassApprovalsAndSandbox?: boolean;
  }) => {
    if (updates.reasoningEffort) {
      setCodexReasoningEffort(updates.reasoningEffort);
    }
    if (updates.sandbox) {
      setCodexSandbox(updates.sandbox);
    }
    onUpdate?.(card.id, {
      codexOptions: {
        reasoningEffort: codexReasoningEffort,
        sandbox: codexSandbox,
        skipGitRepoCheck: codexSkipGitRepoCheck,
        bypassApprovalsAndSandbox: codexBypassApprovalsAndSandbox,
        ...updates,
      },
    });
  };

  return (
    <div className="kv2-meta-band">
      <div className={`kv2-meta-panel${showAgentMeta ? " kv2-meta-panel--with-agent" : ""}${showRuntimeOptions ? " kv2-meta-panel--with-options" : ""}${showCodexMeta ? " kv2-meta-panel--with-codex-options" : ""}`}>
        {isTodo && canEdit ? (
          <div className={`kv2-meta-card kv2-meta-card--runtime kv2-meta-card--runtime-${cardRuntime} kv2-meta-editable`}>
            <span className="kv2-meta-label">Runtime</span>
            <RuntimePicker
              value={cardRuntime}
              runtimes={runtimes}
              onChange={onRuntimeChange}
            />
          </div>
        ) : (
          <div className={`kv2-meta-card kv2-meta-card--runtime kv2-meta-card--runtime-${cardRuntime}`}>
            <span className="kv2-meta-label">Runtime</span>
            <span className="kv2-meta-value kv2-meta-value--runtime">
              <RuntimeBadge runtime={cardRuntime} />
            </span>
          </div>
        )}

        {showAgentMeta && (isTodo && canEdit ? (
          <button
            type="button"
            className="kv2-meta-card kv2-meta-card--agent kv2-meta-editable"
            style={currentAgentStyle}
            onClick={() => editingField === "agentType" ? cancelEdit() : startEditing("agentType")}
            title="Click to change agent"
          >
            <span className="kv2-meta-label">Agent</span>
            <span className="kv2-meta-value">{agentValue}</span>
          </button>
        ) : (
          <div className="kv2-meta-card kv2-meta-card--agent" style={currentAgentStyle}>
            <span className="kv2-meta-label">Agent</span>
            {isClaudeCode ? (
              <span className="kv2-meta-value kv2-meta-value--claude">
                <ClaudeIcon /> Claude
              </span>
            ) : (
              <span className="kv2-meta-value">{agentValue}</span>
            )}
            {currentAgentConfig && (
              <span className="kv2-meta-subtitle">{currentAgentConfig.subtitle}</span>
            )}
          </div>
        ))}

        {isTodo && canEdit ? (
          <div className="kv2-meta-card kv2-meta-card--model kv2-meta-editable">
            <span className="kv2-meta-label">Model</span>
            <MetaSelect
              value={card.model ?? ""}
              options={modelOptions}
              ariaLabel="Model"
              onChange={(val) => {
                if (onUpdate) {
                  onUpdate(card.id, { model: val || undefined });
                  if (val && showAgentMeta) {
                    writeAgentModelPreference(card.agentType ?? "", val);
                  }
                }
              }}
            />
          </div>
        ) : (
          <div className="kv2-meta-card kv2-meta-card--model">
            <span className="kv2-meta-label">Model</span>
            <span className="kv2-meta-value">{modelValue}</span>
          </div>
        )}

        {showCodexMeta && (
          <>
            <div className="kv2-meta-card kv2-meta-card--option-a kv2-meta-card--codex-options">
              <span className="kv2-meta-label">Reasoning</span>
              {isTodo && canEdit ? (
                <MetaSelect
                  value={codexReasoningEffort}
                  options={CODEX_REASONING_OPTIONS}
                  onChange={(next) => updateCodexOptions({ reasoningEffort: next as CodexReasoningEffort })}
                  ariaLabel="Codex reasoning effort"
                  title="Codex reasoning effort"
                />
              ) : (
                <span className={`kv2-meta-value${hasStoredCodexOptions ? "" : " kv2-meta-placeholder"}`}>
                  {hasStoredCodexOptions ? codexReasoningEffort : "Not recorded"}
                </span>
              )}
            </div>
            <div className="kv2-meta-card kv2-meta-card--option-b kv2-meta-card--codex-options">
              <span className="kv2-meta-label">Sandbox</span>
              {isTodo && canEdit ? (
                <MetaSelect
                  value={codexSandbox}
                  options={CODEX_SANDBOX_OPTIONS}
                  onChange={(next) => updateCodexOptions({ sandbox: next as CodexSandboxMode })}
                  ariaLabel="Codex sandbox"
                  title="Codex sandbox"
                />
              ) : (
                <span className={`kv2-meta-value${hasStoredCodexOptions ? "" : " kv2-meta-placeholder"}`}>
                  {hasStoredCodexOptions ? codexSandbox : "Not recorded"}
                </span>
              )}
            </div>
            <div className="kv2-meta-card kv2-meta-card--option-d kv2-meta-card--codex-options">
              <span className="kv2-meta-label">Approvals</span>
              {isTodo && canEdit ? (
                <label className="kv2-meta-checkbox-row">
                  <input
                    type="checkbox"
                    checked={codexBypassApprovalsAndSandbox}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setCodexBypassApprovalsAndSandbox(checked);
                      updateCodexOptions({ bypassApprovalsAndSandbox: checked });
                    }}
                  />
                  <span>Bypass</span>
                </label>
              ) : (
                <span className={`kv2-meta-value${codexBypassApprovalsAndSandbox ? " kv2-meta-value--danger" : ""}`}>
                  {codexBypassApprovalsAndSandbox ? "Bypass" : "Default"}
                </span>
              )}
            </div>
            <div className="kv2-meta-card kv2-meta-card--option-c kv2-meta-card--codex-options">
              <span className="kv2-meta-label">Git Check</span>
              {isTodo && canEdit ? (
                <label className="kv2-meta-checkbox-row">
                  <input
                    type="checkbox"
                    checked={codexSkipGitRepoCheck}
                    onChange={(event) => updateCodexOptions({ skipGitRepoCheck: event.target.checked })}
                  />
                  <span>Skip</span>
                </label>
              ) : (
                <span className={`kv2-meta-value${hasStoredCodexOptions ? "" : " kv2-meta-placeholder"}`}>
                  {codexGitRepoDisplay || "Not recorded"}
                </span>
              )}
            </div>
          </>
        )}
        {showClaudeMeta && (
          <>
          <div className="kv2-meta-card kv2-meta-card--option-a kv2-meta-card--claude-options">
            <span className="kv2-meta-label">Permission</span>
            {isTodo && canEdit ? (
            <MetaSelect
              value={claudePermissionMode}
              options={CLAUDE_PERMISSION_OPTIONS}
              onChange={(next) => {
                const permissionMode = next as ClaudePermissionMode;
                setClaudePermissionMode(permissionMode);
                onUpdate?.(card.id, {
                  claudeOptions: {
                    permissionMode,
                    dangerouslySkipPermissions: claudeDangerouslySkip,
                  },
                });
              }}
              ariaLabel="Claude permission mode"
              title="Claude permission mode applied on dispatch"
              disabled={claudeDangerouslySkip}
            />
            ) : (
              <span className={`kv2-meta-value${claudeDangerouslySkip ? " kv2-meta-value--danger" : ""}`}>
                {claudePermissionDisplay}
              </span>
            )}
          </div>
          <div className="kv2-meta-card kv2-meta-card--option-b kv2-meta-card--claude-options">
            <span className="kv2-meta-label">Skip Permissions</span>
            {isTodo && canEdit ? (
              <label className="kv2-meta-checkbox-row">
              <input
                type="checkbox"
                checked={claudeDangerouslySkip}
                onChange={(event) => {
                  const checked = event.target.checked;
                  setClaudeDangerouslySkipPermissions(checked);
                  onUpdate?.(card.id, {
                    claudeOptions: {
                      permissionMode: claudePermissionMode,
                      dangerouslySkipPermissions: checked,
                    },
                  });
                }}
              />
                <span>Dangerous</span>
              </label>
            ) : (
              <span className={`kv2-meta-value${claudeDangerouslySkip ? " kv2-meta-value--danger" : ""}`}>
                {claudeDangerouslySkip ? "Enabled" : "Disabled"}
              </span>
            )}
          </div>
          </>
        )}

        {isTodo && canEdit ? (
          editingField === "projectDir" ? (
            <div className="kv2-meta-card kv2-meta-card--edit kv2-meta-card--directory">
              <span className="kv2-meta-label">Directory</span>
              <DirectoryPicker
                id={`card-${card.id}-directory-input`}
                value={editValue}
                onChange={setEditValue}
                onCommit={saveProjectDirEdit}
                onCancel={cancelEdit}
                commitLabel="Save"
                placeholder="/path/to/project"
                autoFocus
                variant="meta"
              />
            </div>
          ) : (
            <button
              type="button"
              className="kv2-meta-card kv2-meta-card--directory kv2-meta-editable"
              onClick={() => startEditing("projectDir")}
              title={card.projectDir ? card.projectDir : "Click to edit directory"}
            >
              <span className="kv2-meta-label">Directory</span>
              <span className={`kv2-meta-value${card.projectDir ? " kv2-meta-value--mono" : " kv2-meta-placeholder"}`}>
                {directoryValue}
              </span>
            </button>
          )
        ) : (
          <div className="kv2-meta-card kv2-meta-card--directory" title={card.projectDir ?? undefined}>
            <span className="kv2-meta-label">Directory</span>
            <span className={`kv2-meta-value${card.projectDir ? " kv2-meta-value--mono" : " kv2-meta-placeholder"}`}>
              {directoryValue}
            </span>
          </div>
        )}

        {/* TODO 카드의 Command 토글은 사이드바(Queue After 위)로 분리 배치한다.
            IN PROGRESS 이후 읽기 전용 카드만 메타 패널 안에 노출한다. */}
        {!isTodo && (
          <CommandMetaRow
            card={card}
            isTodo={isTodo}
            canEdit={canEdit}
            onUpdate={onUpdate}
          />
        )}
      </div>

      {showAgentMeta && editingField === "agentType" && (
        <div className="kv2-detail-agent-selector">
          <span className="kv2-detail-agent-selector-label">Agent 를 선택해주세요</span>
          <div className="kv2-detail-agent-selector-chips">
          {AGENT_CONFIGS.map((agent) => (
            <button
              key={agent.key}
              type="button"
              className={`kv2-create-agent-chip ${card.agentType === agent.key ? "kv2-create-agent-chip--active" : ""}`}
              onClick={() => {
                if (onUpdate) {
                  const preferred = readAgentModelPreference()[agent.key];
                  const preferredAvailable =
                    preferred && filteredModels.some((m) => m.id === preferred);
                  const modelToUse = preferredAvailable
                    ? preferred
                    : filteredModels.some((m) => m.id === agent.model)
                      ? agent.model
                      : undefined;
                  onUpdate(card.id, { agentType: agent.key, model: modelToUse });
                }
                cancelEdit();
              }}
            >
              {agent.emoji} {agent.label}
            </button>
          ))}
          </div>
        </div>
      )}

      {card.skills && card.skills.length > 0 ? (
        <div className="kv2-context-chips kv2-context-chips--subtle">
          <span className="kv2-context-chip">Skills: {card.skills.join(", ")}</span>
        </div>
      ) : null}

    </div>
  );
};
