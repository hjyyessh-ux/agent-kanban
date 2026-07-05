import type { Hooks, PluginInput } from '@opencode-ai/plugin';
import type { KanbanStore } from '../../core/store';
import type { SettingsStore } from '../../core/settings-store';
import type { DispatchResult } from '../../core/types';
import { createChatMessageHook } from './chat-message';
import { createEventHandler } from './event-handler';
import { trackCommand } from './command-tracker';

/**
 * Creates all event hook handlers for the kanban plugin.
 *
 * Returns a partial `Hooks` object containing:
 * - `chat.message`: Creates a card when user sends a message, moves to in_progress
 * - `event`: Handles session.idle → updates in_progress card to complete
 *           and auto-dispatches queued cards via dispatchFn
 */
export function createEventHooks(
  store: KanbanStore,
  input: PluginInput,
  dispatchFn?: (cardId: string) => Promise<DispatchResult | { sessionId: string }>,
  settingsStore?: SettingsStore,
  onSessionComplete?: (sessionId: string) => void,
): Pick<Hooks, 'chat.message' | 'event' | 'command.execute.before'> {
  return {
    'chat.message': createChatMessageHook(store, input),
    event: createEventHandler(store, input, dispatchFn, settingsStore, onSessionComplete),
    'command.execute.before': async (hookInput) => {
      trackCommand(hookInput.sessionID, hookInput.command, hookInput.arguments);
    },
  };
}
