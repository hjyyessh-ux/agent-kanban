import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SchedulerStore } from '../../core/scheduler-store';
import type { SchedulerEngine } from '../scheduler-engine';

export function createSchedulerRunTool(
  _store: SchedulerStore,
  engine: SchedulerEngine,
  _input: PluginInput,
) {
  return tool({
    description:
      'Manually run a scheduled task immediately, regardless of its cron schedule.',
    args: {
      id: z.string().describe('Scheduler entry ID to run'),
    },
    async execute(args) {
      const run = await engine.executeEntry(args.id);

      if (run.status === 'success') {
        const stdout = run.stdout?.trim();
        const output = stdout ? `\nOutput:\n${stdout}` : '';
        return `✅ Scheduler run completed successfully (exit code: ${run.exitCode ?? 0})${output}`;
      }

      const error = run.error ?? run.stderr?.trim() ?? 'Unknown error';
      return `❌ Scheduler run failed: ${error}`;
    },
  });
}
