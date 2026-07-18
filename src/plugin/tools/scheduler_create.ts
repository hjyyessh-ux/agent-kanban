import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';
import { parseNaturalLanguageToCron, isValidCron, describeCron } from '../../core/cron-parser';
import { validateSchedulerActionInput } from '../../core/scheduling';

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
      actionType: z
        .enum(['bash', 'prompt'])
        .describe('Type of action: "bash" executes a Bash command; "prompt" stores a prompt-based scheduler contract'),
      command: z.string().optional().describe('Bash command to execute (required when actionType is "bash")'),
      cwd: z.string().optional().describe('Working directory for bash execution (optional)'),
      prompt: z.string().optional().describe('Prompt body to dispatch later (required when actionType is "prompt")'),
      projectDir: z.string().optional().describe('Project directory for a prompt scheduler'),
      agentRuntime: z.enum(['opencode', 'codex', 'claude']).optional().describe('Preferred runtime for prompt schedulers'),
      model: z.string().optional().describe('Preferred model for prompt schedulers'),
    },
    async execute(args) {
      // Parse cron — might be natural language
      const parsed = parseNaturalLanguageToCron(args.cron);
      const action = validateSchedulerActionInput(
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
      if (parsed) {
        const cronExpr = parsed.cron;
        const cronDesc = parsed.description ?? describeCron(cronExpr);
        const entry = await store.createEntry({
          name: args.name,
          description: args.description,
          cron: cronExpr,
          cronDescription: cronDesc,
          action,
        });
        engine.scheduleEntry(entry);
        return `⏰ Created scheduler "${entry.name}" (${cronDesc}) [${entry.status}]`;
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
        action,
      });
      engine.scheduleEntry(entry);
      return `⏰ Created scheduler "${entry.name}" (${cronDesc}) [${entry.status}]`;
    },
  });
}
