import { tool } from '@opencode-ai/plugin';
const z = tool.schema;
import type { PluginInput } from '@opencode-ai/plugin';
import type { SettingsStore } from '../../core/settings-store';

export function createSettingsListTool(
  store: SettingsStore,
  _input: PluginInput,
) {
  return tool({
    description:
      'List all settings entries. Returns a formatted board summary.',
    args: {},
    async execute() {
      const entries = await store.getEntries();

      if (entries.length === 0) {
        return '⚙ Settings: No entries found.';
      }

      const lines = entries.map((e) => {
        const masked = e.masked !== false ? '***' : e.value;
        return `  🔑 #${e.id} — ${e.key}: ${masked}${e.category ? ` [${e.category}]` : ''}`;
      });

      return `⚙ Settings (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}):\n${lines.join('\n')}`;
    },
  });
}
