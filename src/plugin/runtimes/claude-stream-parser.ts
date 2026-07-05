export type ClaudeStreamEvent =
  | { type: 'system'; subtype: 'init'; sessionId?: string }
  | { type: 'assistant'; text?: string; messageId?: string }
  | { type: 'result'; result?: string; sessionId?: string; totalCostUsd?: number }
  | { type: 'error'; message?: string }
  | { type: 'subagent_started'; taskId: string; toolUseId?: string; agentType?: string; description?: string; prompt?: string; taskType?: string; sessionId?: string }
  | { type: 'subagent_updated'; taskId: string; status?: string; endTime?: number; sessionId?: string }
  | { type: 'subagent_completed'; taskId: string; toolUseId?: string; summary?: string; outputFile?: string; usage?: { totalTokens?: number; durationMs?: number }; sessionId?: string }
  | { type: 'unknown' };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function parseClaudeStreamLine(line: string): ClaudeStreamEvent | null {
  let raw: JsonRecord;
  try {
    const parsed = JSON.parse(line) as unknown;
    const record = asRecord(parsed);
    if (!record) return { type: 'unknown' };
    raw = record;
  } catch {
    return null;
  }

  const type = asString(raw.type);
  if (type === 'system') {
    const subtype = asString(raw.subtype);
    if (subtype === 'init') {
      return {
        type: 'system',
        subtype: 'init',
        sessionId: asString(raw.session_id),
      };
    }
    if (subtype === 'task_started') {
      return {
        type: 'subagent_started',
        taskId: asString(raw.task_id) ?? '',
        toolUseId: asString(raw.tool_use_id),
        agentType: asString(raw.subagent_type),
        description: asString(raw.description),
        prompt: asString(raw.prompt),
        taskType: asString(raw.task_type),
        sessionId: asString(raw.session_id),
      };
    }
    if (subtype === 'task_updated') {
      const patch = asRecord(raw.patch);
      return {
        type: 'subagent_updated',
        taskId: asString(raw.task_id) ?? '',
        status: asString(patch?.status),
        endTime: asNumber(patch?.end_time),
        sessionId: asString(raw.session_id),
      };
    }
    if (subtype === 'task_notification') {
      const usage = asRecord(raw.usage);
      return {
        type: 'subagent_completed',
        taskId: asString(raw.task_id) ?? '',
        toolUseId: asString(raw.tool_use_id),
        summary: asString(raw.summary),
        outputFile: asString(raw.output_file),
        usage: usage
          ? { totalTokens: asNumber(usage.total_tokens), durationMs: asNumber(usage.duration_ms) }
          : undefined,
        sessionId: asString(raw.session_id),
      };
    }
    return { type: 'unknown' };
  }

  if (type === 'assistant') {
    const message = asRecord(raw.message);
    return {
      type: 'assistant',
      text: extractAssistantText(message),
      messageId: asString(message?.id),
    };
  }

  if (type === 'result') {
    return {
      type: 'result',
      result: asString(raw.result),
      sessionId: asString(raw.session_id),
      totalCostUsd: asNumber(raw.total_cost_usd),
    };
  }

  if (type === 'error') {
    return {
      type: 'error',
      message: asString(raw.message),
    };
  }

  return { type: 'unknown' };
}

function extractAssistantText(message: JsonRecord | undefined): string {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map(part => {
      const record = asRecord(part);
      if (!record || record.type !== 'text') return '';
      return asString(record.text) ?? '';
    })
    .join('');
}
