import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { UpdateCardInput } from '../../core/types';
import type { PluginInput } from '@opencode-ai/plugin';

export function createKanbanUpdateTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'Update a kanban card (status, progress, result). Returns the updated card summary.',
    args: {
      id: z.string().describe('Card ID to update'),
      status: z
        .enum(['todo', 'in_progress', 'complete', 'done'])
        .optional()
        .describe('New status'),
      progressSummary: z
        .string()
        .optional()
        .describe('Progress summary (for in_progress cards)'),
      result: z
        .string()
        .optional()
        .describe('Completion result (for complete cards)'),
      model: z
        .string()
        .optional()
        .describe('AI model to use for this task (e.g., anthropic/claude-sonnet-4-5)'),
      queuedAfterCardId: z
        .string()
        .optional()
        .describe('Card ID to queue after. Pass empty string to remove from queue.'),
      queuePosition: z
        .number()
        .optional()
        .describe('Position in queue (1 = next). Auto-calculated if not provided.'),
      queueSessionMode: z
        .enum(['new_session', 'continue_queued_after_session'])
        .optional()
        .describe('How a queued card should choose its session when it starts.'),
      resumeSessionId: z
        .string()
        .optional()
        .describe('Session ID to resume when dispatching. Pass empty string to clear.'),
    },
    async execute(args) {
      const updateInput: UpdateCardInput = {};
      if (args.status !== undefined) updateInput.status = args.status;
      if (args.progressSummary !== undefined) updateInput.progressSummary = args.progressSummary;
      if (args.result !== undefined) updateInput.result = args.result;
      if (args.model !== undefined) updateInput.model = args.model;
      if (args.queuedAfterCardId !== undefined) {
        updateInput.queuedAfterCardId = args.queuedAfterCardId === '' ? null : args.queuedAfterCardId;
      }
      if (args.queuePosition !== undefined) {
        updateInput.queuePosition = args.queuePosition;
      }
      if (args.queueSessionMode !== undefined) {
        updateInput.queueSessionMode = args.queueSessionMode;
      }
      if (args.resumeSessionId !== undefined) {
        updateInput.resumeSessionId = args.resumeSessionId === '' ? null : args.resumeSessionId;
      }
      const updated = await store.updateCard(args.id, updateInput);
      return `✅ Updated card #${updated.id}: status=${updated.status}`;
    },
  });
}
