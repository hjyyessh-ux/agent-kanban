import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';
import { parseNaturalLanguageToCron, isValidCron, describeCron } from '../../core/cron-parser';

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
      timezone: z.string().optional().describe('New IANA timezone'),
      actionType: z
        .enum(['shell', 'skill'])
        .optional()
        .describe('New action type'),
      command: z.string().optional().describe('New shell command'),
      skillName: z.string().optional().describe('New skill name'),
      skillInput: z.string().optional().describe('New skill input JSON'),
    },
    async execute(args) {
      const updates: Record<string, unknown> = {};

      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.timezone !== undefined) updates.timezone = args.timezone;

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
        updates.action = {
          type: args.actionType,
          command: args.command,
          skillName: args.skillName,
          skillInput: args.skillInput,
        };
      }

      const updated = await store.updateEntry(args.id, updates);

      // Reschedule with updated config
      engine.scheduleEntry(updated);

      return `⏰ Updated scheduler "${updated.name}" (${updated.cronDescription ?? updated.cron}) [${updated.status}]`;
    },
  });
}
