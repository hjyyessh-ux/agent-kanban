import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { KanbanCard } from '../../core/types';

const HEAD_CHARS = 4_000;
const TAIL_CHARS = 8_000;

/**
 * Which on-disk transcript dialect a located file speaks.
 *
 * Not the same thing as `card.agentRuntime`: the lookup below is driven by file
 * existence, so a card tagged `codex` whose conversation actually lives in the
 * Claude Code transcript directory resolves as `claude`. Everything downstream
 * (the wiki extractor, the run-progress parser, the `@` mention block's jq
 * hint) picks its parser off this value, never off the card.
 */
export type TranscriptFormat = 'claude' | 'codex';

export interface SessionTranscriptLocation {
  path: string;
  format: TranscriptFormat;
}

interface ClaudeTranscriptLine {
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface CodexRolloutLine {
  type?: string;
  payload?: {
    type?: string;
    role?: string;
    content?: unknown;
  };
}

/**
 * Absolute path of a Claude Code session transcript. The project directory is
 * munged the way Claude Code does it (`/` and `.` → `-`).
 */
export function resolveClaudeTranscriptPath(projectDir: string, sessionId: string): string {
  const mungedDir = projectDir.replace(/[/.]/g, '-');
  return join(homedir(), '.claude', 'projects', mungedDir, `${sessionId}.jsonl`);
}

/**
 * Root of the Codex rollout store.
 *
 * `CODEX_HOME` is Codex CLI's own override (it is in `codex --help`), so
 * honouring it is a correctness fix, not a test hook — a user who relocates
 * their Codex home would otherwise get "transcript 없음" on every session. It
 * also gives the tests a seam: without it they had to write fixtures into the
 * real store and glob all 1,376 files of it, which added enough I/O latency to
 * flake the suite's timing-sensitive tests.
 */
function codexSessionsRoot(): string {
  const codexHome = process.env.CODEX_HOME?.trim();
  return join(codexHome || join(homedir(), '.codex'), 'sessions');
}

/**
 * Absolute path of a Codex CLI rollout, or undefined when the thread left none.
 *
 * Codex files by **date**, not by project: `$CODEX_HOME/sessions/YYYY/MM/DD/
 * rollout-<ISO-ish timestamp>-<sessionId>.jsonl`. Two consequences the Claude
 * path does not have:
 *
 * 1. `projectDir` is not an input — a codex session resolves even when the card
 *    never recorded one, so `no_project_dir` is not a codex failure mode.
 * 2. The timestamp in the file name is unknown to us, so the id has to be
 *    matched by glob rather than joined into a path.
 *
 * The scan is three levels deep and readdir-only. Measured on a 1,376-file /
 * 459MB store: 23ms cold, ~1.7ms warm, for both hits and misses. That is the
 * same order as the board parse `GET /api/mentions` already does per request,
 * so this stays uncached — a cache here would mostly serve stale misses for
 * sessions that had just started.
 */
export function resolveCodexTranscriptPath(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  // A session id reaches here from user-controlled data (`@session:` tokens are
  // resolved against card ids, but Works links are stored strings). Glob
  // metacharacters in it would silently widen the match, so refuse anything
  // that is not the uuid-ish shape Codex writes.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return undefined;
  const root = codexSessionsRoot();
  try {
    const glob = new Bun.Glob(`*/*/*/rollout-*-${sessionId}.jsonl`);
    for (const relative of glob.scanSync({ cwd: root, onlyFiles: true })) {
      return join(root, relative);
    }
  } catch {
    // No sessions directory, or an unreadable one. Same as "no transcript".
  }
  return undefined;
}

/**
 * The transcript file for a session, whichever runtime wrote it.
 *
 * Existence decides, and Claude is tried first only because its lookup is a
 * plain `join` — the order carries no preference. Passing the card's runtime in
 * would be *less* accurate: sessions dispatched as codex have been observed
 * with a Claude Code transcript on disk, and the card's runtime is a dispatch
 * intent while this is a question about a file.
 */
export function locateSessionTranscript(
  sessionId: string,
  projectDir?: string,
): SessionTranscriptLocation | undefined {
  if (!sessionId) return undefined;
  if (projectDir) {
    const claudePath = resolveClaudeTranscriptPath(projectDir, sessionId);
    try {
      if (existsSync(claudePath)) return { path: claudePath, format: 'claude' };
    } catch {
      // stat failure is the same as absence.
    }
  }
  const codexPath = resolveCodexTranscriptPath(sessionId);
  return codexPath ? { path: codexPath, format: 'codex' } : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const text = (block as { text?: unknown }).text;
    if (typeof text === 'string') parts.push(text);
  }
  return parts.join('\n');
}

/** `[role] text` turns, oldest first, for one Claude Code transcript. */
function claudeTurns(raw: string): string[] {
  const parts: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: ClaudeTranscriptLine;
    try {
      entry = JSON.parse(line) as ClaudeTranscriptLine;
    } catch {
      continue;
    }
    const role = entry.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = entry.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((c): c is { type: string; text: string } =>
              typeof c === 'object' && c !== null
              && (c as { type?: unknown }).type === 'text'
              && typeof (c as { text?: unknown }).text === 'string')
            .map((c) => c.text)
            .join('\n')
        : '';
    if (text.trim()) parts.push(`[${role}] ${text.trim()}`);
  }
  return parts;
}

/**
 * `[role] text` turns, oldest first, for one Codex rollout.
 *
 * The conversation lives on `type: "response_item"` lines whose
 * `payload.type` is `message`; `payload.role` is `user` / `assistant` /
 * **`developer`**, and the developer turns are the system prompt and harness
 * injections, so they are dropped the way Claude's non-message lines are.
 */
function codexTurns(raw: string): string[] {
  const parts: string[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: CodexRolloutLine;
    try {
      entry = JSON.parse(line) as CodexRolloutLine;
    } catch {
      continue;
    }
    if (entry.type !== 'response_item') continue;
    if (entry.payload?.type !== 'message') continue;
    const role = entry.payload.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = textFromContent(entry.payload.content);
    if (text.trim()) parts.push(`[${role}] ${text.trim()}`);
  }
  return parts;
}

/**
 * Best-effort enrichment: read a session's transcript and flatten it to
 * `[role] text` turns, head/tail-trimmed. Returns undefined when the session
 * left no readable file — old sessions get cleaned up, and opencode keeps no
 * local transcript at all. Card fields remain the primary wiki source.
 */
export function loadSessionTranscript(
  card: Pick<KanbanCard, 'sessionId' | 'projectDir'>,
): string | undefined {
  if (!card.sessionId) return undefined;

  try {
    const located = locateSessionTranscript(card.sessionId, card.projectDir);
    if (!located) return undefined;

    const raw = readFileSync(located.path, 'utf-8');
    const parts = located.format === 'codex' ? codexTurns(raw) : claudeTurns(raw);
    if (parts.length === 0) return undefined;

    const full = parts.join('\n\n');
    if (full.length <= HEAD_CHARS + TAIL_CHARS) return full;
    return `${full.slice(0, HEAD_CHARS)}\n\n... (중략) ...\n\n${full.slice(-TAIL_CHARS)}`;
  } catch {
    return undefined;
  }
}
