import type { AgentRuntime } from '../../core/types';
import type { AgentAdapter, RuntimeRegistry } from './types';

export function createRuntimeRegistry(adapters: AgentAdapter[]): RuntimeRegistry {
  const byRuntime = new Map<AgentRuntime, AgentAdapter>();
  for (const adapter of adapters) {
    if (byRuntime.has(adapter.runtime)) {
      throw new Error(`Duplicate runtime adapter: ${adapter.runtime}`);
    }
    byRuntime.set(adapter.runtime, adapter);
  }

  return {
    pickAdapter(runtime: AgentRuntime): AgentAdapter {
      const adapter = byRuntime.get(runtime);
      if (!adapter) {
        throw new Error(`Dispatch not available for ${runtime} yet`);
      }
      return adapter;
    },
  };
}
