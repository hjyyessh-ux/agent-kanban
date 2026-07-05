export type CodexJsonlEvent =
  | { type: 'thread_started'; threadId: string }
  | { type: 'turn_completed' }
  | { type: 'agent_message'; text: string }
  | { type: 'error'; message?: string }
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

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

export function parseCodexJsonlLine(line: string): CodexJsonlEvent | null {
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
  const method = asString(raw.method);
  const event = asRecord(raw.event);
  const params = asRecord(raw.params);
  const data = asRecord(raw.data);
  const thread = asRecord(raw.thread);
  const message = asRecord(raw.message);
  const item = asRecord(raw.item);

  if (type === 'thread.started' || method === 'thread/started' || event?.type === 'thread.started') {
    const eventThread = asRecord(event?.thread);
    const eventData = asRecord(event?.data);
    const threadId = firstString(
      raw.thread_id,
      raw.threadId,
      thread?.id,
      thread?.thread_id,
      params?.thread_id,
      params?.threadId,
      data?.thread_id,
      data?.threadId,
      event?.thread_id,
      event?.threadId,
      eventThread?.id,
      eventThread?.thread_id,
      eventData?.thread_id,
      eventData?.threadId,
    );
    return threadId ? { type: 'thread_started', threadId } : { type: 'unknown' };
  }

  if (type === 'session_configured') {
    const threadId = firstString(raw.thread_id, raw.threadId, raw.session_id, raw.sessionId);
    return threadId ? { type: 'thread_started', threadId } : { type: 'unknown' };
  }

  if (type === 'turn.completed' || method === 'turn/completed') {
    return { type: 'turn_completed' };
  }

  const text = extractAgentText(raw, message, item, data);
  if (text) {
    return { type: 'agent_message', text };
  }

  if (type === 'error') {
    return { type: 'error', message: asString(raw.message) ?? asString(data?.message) };
  }

  return { type: 'unknown' };
}

function extractAgentText(
  raw: JsonRecord,
  message: JsonRecord | undefined,
  item: JsonRecord | undefined,
  data: JsonRecord | undefined,
): string {
  const role = asString(raw.role) ?? asString(message?.role) ?? asString(item?.role) ?? asString(data?.role);
  const type = asString(raw.type) ?? asString(item?.type) ?? asString(data?.type);
  if (role && role !== 'assistant') return '';

  const direct = firstString(raw.text, raw.content, message?.text, item?.text, data?.text);
  if (direct && (!role || role === 'assistant')) return direct;

  const content = message?.content ?? item?.content ?? data?.content ?? raw.content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        const record = asRecord(part);
        if (!record) return '';
        if (record.type !== 'text' && record.type !== 'output_text') return '';
        return asString(record.text) ?? '';
      })
      .join('');
  }

  if ((type === 'agent_message' || type === 'message') && direct) return direct;
  return '';
}
