import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';

export function createSchedulerToggleTool(
  store: SchedulerStore,
  engine: SchedulerEngine,
  _input: PluginInput,
) {
  return tool({
    description:
      'Toggle a scheduled task between active and inactive. Active tasks run on schedule; inactive tasks are paused.',
    args: {
      id: z.string().describe('Scheduler entry ID to toggle'),
    },
    async execute(args) {
      const toggled = await store.toggleEntry(args.id);

      if (toggled.status === 'active') {
        engine.scheduleEntry(toggled);
      } else {
        engine.unscheduleEntry(toggled.id);
      }

      const icon = toggled.status === 'active' ? '🟢' : '⚪';
      return `${icon} Scheduler "${toggled.name}" is now ${toggled.status}`;
    },
  });
}
