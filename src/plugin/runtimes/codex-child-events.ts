import type { ClaudeStreamEvent } from './claude-stream-parser';
import type { CodexJsonlEvent } from './codex-jsonl-parser';

/** Only a recorded native spawn establishes a new child. Waits on unrelated
 * threads, tool failures, normal command execution, and organic CLI hooks do not. */
export function codexChildEvents(event: CodexJsonlEvent, parentThreadId: string | undefined): ClaudeStreamEvent[] {
  if (event.type !== 'collab_tool_call' || !parentThreadId || event.senderThreadId !== parentThreadId) return [];
  const receiverIds = [...new Set(event.receivers)].filter(id => id !== parentThreadId);
  const events: ClaudeStreamEvent[] = [];
  for (const taskId of receiverIds) {
    if (event.tool === 'spawn_agent') {
      events.push({ type: 'subagent_started', taskId, taskType: 'local_agent', description: 'Codex subagent', prompt: event.prompt });
      events.push({ type: 'subagent_updated', taskId, status: 'in_progress' });
    }
    const state = event.states.find(entry => entry.threadId === taskId);
    if (state?.status === 'completed') {
      events.push({ type: 'subagent_completed', taskId, summary: state.message });
    }
  }
  return events;
}
