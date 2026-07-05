import type { KanbanStore } from '../../core/store';
import type { KanbanStatus } from '../../core/types';
import type { ClaudeStreamEvent } from './claude-stream-parser';

const CHILD_STATUS_MAP: Partial<Record<string, KanbanStatus>> = {
  completed: 'complete',
  in_progress: 'in_progress',
};

export class ChildLinker {
  constructor(private readonly store: KanbanStore) {}

  async onChildEvent(parentCardId: string, runId: string, ev: ClaudeStreamEvent): Promise<void> {
    if (ev.type === 'subagent_started') {
      // Claude CLI emits task_started for BOTH real subagents (task_type 'local_agent',
      // carrying subagent_type + prompt) and background shell commands (task_type
      // 'local_bash', carrying neither). Only real subagents deserve a child card —
      // local_bash tasks have no prompt/agent/response and produce empty junk cards.
      const isAgentTask = ev.taskType === 'local_agent' || Boolean(ev.agentType);
      if (!isAgentTask) return;

      const existing = await this.store.findByChildLink(parentCardId, runId, ev.taskId);
      if (existing) return;
      // Cross-run dedup: after a restart a child may exist under a different runId (reconcile path)
      const allCards = await this.store.getCards();
      if (allCards.some(c => c.parentCardId === parentCardId && c.childTaskId === ev.taskId)) return;

      await this.store.createCard({
        title: ev.description ?? `Subagent (${ev.agentType ?? 'unknown'})`,
        description: ev.prompt ?? '',
        parentCardId,
        linkKind: 'subagent',
        childTaskId: ev.taskId,
        childToolUseId: ev.toolUseId,
        childRunId: runId,
        agentType: ev.agentType,
        agentRuntime: 'claude',
      });
      return;
    }

    if (ev.type === 'subagent_updated') {
      const card = await this.store.findByChildLink(parentCardId, runId, ev.taskId);
      if (!card) return;

      const newStatus = ev.status ? CHILD_STATUS_MAP[ev.status] : undefined;
      if (newStatus && newStatus !== card.status) {
        await this.store.updateCard(card.id, { status: newStatus });
      }
      return;
    }

    if (ev.type === 'subagent_completed') {
      const card = await this.store.findByChildLink(parentCardId, runId, ev.taskId);
      if (!card) return;

      await this.store.updateCard(card.id, {
        status: 'complete',
        result: ev.summary,
        ...(ev.usage?.durationMs !== undefined ? { durationMs: ev.usage.durationMs } : {}),
      });
    }
  }
}
