import type { AgentRuntime } from '../../core/types';
import type { AgentAdapter } from './types';
import { RuntimeDispatchError } from './types';

export function createDisabledAdapter(runtime: Exclude<AgentRuntime, 'opencode'>): AgentAdapter {
  return {
    runtime,
    async start() {
      throw new RuntimeDispatchError(`Dispatch not available for ${runtime} yet`, 501);
    },
  };
}
