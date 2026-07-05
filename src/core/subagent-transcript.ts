// Parses a Claude Code subagent transcript (JSONL) into an ordered list of
// inter-agent messages. Used at SubagentStop to capture the peer-to-peer thread
// (e.g. "A_NUM:11" / "RESULT 11+30=41 => MATCH") that would otherwise live only
// in the transcript file and never reach the kanban card.
//
// Two message directions are extracted:
//   out — a SendMessage tool_use the subagent emitted (structured, exact).
//   in  — a message the subagent received: the initial dispatch prompt from
//         main, and coordinator-relayed messages wrapped in a known marker.
//
// IN extraction is best-effort and marker-based (the harness wraps relayed
// messages in natural language); OUT extraction is exact. The marker strings
// are Claude Code harness conventions — if the harness changes its wording,
// only IN capture degrades (OUT is unaffected).

import type { AgentMessage } from './types';

const COORD_MARKER = 'The coordinator sent a message while you were working:';
// Everything from this trailer onward is harness boilerplate, not the message.
const COORD_TRAILER = 'Address this before completing your current task.';

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: { to?: unknown; message?: unknown; text?: unknown; summary?: unknown };
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// Flatten an entry's content (string or block array) into its text blocks only.
// tool_result / image / tool_use blocks contribute nothing here.
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(b =>
        b && typeof b === 'object' && (b as ContentBlock).type === 'text'
          ? asString((b as ContentBlock).text) ?? ''
          : '',
      )
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function extractCoordinatorMessage(text: string): string | null {
  const start = text.indexOf(COORD_MARKER);
  if (start === -1) return null;
  let body = text.slice(start + COORD_MARKER.length);
  const trailerIdx = body.indexOf(COORD_TRAILER);
  if (trailerIdx !== -1) body = body.slice(0, trailerIdx);
  return body.trim();
}

// Messages delivered TO a named teammate are wrapped by the harness as
//   <teammate-message teammate_id="NumSix" ...>BODY</teammate-message>
//   <agent-message from="NumSix" ...>BODY</agent-message>
// The sender is the teammate_id / from attribute ("team-lead" = the coordinator/main).
// These are Claude harness conventions; only IN capture degrades if they change.
const WRAPPED_RE = /^\s*<(teammate|agent)-message\b([^>]*)>([\s\S]*?)<\/\1-message>\s*$/;

function extractWrappedMessage(text: string): { from: string; body: string } | null {
  const m = text.match(WRAPPED_RE);
  if (!m) return null;
  const attrs = m[2];
  const idAttr = attrs.match(/(?:teammate_id|from)="([^"]*)"/);
  return { from: idAttr ? idAttr[1] : 'main', body: m[3].trim() };
}

/**
 * Extract the inter-agent message thread from a subagent transcript.
 *
 * @param jsonl       Raw transcript file contents (one JSON object per line).
 * @param initialCap  Max chars to keep for the (potentially long) initial
 *                    dispatch prompt. Other messages are kept whole.
 */
export function extractAgentThread(jsonl: string, initialCap = 4000): AgentMessage[] {
  const messages: AgentMessage[] = [];
  let sawInitialDispatch = false;

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    let entry: { type?: string; message?: { content?: unknown }; content?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // tolerate partial / non-JSON lines
    }

    const content = entry.message?.content ?? entry.content;

    if (entry.type === 'assistant') {
      // OUT: SendMessage tool_use blocks.
      if (Array.isArray(content)) {
        for (const block of content as ContentBlock[]) {
          if (block?.type === 'tool_use' && block.name === 'SendMessage') {
            const input = block.input ?? {};
            messages.push({
              direction: 'out',
              to: asString(input.to),
              summary: asString(input.summary),
              message: asString(input.message) ?? asString(input.text) ?? '',
            });
          }
        }
      }
      continue;
    }

    if (entry.type === 'user') {
      const text = textOf(content);
      if (!text) continue; // tool_result lines etc.

      const cap = (s: string) => (s.length > initialCap ? `${s.slice(0, initialCap)}…` : s);

      // Named teammates receive every message (dispatch, coordinator follow-ups, peer
      // replies) wrapped in <teammate-message>/<agent-message>.
      const wrapped = extractWrappedMessage(text);
      if (wrapped) {
        sawInitialDispatch = true;
        messages.push({ direction: 'in', from: wrapped.from, message: cap(wrapped.body) });
        continue;
      }

      // Anonymous background agents: coordinator follow-ups use a plain-text marker.
      const coord = extractCoordinatorMessage(text);
      if (coord !== null) {
        messages.push({ direction: 'in', from: 'coordinator', message: cap(coord) });
      } else if (!sawInitialDispatch) {
        // First plain user turn is the initial dispatch from main.
        sawInitialDispatch = true;
        messages.push({ direction: 'in', from: 'main', message: cap(text.trim()) });
      }
    }
  }

  return messages;
}
