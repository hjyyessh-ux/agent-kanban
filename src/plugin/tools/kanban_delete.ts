import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { PluginInput } from '@opencode-ai/plugin';

export function createKanbanDeleteTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'Move a kanban card to trash by ID. Deleted cards are hidden from active views and can be restored from stored state.',
    args: {
      id: z.string().describe('Card ID to delete'),
    },
    async execute(args) {
      const card = await store.getCard(args.id);
      if (!card) {
        return `❌ Card not found: ${args.id}`;
      }
      await store.deleteCard(args.id);
      return `🗑️ Moved kanban card #${args.id} to trash`;
    },
  });
}
