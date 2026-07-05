import type { PluginInput } from '@opencode-ai/plugin';
import type { KanbanCard, AgentRuntime, DispatchResult } from '../../core/types';
import type { KanbanStore } from '../../core/store';

export interface AdapterRunResult {
  outcome: 'completed' | 'failed' | 'aborted';
  result: string;
  error?: string;
  durationMs: number;
}

export interface DispatchHandle extends DispatchResult {
  abort: () => void;
  done: Promise<AdapterRunResult>;
}

export interface AdapterStartInput {
  card: KanbanCard;
  prompt: string;
  cwd: string;
  resumeSessionId?: string;
  abortSignal?: AbortSignal;
}

export interface AgentAdapter {
  runtime: AgentRuntime;
  start(input: AdapterStartInput): Promise<DispatchHandle>;
}

export interface RuntimeRegistry {
  pickAdapter(runtime: AgentRuntime): AgentAdapter;
}

export class RuntimeDispatchError extends Error {
  constructor(message: string, readonly statusCode: number = 500) {
    super(message);
    this.name = 'RuntimeDispatchError';
  }
}

export type OpencodeClient = PluginInput['client'];

export interface OpencodeAdapterDeps {
  store: KanbanStore;
  client: OpencodeClient;
  serverUrl: URL;
  selectSession?: (sessionId: string, title: string) => Promise<void>;
  trackDispatch: (sessionId: string, cardId: string, promptText: string) => void;
  buildPromptBody: (card: {
    model?: string;
    agentType?: string;
    description: string;
  }) => {
    model?: { providerID: string; modelID: string };
    agent?: string;
    parts: [{ type: 'text'; text: string }];
  };
  runCommandThenPrompt: (params: {
    runCommand: (options: {
      path: { id: string };
      body: { command: string; arguments: string };
      query?: { directory?: string };
    }) => Promise<unknown>;
    runPrompt: () => Promise<unknown>;
    showToast?: (options: { body: { message: string; variant: 'info' } }) => unknown;
    card: Pick<KanbanCard, 'command' | 'arguments' | 'projectDir' | 'description'>;
    sessionId: string;
  }) => Promise<void>;
}
