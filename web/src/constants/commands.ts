import type { AgentRuntime } from '../../../src/core/types';
import {
  getAllCommandEntries,
  getCommandDefinitionById,
  getDynamicSkillCommandIds,
  type BuiltinCommandDefinition,
  type BuiltinCommandExecutionMode,
} from '../../../src/core/commands';

export const COMMAND_FILTER_KEY = 'kanban-enabled-commands';

// Command ids are no longer a closed union: skills discovered on disk register
// dynamic ids at runtime, so we widen to string and resolve definitions through
// `getCommandHint`/`getCommandDefinitionById` rather than indexing a static map.
export type CommandId = string;
export type CommandExecutionMode = BuiltinCommandExecutionMode;

export interface CommandOption {
  id: CommandId;
  runtime: AgentRuntime;
  displayName: string;
  description: string;
  argumentPlaceholder: string;
  parameterSummary: string;
  executionMode: CommandExecutionMode;
}

function toOption(id: string, definition: BuiltinCommandDefinition): CommandOption {
  return {
    id,
    runtime: definition.runtime,
    displayName: definition.displayName ?? `/${id}`,
    description: definition.description,
    argumentPlaceholder: definition.argumentPlaceholder,
    parameterSummary: definition.parameterSummary,
    executionMode: definition.executionMode,
  };
}

/** All commands — static tables plus any dynamically registered skills. */
export function getAllCommands(): CommandOption[] {
  return getAllCommandEntries().map(({ id, definition }) => toOption(id, definition));
}

/** Safe definition lookup that includes dynamic skills (never throws on unknown ids). */
export function getCommandHint(commandId: string | undefined): BuiltinCommandDefinition | undefined {
  return getCommandDefinitionById(commandId);
}

export function formatCommandName(commandId: string | undefined): string {
  if (!commandId) return '';
  return getCommandDefinitionById(commandId)?.displayName ?? `/${commandId}`;
}

export function parseStoredEnabledCommandIds(stored: string | null): Set<string> | null {
  if (!stored) return null;
  const enabledIds = new Set<string>(JSON.parse(stored));
  // Auto-enable disk-discovered skill commands for users whose stored preference
  // predates them, so newly added skills surface without a manual Settings toggle.
  const discoveredSkillIds = getDynamicSkillCommandIds();
  const hasPreference = discoveredSkillIds.some((id) => enabledIds.has(id));
  if (!hasPreference) {
    discoveredSkillIds.forEach((id) => enabledIds.add(id));
  }
  return enabledIds;
}

export function getCommandsForRuntime(runtime: AgentRuntime): CommandOption[] {
  return getAllCommands().filter((command) => command.runtime === runtime);
}

export function getFilteredCommandsForRuntime(runtime: AgentRuntime): CommandOption[] {
  const runtimeCommands = getCommandsForRuntime(runtime);
  try {
    const enabledIds = parseStoredEnabledCommandIds(localStorage.getItem(COMMAND_FILTER_KEY));
    if (!enabledIds) return runtimeCommands;
    return runtimeCommands.filter((command) => enabledIds.has(command.id));
  } catch {
    return runtimeCommands;
  }
}

export function isCommandAvailableForRuntime(commandId: string | undefined, runtime: AgentRuntime): boolean {
  if (!commandId) return true;
  return getCommandsForRuntime(runtime).some((command) => command.id === commandId);
}
