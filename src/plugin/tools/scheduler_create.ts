import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';
import { parseNaturalLanguageToCron, isValidCron, describeCron } from '../../core/cron-parser';

export function createSchedulerCreateTool(
  store: SchedulerStore,
  engine: SchedulerEngine,
  _input: PluginInput,
) {
  return tool({
    description:
      'Create a new scheduled task. Supports cron expressions or natural language like "every 5 minutes". Returns the created scheduler entry.',
    args: {
      name: z.string().describe('Short name for the scheduled task'),
      description: z.string().describe('What this scheduled task does'),
      cron: z
        .string()
        .describe(
          'Cron expression (e.g., "*/5 * * * *") or natural language (e.g., "every 5 minutes", "매일 오전 9시")',
        ),
      timezone: z.string().optional().describe('IANA timezone (e.g., "Asia/Seoul"). Defaults to system timezone.'),
      actionType: z
        .enum(['shell', 'skill'])
        .describe('Type of action: "shell" for shell commands (no token cost), "skill" for skill invocation (⚠️ uses tokens)'),
      command: z.string().optional().describe('Shell command to execute (required when actionType is "shell")'),
      skillName: z.string().optional().describe('Skill name to invoke (required when actionType is "skill")'),
      skillInput: z.string().optional().describe('JSON string of skill arguments (optional, for actionType "skill")'),
    },
    async execute(args) {
      // Parse cron — might be natural language
      const parsed = parseNaturalLanguageToCron(args.cron);
      if (parsed) {
        const cronExpr = parsed.cron;
        const cronDesc = parsed.description ?? describeCron(cronExpr);
        const entry = await store.createEntry({
          name: args.name,
          description: args.description,
          cron: cronExpr,
          cronDescription: cronDesc,
          timezone: args.timezone,
          action: {
            type: args.actionType,
            command: args.command,
            skillName: args.skillName,
            skillInput: args.skillInput,
          },
        });
        engine.scheduleEntry(entry);
        const warning = args.actionType === 'skill' ? ' ⚠️ Skill actions consume LLM tokens on each run.' : '';
        return `⏰ Created scheduler "${entry.name}" (${cronDesc}) [${entry.status}]${warning}`;
      }
      // Not NL — try as raw cron
      if (!isValidCron(args.cron)) {
        return `❌ Invalid cron expression or unrecognized schedule: "${args.cron}"`;
      }

      // Raw cron path
      const cronDesc = describeCron(args.cron);
      const entry = await store.createEntry({
        name: args.name,
        description: args.description,
        cron: args.cron,
        cronDescription: cronDesc,
        timezone: args.timezone,
        action: {
          type: args.actionType,
          command: args.command,
          skillName: args.skillName,
          skillInput: args.skillInput,
        },
      });
      engine.scheduleEntry(entry);
      const warning = args.actionType === 'skill' ? ' ⚠️ Skill actions consume LLM tokens on each run.' : '';
      return `⏰ Created scheduler "${entry.name}" (${cronDesc}) [${entry.status}]${warning}`;
    },
  });
}
