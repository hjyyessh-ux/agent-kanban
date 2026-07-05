import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SettingsStore } from '../../core/settings-store';

export function createSettingsGetTool(
  store: SettingsStore,
  _input: PluginInput,
) {
  return tool({
    description: 'Get full details of a single settings entry by ID.',
    args: {
      id: z.string().describe('The settings entry ID'),
    },
    async execute(args) {
      const entry = await store.getEntry(args.id);
      if (!entry) {
        return `Settings entry not found: ${args.id}`;
      }
      return JSON.stringify(entry);
    },
  });
}
