import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';

export function createSchedulerDeleteTool(
  store: SchedulerStore,
  engine: SchedulerEngine,
  _input: PluginInput,
) {
  return tool({
    description:
      'Delete a scheduled task. Stops the cron job and removes the entry permanently.',
    args: {
      id: z.string().describe('Scheduler entry ID to delete'),
    },
    async execute(args) {
      // Unschedule before deleting
      engine.unscheduleEntry(args.id);

      await store.deleteEntry(args.id);

      return `⏰ Deleted scheduler #${args.id}`;
    },
  });
}
