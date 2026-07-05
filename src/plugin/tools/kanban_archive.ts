import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { PluginInput } from '@opencode-ai/plugin';

export function createKanbanArchiveTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'Archive completed (done) kanban cards. Moves them from active board to monthly archive files. Optionally specify card IDs to archive specific cards.',
    args: {
      cardIds: z.array(z.string()).optional().describe('Specific card IDs to archive (must be done). If omitted, archives ALL done cards.'),
    },
    async execute(args) {
      const result = await store.archiveCards(args.cardIds);
      if (result.archivedCount === 0) {
        return '📦 No done cards to archive.';
      }
      return `📦 Archived ${result.archivedCount} card(s) to ${result.archiveMonth}`;
    },
  });
}
