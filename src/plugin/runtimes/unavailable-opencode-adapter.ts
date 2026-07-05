import type { AgentAdapter, AdapterStartInput, DispatchHandle } from './types';
import { RuntimeDispatchError } from './types';
import type { KanbanStore } from '../../core/store';

export const STANDALONE_OPENCODE_UNAVAILABLE_REASON =
  'opencode runtime is unavailable in standalone daemon. Start opencode plugin mode to dispatch opencode cards.';

export function createUnavailableOpencodeAdapter(deps: { store: KanbanStore }): AgentAdapter {
  return {
    runtime: 'opencode',
    async start(input: AdapterStartInput): Promise<DispatchHandle> {
      await deps.store.updateCard(input.card.id, {
        status: 'todo',
        progressSummary: `[failed] ${STANDALONE_OPENCODE_UNAVAILABLE_REASON}`,
      });
      throw new RuntimeDispatchError(STANDALONE_OPENCODE_UNAVAILABLE_REASON, 409);
    },
  };
}
