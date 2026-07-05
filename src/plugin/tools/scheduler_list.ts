import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';

export function createSchedulerListTool(
  store: SchedulerStore,
  _engine: SchedulerEngine,
  _input: PluginInput,
) {
  return tool({
    description:
      'List all scheduled tasks, optionally filtered by status. Returns a formatted summary.',
    args: {
      status: z
        .enum(['active', 'inactive'])
        .optional()
        .describe('Filter by scheduler status'),
    },
    async execute(args) {
      let entries = await store.getEntries();

      if (args.status) {
        entries = entries.filter((e) => e.status === args.status);
      }

      if (entries.length === 0) {
        const suffix = args.status ? ` with status "${args.status}"` : '';
        return `⏰ Scheduler: No entries found${suffix}.`;
      }

      const lines = entries.map((e) => {
        const statusIcon = e.status === 'active' ? '🟢' : '⚪';
        const lastRun = e.lastRunAt
          ? ` | Last: ${new Date(e.lastRunAt).toLocaleString()}`
          : '';
        return `  ${statusIcon} [${e.status}] #${e.id} — ${e.name} (${e.cronDescription ?? e.cron})${lastRun}`;
      });

      return `⏰ Scheduler (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}):\n${lines.join('\n')}`;
    },
  });
}
