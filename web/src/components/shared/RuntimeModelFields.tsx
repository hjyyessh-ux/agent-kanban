import React from "react";
import type { RuntimeCatalogEntry } from "../../../../src/core/runtime-config";
import type { AgentRuntime } from "../../../../src/core/types";
import { RuntimeBadgeIcon } from "../Board/BoardCardSections";
import type { RuntimeModelOption } from "../../hooks/useRuntimeModelSelection";

interface RuntimeModelFieldsProps {
  runtime: AgentRuntime;
  model: string;
  orderedRuntimes: RuntimeCatalogEntry[];
  displayedModels: RuntimeModelOption[];
  disabled?: boolean;
  runtimeInputId: string;
  modelInputId: string;
  onRuntimeChange: (runtime: AgentRuntime) => void;
  onModelChange: (model: string) => void;
  className?: string;
  modelLabel?: string;
  layoutVariant?: "default" | "scheduler";
  selectorVariant?: "chips" | "cards";
}

function getNextEnabledRuntime(
  orderedRuntimes: RuntimeCatalogEntry[],
  runtime: AgentRuntime,
  direction: 1 | -1,
): AgentRuntime {
  const enabled = orderedRuntimes.filter((entry) => !entry.disabled && entry.available !== false);
  if (enabled.length === 0) {
    return runtime;
  }

  const currentIndex = enabled.findIndex((entry) => entry.runtime === runtime);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (startIndex + direction + enabled.length) % enabled.length;
  return enabled[nextIndex]?.runtime ?? runtime;
}

export const RuntimeModelFields: React.FC<RuntimeModelFieldsProps> = ({
  runtime,
  model,
  orderedRuntimes,
  displayedModels,
  disabled = false,
  runtimeInputId,
  modelInputId,
  onRuntimeChange,
  onModelChange,
  className,
  modelLabel = "Model",
  layoutVariant = "default",
  selectorVariant = "chips",
}) => (
  <div
    className={[
      "runtime-model-fields",
      `runtime-model-fields--${layoutVariant}`,
      className,
    ]
      .filter(Boolean)
      .join(" ")}
  >
    <div className="kv2-create-field runtime-model-fields__runtime">
      <div className="kv2-create-label" id={runtimeInputId}>Runtime</div>
      <div
        className={[
          "kv2-create-agent-row",
          "runtime-model-fields__runtime-grid",
          selectorVariant === "cards" ? "runtime-model-fields__runtime-grid--cards" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        role="radiogroup"
        aria-labelledby={runtimeInputId}
        onKeyDown={(event) => {
          if (event.key !== "ArrowRight" && event.key !== "ArrowDown" && event.key !== "ArrowLeft" && event.key !== "ArrowUp") {
            return;
          }
          event.preventDefault();
          const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
          onRuntimeChange(getNextEnabledRuntime(orderedRuntimes, runtime, direction));
        }}
      >
        {orderedRuntimes.map((entry) => {
          const unavailable = entry.disabled || entry.available === false;
          const active = runtime === entry.runtime;
          return (
            <button
              key={entry.runtime}
              type="button"
              className={[
                "kv2-create-agent-chip",
                `kv2-create-agent-chip--runtime-${entry.runtime}`,
                selectorVariant === "cards" ? "kv2-create-agent-chip--selector-card" : "",
                active ? "kv2-create-agent-chip--active" : "",
                unavailable ? "kv2-create-agent-chip--unavailable" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                if (unavailable) return;
                onRuntimeChange(entry.runtime);
              }}
              disabled={disabled || unavailable}
              title={entry.unavailableReason}
              role="radio"
              aria-checked={active}
            >
              <span className={`kv2-create-agent-chip-icon kv2-create-agent-chip-icon--${entry.runtime}`} aria-hidden="true">
                <RuntimeBadgeIcon runtime={entry.runtime} />
              </span>
              <span className="kv2-create-agent-chip-copy">
                <span className="kv2-create-agent-chip-label">{entry.label}</span>
                {unavailable && <span className="kv2-create-agent-chip-badge">Unavailable</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>

    <div className="kv2-create-field runtime-model-fields__model">
      <label className="kv2-create-label" htmlFor={modelInputId}>{modelLabel}</label>
      <select
        id={modelInputId}
        className="kv2-create-select"
        value={model}
        onChange={(event) => onModelChange(event.target.value)}
        disabled={disabled}
      >
        <option value="">-- Default model --</option>
        {displayedModels.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  </div>
);
