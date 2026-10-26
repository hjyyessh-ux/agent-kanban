import type { AgentRuntime } from '../../core/types';
import { parseClaudeStreamLine } from './claude-stream-parser';
import { parseCodexJsonlLine } from './codex-jsonl-parser';
import { joinResultSegments, lastResultSegment } from './result-segments';

/**
 * Recover ONE card's turn from a session transcript — the source for
 * `POST /api/cards/:id/resync`, which re-pulls a result the card lost (a killed
 * daemon, a Stop hook that never fired, a curl that failed silently).
 *
 * A session holds many cards (one per prompt, plus feedback cards reusing it),
 * so "the session's assistant text" is never the answer. The turn is located by
 * the prompt the card actually sent — matched EXACTLY (trim only), never by
 * time alone. Measured on the live board: every match landed within -0.7s..+11s
 * of the card's anchor, and every miss was a turn whose prompt never reached
 * the CLI (`thread-store conflict`, `session is running in the background`).
 * In those sessions the user kept talking afterwards, so a time-only fallback
 * would have pasted an unrelated conversation onto the card.
 */

/** How far a matched prompt may sit from the card's anchor (createdAt / run startedAt). */
const MATCH_WINDOW_BEFORE_MS = 2 * 60 * 1000;
const MATCH_WINDOW_AFTER_MS = 15 * 60 * 1000;

export interface TurnQuery {
  /** The prompt text the card sent (hook card: `description`; dispatched card: the run's `prompt.md`). */
  prompt: string;
  /** ISO time the prompt was sent at, give or take seconds. */
  anchorAt: string;
}

export interface ExtractedTurn {
  result: string;
  finalResult: string;
  /** The CLI finished the turn (vs. killed / interrupted mid-way). */
  completed: boolean;
  /** Timestamp of the matched prompt entry. */
  promptAt?: string;
}

export type TurnMissReason = 'prompt_not_found' | 'empty_turn';

export type TurnExtraction =
  | { ok: true; turn: ExtractedTurn }
  | { ok: false; reason: TurnMissReason };

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function parseJsonLines(raw: string): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = asRecord(JSON.parse(line));
      if (record) out.push(record);
    } catch {
      // A torn last line (file still being written) is not an error.
    }
  }
  return out;
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Of the candidates whose prompt matched, the one nearest the anchor inside the
 * window. Duplicates are real: a retried dispatch re-sends the same prompt into
 * the same session, and the latest run's anchor is nearest its own copy.
 */
function pickNearest<T extends { at?: number }>(candidates: T[], anchorAt: string): T | undefined {
  const anchor = timeOf(anchorAt);
  if (anchor === undefined) return candidates.length === 1 ? candidates[0] : undefined;
  let best: T | undefined;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate.at === undefined) continue;
    const delta = candidate.at - anchor;
    if (delta < -MATCH_WINDOW_BEFORE_MS || delta > MATCH_WINDOW_AFTER_MS) continue;
    if (Math.abs(delta) < bestDistance) {
      best = candidate;
      bestDistance = Math.abs(delta);
    }
  }
  return best;
}

function buildTurn(segments: string[], completed: boolean, promptAt: unknown, fallbackFinal?: string): TurnExtraction {
  const result = joinResultSegments(segments) || (fallbackFinal?.trim() ?? '');
  if (!result) return { ok: false, reason: 'empty_turn' };
  return {
    ok: true,
    turn: {
      result,
      finalResult: lastResultSegment(segments) || result,
      completed,
      promptAt: typeof promptAt === 'string' ? promptAt : undefined,
    },
  };
}

// ─── Claude Code transcript (~/.claude/projects/<dir>/<sessionId>.jsonl) ───

/**
 * Harness traffic recorded as ordinary `user` entries. Same list as
 * `collect_turn_text` in `.claude/hooks/on-stop.sh` and the card filter in
 * `on-prompt.sh` — keep the three in sync.
 */
const CLAUDE_INJECTED_PREFIXES = [
  'Another Claude session sent a message',
  '<task-notification>',
  '<agent-message',
  '<teammate-message',
];
const CLAUDE_INTERRUPT_PREFIX = '[Request interrupted by user';

function isInjected(text: string): boolean {
  return CLAUDE_INJECTED_PREFIXES.some(prefix => text.startsWith(prefix));
}

/**
 * The prompt text of a real user prompt entry, or undefined for anything else:
 * tool results, harness injections, and `isMeta` entries — skill bodies
 * ("Base directory for this skill: …") land mid-turn as `isMeta` text entries
 * and must not split the turn. Compact summaries are not prompts either.
 */
function claudePromptText(entry: JsonRecord): string | undefined {
  if (entry.type !== 'user' || entry.isSidechain === true) return undefined;
  if (entry.isMeta === true || entry.isCompactSummary === true) return undefined;
  const content = asRecord(entry.message)?.content;
  if (typeof content === 'string') {
    return isInjected(content) || content.startsWith(CLAUDE_INTERRUPT_PREFIX) ? undefined : content;
  }
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === 'tool_result') return undefined;
    if (record.type === 'text' && typeof record.text === 'string') {
      if (isInjected(record.text) || record.text.startsWith(CLAUDE_INTERRUPT_PREFIX)) return undefined;
      texts.push(record.text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

function isClaudeInterrupt(entry: JsonRecord): boolean {
  if (entry.type !== 'user') return false;
  const content = asRecord(entry.message)?.content;
  if (typeof content === 'string') return content.startsWith(CLAUDE_INTERRUPT_PREFIX);
  return Array.isArray(content) && content.some(block => {
    const text = asRecord(block)?.text;
    return typeof text === 'string' && text.startsWith(CLAUDE_INTERRUPT_PREFIX);
  });
}

function claudeAssistantTexts(entry: JsonRecord): string[] {
  if (entry.type !== 'assistant' || entry.isSidechain === true) return [];
  const content = asRecord(entry.message)?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === 'text' && typeof record.text === 'string' && record.text.trim()) texts.push(record.text);
  }
  return texts;
}

/** The edge an entry hangs from; a compact boundary's `parentUuid` is null and `logicalParentUuid` bridges it. */
function claudeParentOf(entry: JsonRecord): string | undefined {
  if (typeof entry.parentUuid === 'string') return entry.parentUuid;
  return typeof entry.logicalParentUuid === 'string' ? entry.logicalParentUuid : undefined;
}

/**
 * The entries of one turn, in file order, plus whether a next prompt follows.
 *
 * A Claude transcript is a TREE, so "everything after the prompt line" is wrong
 * twice over: rewinding (ESC → edit → send) leaves the abandoned attempt in the
 * file next to its replacement, and later prompts may branch off an earlier
 * point. The turn is therefore the prompt's DESCENDANTS, stopping at the next
 * real prompt — a rewound attempt keeps the answer it actually got, and the
 * replacement's card gets its own. Real files have been seen with a
 * `parentUuid` cycle, so the walk carries a visited set; parallel tool calls
 * fan out into sibling branches, so it is a full traversal, not a single path.
 * Files without uuids (old or synthetic) fall back to file order.
 *
 * Not every fan-out is parallel work, though: a regenerated reply, or a
 * background notification the harness delivered twice, forks the turn into
 * alternative continuations. `liveChildren` keeps the latest of each kind so
 * the result is one continuation, not two interleaved.
 *
 * Tree position alone over-collects: a background-task notification is
 * attached to the node that LAUNCHED the task, so a notification arriving
 * turns later still hangs under this prompt. The turn is therefore also cut
 * at the next real prompt in FILE order — a turn's own entries are always
 * written before the next prompt, including a turn that was later rewound away.
 */
function toolResultId(entry: JsonRecord): string | undefined {
  if (entry.type !== 'user') return undefined;
  const content = asRecord(entry.message)?.content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === 'tool_result') return typeof record.tool_use_id === 'string' ? record.tool_use_id : '';
  }
  return undefined;
}

/**
 * Children worth following. Siblings of the same kind are alternatives, not
 * parallel work — two assistant replies, two non-tool user entries, or two
 * results for the same tool call — so only the latest written survives.
 * Different tool calls' results and bookkeeping entries (attachments, system)
 * all stay.
 */
function liveChildren(entries: JsonRecord[], indices: number[]): number[] {
  const latestByKind = new Map<string, number>();
  const kept: number[] = [];
  for (const index of indices) {
    const entry = entries[index];
    const toolId = toolResultId(entry);
    const kind = entry.type === 'assistant'
      ? 'assistant'
      : toolId !== undefined
        ? `tool:${toolId}`
        : entry.type === 'user' ? 'user' : undefined;
    if (!kind) kept.push(index);
    else latestByKind.set(kind, Math.max(latestByKind.get(kind) ?? -1, index));
  }
  return [...kept, ...latestByKind.values()];
}

function claudeTurnEntries(entries: JsonRecord[], promptIndex: number): { turn: JsonRecord[]; nextPromptFound: boolean } {
  const prompt = entries[promptIndex];
  let cutoff = entries.length;
  for (let i = promptIndex + 1; i < entries.length; i++) {
    if (claudePromptText(entries[i]) !== undefined) {
      cutoff = i;
      break;
    }
  }
  const nextPromptFound = cutoff < entries.length;
  if (typeof prompt.uuid !== 'string') return { turn: entries.slice(promptIndex + 1, cutoff), nextPromptFound };

  const children = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    const parent = claudeParentOf(entry);
    if (!parent) return;
    const list = children.get(parent);
    if (list) list.push(index);
    else children.set(parent, [index]);
  });

  const included: number[] = [];
  const seen = new Set<string>([prompt.uuid]);
  const queue: string[] = [prompt.uuid];
  while (queue.length > 0) {
    const uuid = queue.shift() as string;
    const reachable = (children.get(uuid) ?? []).filter(index => index < cutoff);
    for (const index of liveChildren(entries, reachable)) {
      const entry = entries[index];
      included.push(index);
      if (typeof entry.uuid === 'string' && !seen.has(entry.uuid)) {
        seen.add(entry.uuid);
        queue.push(entry.uuid);
      }
    }
  }
  included.sort((a, b) => a - b);
  return { turn: included.map(index => entries[index]), nextPromptFound };
}

export function extractClaudeTurn(raw: string, query: TurnQuery): TurnExtraction {
  const entries = parseJsonLines(raw);
  const expected = query.prompt.trim();

  const candidates: Array<{ index: number; at?: number }> = [];
  entries.forEach((entry, index) => {
    const text = claudePromptText(entry);
    if (text !== undefined && text.trim() === expected) candidates.push({ index, at: timeOf(entry.timestamp) });
  });
  const match = pickNearest(candidates, query.anchorAt);
  if (!match) return { ok: false, reason: 'prompt_not_found' };

  const { turn, nextPromptFound } = claudeTurnEntries(entries, match.index);
  const segments: string[] = [];
  let interrupted = false;
  let lastStopReason: unknown;
  for (const entry of turn) {
    if (isClaudeInterrupt(entry)) interrupted = true;
    if (entry.type === 'assistant' && entry.isSidechain !== true) {
      segments.push(...claudeAssistantTexts(entry));
      lastStopReason = asRecord(entry.message)?.stop_reason;
    }
  }
  const completed = !interrupted && (nextPromptFound || lastStopReason === 'end_turn');
  return buildTurn(segments, completed, entries[match.index].timestamp);
}

// ─── Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl) ───

/**
 * Context Codex itself injects as `user` messages. Measured over the local
 * rollout store: AGENTS.md / environment blocks open every session, and skill
 * bodies, sub-agent notifications and abort notices land MID-turn — none of
 * them is a prompt, so none may start or end a card's slice.
 */
const CODEX_INJECTED_PREFIXES = [
  '# AGENTS.md instructions',
  '<environment_context',
  '<user_instructions',
  '<permissions instructions',
  '<recommended_plugins',
  '<skill',
  '<subagent_notification',
  '<task-notification',
  '<turn_aborted',
  '<image',
  '</image>',
];

type CodexItem =
  | { kind: 'task_started' }
  | { kind: 'task_complete'; lastAgentMessage?: string }
  | { kind: 'prompt'; texts: string[]; at?: number; timestamp?: unknown }
  | { kind: 'text'; text: string };

function codexMessageTexts(payload: JsonRecord, blockType: string): string[] {
  const content = payload.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type === blockType && typeof record.text === 'string') texts.push(record.text);
  }
  return texts;
}

/**
 * The rollout flattened to what matters for slicing. A user message is a
 * prompt when at least one of its blocks is not harness context. Assistant
 * text is read from `response_item` messages only — `item_completed` /
 * `agent_message` events repeat the same text and would double it.
 */
function codexItems(entries: JsonRecord[]): CodexItem[] {
  const items: CodexItem[] = [];
  for (const entry of entries) {
    const payload = asRecord(entry.payload);
    if (!payload) continue;
    if (entry.type === 'event_msg') {
      if (payload.type === 'task_started') items.push({ kind: 'task_started' });
      else if (payload.type === 'task_complete') {
        items.push({
          kind: 'task_complete',
          lastAgentMessage: typeof payload.last_agent_message === 'string' ? payload.last_agent_message : undefined,
        });
      }
      continue;
    }
    if (entry.type !== 'response_item' || payload.type !== 'message') continue;
    if (payload.role === 'user') {
      const texts = codexMessageTexts(payload, 'input_text')
        .filter(text => !CODEX_INJECTED_PREFIXES.some(prefix => text.trimStart().startsWith(prefix)));
      if (texts.length > 0) items.push({ kind: 'prompt', texts, at: timeOf(entry.timestamp), timestamp: entry.timestamp });
    } else if (payload.role === 'assistant') {
      for (const text of codexMessageTexts(payload, 'output_text')) {
        if (text.trim()) items.push({ kind: 'text', text });
      }
    }
  }
  return items;
}

/**
 * A card's slice runs from its prompt to the next prompt or the next task. The
 * next-prompt cut matters because Codex accepts messages typed while a task is
 * running: they join the SAME task (one `task_started` … `task_complete`) but
 * each one minted its own card through the prompt hook.
 */
export function extractCodexTurn(raw: string, query: TurnQuery): TurnExtraction {
  const items = codexItems(parseJsonLines(raw));
  const expected = query.prompt.trim();

  const candidates: Array<{ index: number; at?: number }> = [];
  items.forEach((item, index) => {
    if (item.kind !== 'prompt') return;
    const matches = item.texts.some(text => text.trim() === expected) || item.texts.join('\n').trim() === expected;
    if (matches) candidates.push({ index, at: item.at });
  });
  const match = pickNearest(candidates, query.anchorAt);
  if (!match) return { ok: false, reason: 'prompt_not_found' };

  const segments: string[] = [];
  let completed = false;
  let lastAgentMessage: string | undefined;
  for (let i = match.index + 1; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'text') segments.push(item.text);
    else if (item.kind === 'prompt') {
      completed = true;
      break;
    } else if (item.kind === 'task_complete') {
      completed = true;
      lastAgentMessage = item.lastAgentMessage;
      break;
    } else if (item.kind === 'task_started') {
      // A new task without our task_complete: this one was aborted mid-way.
      break;
    }
  }
  const prompt = items[match.index];
  return buildTurn(segments, completed, prompt.kind === 'prompt' ? prompt.timestamp : undefined, lastAgentMessage);
}

// ─── Fallback: a dispatched run's own events.jsonl ───

/**
 * Re-accumulate a run's result from the stream it recorded, the way the
 * adapters do while it runs — used when the session transcript is gone (Claude
 * Code deletes transcripts after `cleanupPeriodDays`, 30 by default) but the
 * run directory survived. The events file holds exactly one prompt, so there is
 * nothing to match.
 */
export function extractRunEventsTurn(raw: string, runtime: AgentRuntime): TurnExtraction {
  const segments: string[] = [];
  let completed = false;
  let fallbackFinal: string | undefined;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    if (runtime === 'codex') {
      const event = parseCodexJsonlLine(line);
      if (event?.type === 'agent_message') segments.push(event.text);
      else if (event?.type === 'turn_completed') completed = true;
    } else {
      const event = parseClaudeStreamLine(line);
      if (event?.type === 'assistant' && event.text) segments.push(event.text);
      else if (event?.type === 'result') {
        completed = true;
        if (event.result) fallbackFinal = event.result;
      }
    }
  }
  return buildTurn(segments, completed, undefined, fallbackFinal);
}
