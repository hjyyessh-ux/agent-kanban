// Build a per-run progress timeline (RunProgressStep[]) from a run's
// events.jsonl lines. Complements usage-aggregator.ts: usage is a distinct-set
// summary persisted onto the card at completion, while progress preserves the
// ordered sequence of intermediate steps and is served on demand (live during
// a run, after the fact for completed cards) — never persisted onto the card.
// Same parsing contract as the aggregator: every malformed or unrelated line
// is skipped silently, best-effort telemetry only.

import type { CardRunProgress, KanbanCard, RunProgressStep } from '../../core/types';
import type { RuntimeRun } from './runtime-run-store';

type JsonRecord = Record<string, unknown>;

// Payload cap: keep the most recent steps so a live in_progress view always
// shows current activity; totalSteps preserves the pre-truncation count.
const MAX_STEPS = 400;
const MAX_DETAIL_LENGTH = 200;
// body is the expandable per-step payload (full command, edit diff, …);
// clipped per side so one giant Write can't blow up the response.
const MAX_BODY_LENGTH = 1600;
const MAX_BODY_SIDE_LENGTH = 700;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function truncateDetail(text: string): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  if (singleLine.length <= MAX_DETAIL_LENGTH) return singleLine;
  return `${singleLine.slice(0, MAX_DETAIL_LENGTH)}…`;
}

function clipBody(text: string, max: number = MAX_BODY_LENGTH): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… (truncated)`;
}

// Unified-diff-style preview of an Edit tool call: old lines prefixed with
// `-`, new lines with `+`. Either side may be absent (pure insert/delete).
function formatEditBody(oldString?: string, newString?: string): string | undefined {
  if (!oldString && !newString) return undefined;
  const prefix = (text: string, sign: string) =>
    clipBody(text, MAX_BODY_SIDE_LENGTH).split('\n').map(line => `${sign} ${line}`).join('\n');
  const parts: string[] = [];
  if (oldString) parts.push(prefix(oldString, '-'));
  if (newString) parts.push(prefix(newString, '+'));
  return parts.join('\n');
}

function parseMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (!server || !tool) return null;
  return { server, tool };
}

// Memory usage heuristic: reads/writes of the persistent-memory markdown files
// (…/memory/<fact>.md or MEMORY.md index). Matched on the file path of
// Read/Write/Edit tool calls.
const MEMORY_TOOL_NAMES = new Set(['Read', 'Write', 'Edit']);

function memoryPathLabel(filePath: string): string | null {
  if (/(^|\/)MEMORY\.md$/.test(filePath)) return 'MEMORY.md';
  const match = filePath.match(/\/memory\/([^/]+\.md)$/);
  if (match) return `memory/${match[1]}`;
  return null;
}

// A one-line hint for generic tool calls, picked from the most descriptive
// input field the tool is known to carry.
function extractToolDetail(input: JsonRecord | undefined): string | undefined {
  if (!input) return undefined;
  const candidate = asString(input.file_path)
    ?? asString(input.path)
    ?? asString(input.pattern)
    ?? asString(input.query)
    ?? asString(input.url)
    ?? asString(input.description)
    ?? asString(input.prompt);
  return candidate ? truncateDetail(candidate) : undefined;
}

// The expandable body of a tool_use step: full command for Bash, old/new diff
// for Edit, written content for Write. Undefined for tools with nothing to show.
function extractToolBody(name: string, input: JsonRecord | undefined): string | undefined {
  if (!input) return undefined;
  if (name === 'Bash') {
    const command = asString(input.command);
    return command ? clipBody(command) : undefined;
  }
  if (name === 'Edit') {
    return formatEditBody(asString(input.old_string), asString(input.new_string));
  }
  if (name === 'Write') {
    const content = asString(input.content);
    return content ? clipBody(content, MAX_BODY_SIDE_LENGTH) : undefined;
  }
  return undefined;
}

interface ClaudeParseOptions {
  // Interactive session transcripts have no system/task_started events, so
  // subagent spawns must be read from the Task/Agent tool_use itself. In the
  // stream-json format both exist and task_started is authoritative — mapping
  // both there would double-count every spawn.
  agentFromTaskToolUse: boolean;
}

function stepsFromClaudeLines(lines: string[], opts: ClaudeParseOptions): RunProgressStep[] {
  const steps: RunProgressStep[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(raw);
    if (!record) continue;

    const type = asString(record.type);

    // Subagent spawn — the authoritative signal in the stream format.
    if (type === 'system' && asString(record.subtype) === 'task_started') {
      const agentType = asString(record.subagent_type);
      const description = asString(record.description);
      // local_bash task_started events (background shells) carry no agent type
      // and are not agent spawns — same filter as child-linker.
      if (!agentType && asString(record.task_type) !== 'local_agent') continue;
      steps.push({
        kind: 'agent',
        label: agentType ?? 'agent',
        ...(description ? { detail: truncateDetail(description) } : {}),
      });
      continue;
    }

    if (type !== 'assistant') continue;
    const content = asRecord(record.message)?.content;
    if (!Array.isArray(content)) continue;

    for (const part of content) {
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== 'tool_use') continue;
      const name = asString(partRecord.name);
      if (!name) continue;
      const input = asRecord(partRecord.input);

      if (name === 'Skill') {
        const skill = asString(input?.skill);
        steps.push({ kind: 'skill', label: skill ?? 'Skill' });
        continue;
      }

      if (name === 'Task' || name === 'Agent') {
        // Stream format: covered by the system/task_started branch above.
        if (!opts.agentFromTaskToolUse) continue;
        const agentType = asString(input?.subagent_type);
        const description = asString(input?.description);
        const prompt = asString(input?.prompt);
        steps.push({
          kind: 'agent',
          label: agentType ?? 'agent',
          ...(description ? { detail: truncateDetail(description) } : {}),
          ...(prompt ? { body: clipBody(prompt, MAX_BODY_SIDE_LENGTH) } : {}),
        });
        continue;
      }

      const mcp = parseMcpName(name);
      if (mcp) {
        steps.push({ kind: 'mcp', label: `${mcp.server} · ${mcp.tool}` });
        continue;
      }

      if (name === 'Bash') {
        const command = asString(input?.command);
        steps.push({
          kind: 'command',
          label: 'Bash',
          ...(command ? { detail: truncateDetail(command) } : {}),
          ...(command && command.length > MAX_DETAIL_LENGTH ? { body: clipBody(command) } : {}),
        });
        continue;
      }

      if (MEMORY_TOOL_NAMES.has(name)) {
        const filePath = asString(input?.file_path);
        const memoryLabel = filePath ? memoryPathLabel(filePath) : null;
        if (memoryLabel) {
          const body = extractToolBody(name, input);
          steps.push({ kind: 'memory', label: memoryLabel, detail: name, ...(body ? { body } : {}) });
          continue;
        }
      }

      const detail = extractToolDetail(input);
      const body = extractToolBody(name, input);
      steps.push({
        kind: 'tool',
        label: name,
        ...(detail ? { detail } : {}),
        ...(body ? { body } : {}),
      });
    }
  }

  return steps;
}

function stepsFromCodexLines(lines: string[]): RunProgressStep[] {
  const steps: RunProgressStep[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(raw);
    if (!record) continue;
    // Count each item once via item.completed (item.started would double count).
    if (asString(record.type) !== 'item.completed') continue;
    const item = asRecord(record.item);
    if (!item) continue;

    const itemType = asString(item.type);
    if (itemType === 'command_execution') {
      const command = asString(item.command);
      steps.push({
        kind: 'command',
        label: 'Shell',
        ...(command ? { detail: truncateDetail(command) } : {}),
        ...(command && command.length > MAX_DETAIL_LENGTH ? { body: clipBody(command) } : {}),
      });
      continue;
    }
    if (itemType === 'file_change') {
      steps.push({ kind: 'tool', label: 'Edit' });
      continue;
    }
    if (itemType === 'mcp_tool_call') {
      const server = asString(item.server);
      const tool = asString(item.tool);
      if (!server) continue;
      steps.push({ kind: 'mcp', label: tool ? `${server} · ${tool}` : server });
    }
  }

  return steps;
}

function summarize(steps: RunProgressStep[]): CardRunProgress['summary'] {
  const skills = new Set<string>();
  const mcpServers = new Set<string>();
  const agents = new Set<string>();
  const memory = new Set<string>();
  const tools = new Set<string>();

  for (const step of steps) {
    if (step.kind === 'skill') skills.add(step.label);
    else if (step.kind === 'mcp') mcpServers.add(step.label.split(' · ')[0]);
    else if (step.kind === 'agent') agents.add(step.label);
    else if (step.kind === 'memory') memory.add(step.label);
    else if (step.kind === 'tool' || step.kind === 'command') tools.add(step.label);
  }

  return {
    skills: [...skills].sort(),
    mcpServers: [...mcpServers].sort(),
    agents: [...agents].sort(),
    memory: [...memory].sort(),
    tools: [...tools].sort(),
  };
}

function assembleProgress(
  meta: Pick<CardRunProgress, 'runId' | 'source' | 'runtime' | 'runStatus' | 'startedAt' | 'finishedAt'>,
  steps: RunProgressStep[],
): CardRunProgress {
  const truncated = steps.length > MAX_STEPS ? steps.slice(steps.length - MAX_STEPS) : steps;
  return {
    ...meta,
    steps: truncated,
    totalSteps: steps.length,
    summary: summarize(steps),
  };
}

/**
 * Assemble the progress payload for a run from its events.jsonl lines.
 * The runtime picks the stream parser; opencode runs never reach here
 * (they have no RuntimeRun / events file).
 */
export function buildRunProgress(run: RuntimeRun, lines: string[]): CardRunProgress {
  const steps = run.runtime === 'codex'
    ? stepsFromCodexLines(lines)
    : stepsFromClaudeLines(lines, { agentFromTaskToolUse: false });

  return assembleProgress({
    runId: run.runId,
    source: 'run',
    runtime: run.runtime,
    runStatus: run.status,
    startedAt: run.startedAt,
    ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
  }, steps);
}

/**
 * Fallback for cards that were never dispatched through a claude/codex run —
 * e.g. cards minted by the UserPromptSubmit hook for an interactive Claude
 * Code session. Parses the session transcript
 * (`~/.claude/projects/<munged-dir>/<sessionId>.jsonl`), whose assistant lines
 * share the tool_use shape with stream-json but carry no system/task_started
 * events (subagents are read from the Task tool_use instead).
 */
export function buildTranscriptProgress(
  card: Pick<KanbanCard, 'sessionId' | 'status' | 'startedAt' | 'createdAt'>,
  lines: string[],
): CardRunProgress {
  const steps = stepsFromClaudeLines(lines, { agentFromTaskToolUse: true });

  return assembleProgress({
    runId: `session-${card.sessionId ?? 'unknown'}`,
    source: 'transcript',
    runtime: 'claude',
    runStatus: card.status === 'in_progress' ? 'running' : 'completed',
    startedAt: card.startedAt ?? card.createdAt,
  }, steps);
}
