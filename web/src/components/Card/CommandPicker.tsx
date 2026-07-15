import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRuntime } from "../../../../src/core/types";
import type { CommandId, CommandOption } from "../../constants/commands";

interface CommandPickerProps {
  id: string;
  runtime: AgentRuntime;
  value: CommandId | "";
  commands: CommandOption[];
  onChange: (value: CommandId | "") => void;
  disabled?: boolean;
  variant?: "create" | "meta";
  autoOpen?: boolean;
}

const RUNTIME_LABELS: Record<AgentRuntime, string> = {
  opencode: "Opencode",
  codex: "Codex",
  claude: "Claude",
};

export const CommandPicker: React.FC<CommandPickerProps> = ({
  id,
  runtime,
  value,
  commands,
  onChange,
  disabled = false,
  variant = "create",
  autoOpen = false,
}) => {
  const [isOpen, setIsOpen] = useState(autoOpen && !disabled && !value);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverId = `${id}-listbox`;
  const searchId = `${id}-search`;
  const selectedCommand = useMemo(
    () => commands.find((command) => command.id === value),
    [commands, value],
  );

  const filteredCommands = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((command) =>
      [command.displayName, command.description, command.id, command.parameterSummary]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [commands, query]);

  // Auto-open only for a fresh, unselected picker. When a command is already
  // selected (e.g. reopening a card's meta panel) start closed — the trigger
  // shows the current selection and the user opens the list only to change it.
  useEffect(() => {
    if (autoOpen && !disabled && !value) {
      setIsOpen(true);
    }
  }, [autoOpen, disabled, value]);

  // Reset the query whenever the popover closes, and focus the search box when
  // it opens so the user can type-to-filter immediately.
  useEffect(() => {
    if (!isOpen) {
      setQuery("");
      return;
    }
    searchRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  const selectCommand = (nextValue: CommandId | "") => {
    onChange(nextValue);
    setIsOpen(false);
  };

  return (
    <div
      ref={rootRef}
      className={`kv2-command-picker kv2-command-picker--${variant}${isOpen ? " is-open" : ""}`}
    >
      <div className="kv2-command-control">
        <button
          id={id}
          type="button"
          className={`kv2-command-trigger${!selectedCommand ? " kv2-command-trigger--empty" : ""}`}
          onClick={() => setIsOpen((current) => !current)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          aria-controls={popoverId}
        >
          <span className="kv2-command-icon" aria-hidden="true">/</span>
          <span className="kv2-command-trigger-main">
            {selectedCommand ? selectedCommand.displayName : `${RUNTIME_LABELS[runtime]} command 선택`}
          </span>
          <span className="kv2-command-trigger-arrow" aria-hidden="true">▾</span>
        </button>
      </div>

      {isOpen && !disabled && (
        <div
          id={popoverId}
          className="kv2-command-popover"
          role="listbox"
          aria-label={`${RUNTIME_LABELS[runtime]} command`}
        >
          <div className="kv2-command-popover-head">
            <span>{RUNTIME_LABELS[runtime]} commands</span>
            {value && (
              <button type="button" className="kv2-command-clear" onClick={() => selectCommand("")}>
                선택 해제
              </button>
            )}
          </div>

          <input
            ref={searchRef}
            id={searchId}
            type="text"
            className="kv2-command-search"
            placeholder="command 검색…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            aria-label={`${RUNTIME_LABELS[runtime]} command 검색`}
          />

          {commands.length === 0 ? (
            <div className="kv2-command-empty">
              이 Runtime에서 표시할 command가 없습니다.
            </div>
          ) : filteredCommands.length > 0 ? (
            <div className="kv2-command-list">
              {filteredCommands.map((command) => (
                <button
                  key={command.id}
                  type="button"
                  className={`kv2-command-option${command.id === value ? " is-selected" : ""}`}
                  onClick={() => selectCommand(command.id)}
                  role="option"
                  aria-selected={command.id === value}
                >
                  <span className="kv2-command-option-name">{command.displayName}</span>
                  <span className="kv2-command-option-desc">{command.description}</span>
                  <span className="kv2-command-option-params">파라미터: {command.parameterSummary}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="kv2-command-empty">
              "{query.trim()}"와 일치하는 command가 없습니다.
            </div>
          )}
        </div>
      )}
    </div>
  );
};
