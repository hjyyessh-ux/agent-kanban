import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { KanbanCard } from '../../core/types';

const HEAD_CHARS = 4_000;
const TAIL_CHARS = 8_000;

interface TranscriptLine {
  message?: {
    role?: string;
    content?: unknown;
  };
}

/**
 * Absolute path of a Claude Code session transcript. The project directory is
 * munged the way Claude Code does it (`/` and `.` → `-`). Shared by the wiki
 * enrichment below and the run-progress transcript fallback.
 */
export function resolveClaudeTranscriptPath(projectDir: string, sessionId: string): string {
  const mungedDir = projectDir.replace(/[/.]/g, '-');
  return join(homedir(), '.claude', 'projects', mungedDir, `${sessionId}.jsonl`);
}

/**
 * Best-effort enrichment: read the Claude Code session transcript
 * (`~/.claude/projects/<munged-dir>/<sessionId>.jsonl`). Returns undefined
 * when unavailable — old sessions get cleaned up, and other runtimes store
 * transcripts elsewhere. Card fields remain the primary wiki source.
 */
export function loadClaudeTranscript(
  card: Pick<KanbanCard, 'agentRuntime' | 'sessionId' | 'projectDir'>,
): string | undefined {
  if (card.agentRuntime !== 'claude' || !card.sessionId || !card.projectDir) {
    return undefined;
  }

  try {
    const transcriptPath = resolveClaudeTranscriptPath(card.projectDir, card.sessionId);
    if (!existsSync(transcriptPath)) {
      return undefined;
    }

    const parts: string[] = [];
    for (const line of readFileSync(transcriptPath, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let entry: TranscriptLine;
      try {
        entry = JSON.parse(line) as TranscriptLine;
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
      if (text.trim()) {
        parts.push(`[${role}] ${text.trim()}`);
      }
    }

    if (parts.length === 0) {
      return undefined;
    }
    const full = parts.join('\n\n');
    if (full.length <= HEAD_CHARS + TAIL_CHARS) {
      return full;
    }
    return `${full.slice(0, HEAD_CHARS)}\n\n... (중략) ...\n\n${full.slice(-TAIL_CHARS)}`;
  } catch {
    return undefined;
  }
}
