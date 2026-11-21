import type { KanbanStore } from '../../core/store';
import type { AgentRuntime, KanbanStatus } from '../../core/types';
import type { ClaudeStreamEvent } from './claude-stream-parser';

const CHILD_STATUS_MAP: Partial<Record<string, KanbanStatus>> = {
  completed: 'complete',
  in_progress: 'in_progress',
};

export class ChildLinker {
  constructor(private readonly store: KanbanStore) {}

  async onChildEvent(parentCardId: string, runId: string, ev: ClaudeStreamEvent, runtime: AgentRuntime = 'claude'): Promise<void> {
    // Once the parent card is archived it is physically removed from the active
    // board, but its runtime may still be streaming subagent events. Without this
    // guard those late events would recreate child cards (subagent_started) or
    // re-stamp surviving children back to in_progress (subagent_updated) after the
    // user archived the whole session. If the parent is gone, so is its subtree.
    const parent = await this.store.getCard(parentCardId);
    if (!parent) return;

    if (ev.type === 'subagent_started') {
      // Claude CLI emits task_started for BOTH real subagents (task_type 'local_agent',
      // carrying subagent_type + prompt) and background shell commands (task_type
      // 'local_bash', carrying neither). Only real subagents deserve a child card —
      // local_bash tasks have no prompt/agent/response and produce empty junk cards.
      const isAgentTask = ev.taskType === 'local_agent' || Boolean(ev.agentType);
      if (!isAgentTask) return;

      const existing = await this.store.findByChildLink(parentCardId, runId, ev.taskId);
      if (existing) return;
      // Task labels are local to a run. A distinct run owns a distinct child;
      // only replay of this exact run/task tuple is deduplicated above.
      // Never infer continuation or rebind from a reused task label.

      await this.store.reserveNativeChild({
        title: ev.description ?? `Subagent (${ev.agentType ?? 'unknown'})`,
        description: ev.prompt ?? '',
        parentCardId,
        linkKind: 'subagent',
        childTaskId: ev.taskId,
        childToolUseId: ev.toolUseId,
        childRunId: runId,
        agentType: ev.agentType,
        agentRuntime: runtime,
        // Claude task ids are not continuation ids. A Codex native receiver
        // is explicitly a thread, so its id can link that child's session.
        ...(runtime === 'codex' ? { sessionId: ev.taskId } : {}),
      });
      return;
    }

    if (ev.type === 'subagent_updated') {
      const status = ev.status ? CHILD_STATUS_MAP[ev.status] : undefined;
      if (status === 'in_progress' || status === 'complete') {
        await this.store.advanceNativeChild(parentCardId, runId, ev.taskId, { status });
      }
      return;
    }

    if (ev.type === 'subagent_completed') {
      await this.store.advanceNativeChild(parentCardId, runId, ev.taskId, {
        status: 'complete', terminal: true, summary: ev.summary, durationMs: ev.usage?.durationMs,
      });
    }
  }
}
