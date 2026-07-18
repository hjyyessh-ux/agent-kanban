import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';
import { parseNaturalLanguageToCron, isValidCron, describeCron } from '../../core/cron-parser';
import { validateSchedulerActionInput } from '../../core/scheduling';

export function createSchedulerUpdateTool(
  store: SchedulerStore,
  engine: SchedulerEngine,
  _input: PluginInput,
) {
  return tool({
    description:
      'Update an existing scheduled task. Can change name, description, cron, action, etc.',
    args: {
      id: z.string().describe('Scheduler entry ID to update'),
      name: z.string().optional().describe('New name'),
      description: z.string().optional().describe('New description'),
      cron: z
        .string()
        .optional()
        .describe('New cron expression or natural language'),
      actionType: z
        .enum(['bash', 'prompt'])
        .optional()
        .describe('New action type'),
      command: z.string().optional().describe('New bash command'),
      cwd: z.string().optional().describe('New bash working directory'),
      prompt: z.string().optional().describe('New prompt body'),
      projectDir: z.string().optional().describe('New prompt project directory'),
      agentRuntime: z.enum(['opencode', 'codex', 'claude']).optional().describe('New prompt runtime'),
      model: z.string().optional().describe('New prompt model'),
    },
    async execute(args) {
      const updates: Record<string, unknown> = {};

      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;

      if (args.cron !== undefined) {
        const parsed = parseNaturalLanguageToCron(args.cron);
        if (parsed) {
          updates.cron = parsed.cron;
          updates.cronDescription = parsed.description ?? describeCron(parsed.cron);
        } else if (isValidCron(args.cron)) {
          updates.cron = args.cron;
          updates.cronDescription = describeCron(args.cron);
        } else {
          return `❌ Invalid cron expression or unrecognized schedule: "${args.cron}"`;
        }
      }

      if (args.actionType !== undefined) {
        updates.action = validateSchedulerActionInput(
          args.actionType === 'bash'
            ? {
                type: 'bash',
                command: args.command,
                cwd: args.cwd,
              }
            : {
                type: 'prompt',
                prompt: args.prompt,
                projectDir: args.projectDir,
                agentRuntime: args.agentRuntime,
                model: args.model,
              },
        );
      }

      const updated = await store.updateEntry(args.id, updates);

      // Reschedule with updated config
      engine.scheduleEntry(updated);

      return `⏰ Updated scheduler "${updated.name}" (${updated.cronDescription ?? updated.cron}) [${updated.status}]`;
    },
  });
}
