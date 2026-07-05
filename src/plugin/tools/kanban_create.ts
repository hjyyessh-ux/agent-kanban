import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { KanbanStore } from '../../core/store';
import type { PluginInput } from '@opencode-ai/plugin';

export function createKanbanCreateTool(store: KanbanStore, _input: PluginInput) {
  return tool({
    description:
      'Create a new kanban card. Returns the created card ID and status.',
    args: {
      title: z.string().describe('Short task summary'),
      description: z.string().describe('Detailed description or user instruction'),
      projectDir: z.string().optional().describe('Project directory context'),
      model: z.string().optional().describe('AI model used for this task'),
      command: z.string().optional().describe('Slash command that initiated this task (e.g., /start-work)'),
      skills: z.array(z.string()).optional().describe('Skills loaded for this task'),
      sourceContext: z.string().optional().describe('Workflow context summary'),
    },
    async execute(args, ctx) {
      // Dedup: if this session already has a top-level card (e.g., from dispatch or
      // chat.message hook), return the existing card instead of creating a duplicate.
      // This prevents the common pattern where a dispatched session's agent calls
      // kanban_create, duplicating the already-dispatched card.
      const existingCards = await store.getCards();
      const existingForSession = existingCards.find(
        c => c.sessionId === ctx.sessionID && !c.parentCardId
      );
      if (existingForSession) {
        // Update the existing card with the new title/description if they differ
        const updates: Record<string, unknown> = {};
        if (args.title && args.title !== existingForSession.title) updates.title = args.title;
        if (args.description && args.description !== existingForSession.description) updates.description = args.description;
        if (args.command) updates.command = args.command;
        if (args.skills) updates.skills = args.skills;
        if (args.sourceContext) updates.sourceContext = args.sourceContext;
        if (Object.keys(updates).length > 0) {
          await store.updateCard(existingForSession.id, updates);
        }
        return `✅ Created kanban card #${existingForSession.id}: ${existingForSession.title} [${existingForSession.status}]`;
      }

      const card = await store.createCard({
        title: args.title,
        description: args.description,
        projectDir: args.projectDir,
        model: args.model,
        sessionId: ctx.sessionID,
        command: args.command,
        skills: args.skills,
        sourceContext: args.sourceContext,
      });
      return `✅ Created kanban card #${card.id}: ${card.title} [${card.status}]`;
    },
  });
}
