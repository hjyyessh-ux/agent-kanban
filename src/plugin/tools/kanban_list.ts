import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { PluginInput } from '@opencode-ai/plugin';

export function createKanbanListTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'List kanban cards, optionally filtered by status. Returns a formatted board summary.',
    args: {
      status: z
        .enum(['todo', 'in_progress', 'complete', 'done'])
        .optional()
        .describe('Filter cards by status'),
    },
    async execute(args) {
      const cards = await store.getCards(
        args.status ? { status: args.status } : undefined,
      );

      if (cards.length === 0) {
        const suffix = args.status ? ` with status "${args.status}"` : '';
        return `📋 Kanban Board: No cards found${suffix}.`;
      }

      const lines = cards.map(
        (c) => `  [${c.status}] #${c.id} — ${c.title}`,
      );
      return `📋 Kanban Board (${cards.length} card${cards.length === 1 ? '' : 's'}):\n${lines.join('\n')}`;
    },
  });
}
