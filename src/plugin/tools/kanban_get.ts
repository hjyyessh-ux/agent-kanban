import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { PluginInput } from '@opencode-ai/plugin';

export function createKanbanGetTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'Get full details of a single kanban card by ID.',
    args: {
      id: z.string().describe('Card ID to retrieve'),
    },
    async execute(args) {
      const card = await store.getCard(args.id);
      if (!card) {
        return `❌ Card not found: ${args.id}`;
      }

      const lines = [
        `📌 Card #${card.id}`,
        `  Title: ${card.title}`,
        `  Status: ${card.status}`,
        `  Description: ${card.description}`,
        `  Created: ${card.createdAt}`,
        `  Updated: ${card.updatedAt}`,
      ];
      if (card.sessionId) lines.push(`  Session: ${card.sessionId}`);
      if (card.projectDir) lines.push(`  Project: ${card.projectDir}`);
      if (card.model) lines.push(`  Model: ${card.model}`);
      if (card.progressSummary) lines.push(`  Progress: ${card.progressSummary}`);
      if (card.result) lines.push(`  Result: ${card.result}`);

      return lines.join('\n');
    },
  });
}
