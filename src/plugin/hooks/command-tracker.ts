import { getBuiltinCommandDefinition } from '../../core/commands';

/**
 * In-memory tracker for slash commands.
 *
 * `command.execute.before` fires before the command runs.
 * `chat.message` fires once the AI starts responding.
 * This module bridges the two: store the command info, then
 * consume it when the chat message hook creates a card.
 */

interface CommandEntry {
  command: string;
  arguments: string;
  timestamp: number;
  opensCommandWindow: boolean;
}

const commandMap = new Map<string, CommandEntry>();
const TTL_MS = 5 * 60 * 1000; // 5 minutes

const commandWindowMap = new Map<string, number>();
const COMMAND_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Record that a slash command is about to execute for a session.
 */
export function trackCommand(
  sessionID: string,
  command: string,
  args: string,
): void {
  cleanup();
  const opensCommandWindow =
    getBuiltinCommandDefinition(command)?.executionMode === 'command_only';
  commandMap.set(sessionID, {
    command,
    arguments: args,
    timestamp: Date.now(),
    opensCommandWindow,
  });
}

/**
 * Retrieve and remove the tracked command for a session.
 * Returns `undefined` if no command was tracked (or it expired).
 */
export function consumeCommand(
  sessionID: string,
): { command: string; arguments: string } | undefined {
  cleanup();
  const entry = commandMap.get(sessionID);
  if (!entry) return undefined;
  commandMap.delete(sessionID);
  if (entry.opensCommandWindow) {
    commandWindowMap.set(sessionID, Date.now());
  }
  return { command: entry.command, arguments: entry.arguments };
}

/**
 * Returns true if a command was recently consumed for this session,
 * meaning subsequent messages are likely internal command prompts.
 */
export function isInCommandWindow(sessionID: string): boolean {
  cleanup();
  const ts = commandWindowMap.get(sessionID);
  if (!ts) return false;
  return true;
}

export function clearCommandWindow(sessionID: string): void {
  commandWindowMap.delete(sessionID);
}

/**
 * Remove entries older than TTL_MS to prevent memory leaks.
 */
function cleanup(): void {
  const now = Date.now();
  for (const [key, val] of commandMap) {
    if (now - val.timestamp > TTL_MS) {
      commandMap.delete(key);
    }
  }
  for (const [key, val] of commandWindowMap) {
    if (now - val > COMMAND_WINDOW_MS) {
      commandWindowMap.delete(key);
    }
  }
}

// Exported for testing only
export const _testing = { commandMap, commandWindowMap, TTL_MS, COMMAND_WINDOW_MS };
