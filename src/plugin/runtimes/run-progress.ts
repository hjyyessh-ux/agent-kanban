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
const START_RECEIPT = '_kanbanCommandStartReceivedAt';

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function claudeBackgroundStartId(record: JsonRecord): string | undefined {
  // Foreground shells can register a task only after they have already run
  // for a while. Promotions are task updates, not initial background starts.
  if (record.type === 'system' && record.subtype === 'task_started'
    && record.task_type === 'local_bash' && record.is_backgrounded === true
    && record.ambient !== true) return asString(record.tool_use_id);
}

function codexCommand(record: JsonRecord): JsonRecord | undefined {
  const item = asRecord(record.item);
  return item?.type === 'command_execution' ? item : undefined;
}

function parseRecord(line: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(line));
  } catch {
    return undefined;
  }
}

// Preserve the runtime event shape for usage and result readers. Only start
// events need ingestion metadata, since the CLI streams omit their timestamp.
export function stampCommandStartReceipt(
  line: string, runtime: RuntimeRun['runtime'], receivedAt: string,
): string {
  const record = parseRecord(line);
  if (!record) return line;
  const isStart = runtime === 'codex'
    ? record.type === 'item.started' && Boolean(asString(codexCommand(record)?.id))
    : Boolean(claudeBackgroundStartId(record));
  return isStart ? JSON.stringify({ ...record, [START_RECEIPT]: receivedAt }) : line;
}

function receiptTime(value: unknown): string | undefined {
  const time = asString(value);
  if (!time || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) return;
  const date = new Date(time);
  if (Number.isFinite(date.getTime())) return date.toISOString();
}

interface CommandStepState {
  step: RunProgressStep;
  hasFullCommand: boolean;
  declined: boolean;
}

// The first observation reserves the row. Full input/completion can enrich it
// in either order, while only a start observation can supply its time.
function recordCommand(
  steps: RunProgressStep[],
  commands: Map<string, CommandStepState>,
  data: { id?: string; label: string; command?: string; startedAt?: string; full?: boolean; declined?: boolean },
): void {
  const { id, label, command, startedAt, full, declined } = data;
  let state = id ? commands.get(id) : undefined;
  if (!state) {
    state = { step: { kind: 'command', label }, hasFullCommand: false, declined: false };
    steps.push(state.step);
    if (id) commands.set(id, state);
  }
  if (full) state.step.label = label;
  if (command && (full || !state.hasFullCommand)) {
    state.step.detail = command;
    state.step.body = command;
    state.hasFullCommand = Boolean(full);
  }
  if (declined) {
    state.declined = true;
    delete state.step.commandStartedAt;
  }
  if (startedAt && !state.declined) state.step.commandStartedAt ??= startedAt;
}

function formatDetail(text: string): string {
  return text;
}

// Unified-diff-style preview of an Edit tool call: old lines prefixed with
// `-`, new lines with `+`. Either side may be absent (pure insert/delete).
function formatEditBody(oldString?: string, newString?: string): string | undefined {
  if (!oldString && !newString) return undefined;
  const prefix = (text: string, sign: string) =>
    text.split('\n').map(line => `${sign} ${line}`).join('\n');
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
  return candidate ? formatDetail(candidate) : undefined;
}

// The expandable body of a tool_use step: full command for Bash, old/new diff
// for Edit, written content for Write. Undefined for tools with nothing to show.
function extractToolBody(name: string, input: JsonRecord | undefined): string | undefined {
  if (!input) return undefined;
  if (name === 'Bash') {
    return asString(input.command);
  }
  if (name === 'Edit') {
    return formatEditBody(asString(input.old_string), asString(input.new_string));
  }
  if (name === 'Write') {
    return asString(input.content);
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
  const commands = new Map<string, CommandStepState>();

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;

    const type = asString(record.type);

    // Subagent spawn — the authoritative signal in the stream format.
    if (type === 'system' && asString(record.subtype) === 'task_started') {
      const agentType = asString(record.subagent_type);
      const description = asString(record.description);
      if (record.task_type === 'local_bash') {
        const id = claudeBackgroundStartId(record);
        if (id) recordCommand(steps, commands, {
          id, label: 'Bash', startedAt: receiptTime(
            opts.agentFromTaskToolUse ? record.timestamp : record[START_RECEIPT],
          ),
        });
        continue;
      }
      if (!agentType && asString(record.task_type) !== 'local_agent') continue;
      steps.push({
        kind: 'agent',
        label: agentType ?? 'agent',
        ...(description ? { detail: formatDetail(description) } : {}),
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
          ...(description ? { detail: formatDetail(description) } : {}),
          ...(prompt ? { body: prompt } : {}),
        });
        continue;
      }

      const mcp = parseMcpName(name);
      if (mcp) {
        steps.push({ kind: 'mcp', label: `${mcp.server} · ${mcp.tool}` });
        continue;
      }

      if (name === 'Bash' || name === 'Monitor') {
        recordCommand(steps, commands, {
          id: asString(partRecord.id), label: name, command: asString(input?.command), full: true,
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
  const commands = new Map<string, CommandStepState>();

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record) continue;
    const commandItem = codexCommand(record);
    const isStart = record.type === 'item.started';
    if (commandItem && (isStart || record.type === 'item.completed')) {
      const id = asString(commandItem.id);
      if (!isStart || id) recordCommand(steps, commands, {
        id, label: 'Shell', command: asString(commandItem.command), full: !isStart,
        startedAt: isStart ? receiptTime(record[START_RECEIPT]) : undefined,
        declined: commandItem.status === 'declined',
      });
      continue;
    }
    if (asString(record.type) !== 'item.completed') continue;
    const item = asRecord(record.item);
    if (!item) continue;

    const itemType = asString(item.type);
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

function rolloutCommand(value: unknown): string | undefined {
  if (!Array.isArray(value)) return asString(value);
  const argv = value.filter((part): part is string => typeof part === 'string');
  const shell = argv[0]?.split('/').at(-1);
  if (argv.length === 3 && shell && /^(bash|dash|fish|ksh|sh|zsh)$/.test(shell)
    && /^-[a-z]*c[a-z]*$/.test(argv[1])) return argv[2];

  return argv.map(arg => /^[a-zA-Z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
}

/**
 * Steps from a **Codex rollout** (`~/.codex/sessions/.../rollout-*.jsonl`).
 *
 * Deliberately not `stepsFromCodexLines`: that one parses `codex exec --json`,
 * which the board dispatch path writes to the run's events.jsonl. The rollout
 * the interactive CLI leaves behind is a different wire format for the same
 * facts — the envelope is `{type: "event_msg", payload: {type: "item_completed",
 * item}}` and the item types are PascalCase (`CommandExecution`) rather than
 * snake_case (`command_execution`). Feeding rollout lines to the exec parser
 * yields zero steps, not an error, so the two must stay separate.
 */
function stepsFromCodexRolloutLines(lines: string[]): RunProgressStep[] {
  const steps: RunProgressStep[] = [];
  const commands = new Map<string, CommandStepState>();

  for (const line of lines) {
    const record = parseRecord(line);
    if (!record || asString(record.type) !== 'event_msg') continue;
    const payload = asRecord(record.payload);
    if (!payload) continue;
    const legacy = payload.type === 'exec_command_begin' || payload.type === 'exec_command_end';
    const isStart = payload.type === 'item_started' || payload.type === 'exec_command_begin';
    if (!legacy && !isStart && payload.type !== 'item_completed') continue;
    const item = legacy ? { ...payload, type: 'CommandExecution', id: payload.call_id } : asRecord(payload.item);
    if (!item) continue;
    if (isStart && item.type !== 'CommandExecution') continue;

    switch (asString(item.type)) {
      case 'CommandExecution': {
        if (item.source === 'unified_exec_interaction') break; // stdin to an existing shell
        const command = rolloutCommand(item.command);
        const itemId = asString(item.id);
        const id = itemId ? JSON.stringify([asString(payload.turn_id), itemId]) : undefined;
        if (!isStart || id) recordCommand(steps, commands, {
          id, label: 'Shell', command, full: !isStart,
          startedAt: isStart ? receiptTime(record.timestamp) : undefined,
          declined: item.status === 'declined',
        });
        break;
      }
      case 'FileChange': {
        steps.push({ kind: 'tool', label: 'Edit' });
        break;
      }
      case 'McpToolCall': {
        const server = asString(item.server);
        const tool = asString(item.tool);
        if (!server) break;
        steps.push({ kind: 'mcp', label: tool ? `${server} · ${tool}` : server });
        break;
      }
      case 'SubAgentActivity': {
        // Only the start: `kind` also carries `completed`/`failed` for the same
        // `agent_path`, and counting those would list every subagent twice.
        if (asString(item.kind) !== 'started') break;
        const agentPath = asString(item.agent_path);
        if (!agentPath) break;
        steps.push({ kind: 'agent', label: agentPath.replace(/^\/+/, '') });
        break;
      }
      case 'Extension': {
        // `kind` is the extension id, e.g. `web.search`.
        const kind = asString(item.kind);
        if (!kind) break;
        const query = asString(item.query);
        steps.push({
          kind: 'tool',
          label: kind,
          ...(query ? { detail: formatDetail(query) } : {}),
        });
        break;
      }
      default:
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
  return {
    ...meta,
    steps,
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
 * cards minted by the UserPromptSubmit hook for an interactive CLI session.
 *
 * `format` is the **file's** dialect as decided by `locateSessionTranscript`,
 * not the card's `agentRuntime`: the lookup is by file existence, so a card
 * tagged one way can legitimately resolve the other runtime's file. Claude's
 * transcript shares the tool_use shape with stream-json but carries no
 * guaranteed system/task_started events for subagents (those steps come
 * from Task tool_use instead). Codex's rollout is its own envelope, see
 * `stepsFromCodexRolloutLines`.
 */
export function buildTranscriptProgress(
  card: Pick<KanbanCard, 'sessionId' | 'status' | 'startedAt' | 'createdAt'>,
  lines: string[],
  format: 'claude' | 'codex' = 'claude',
): CardRunProgress {
  const steps = format === 'codex'
    ? stepsFromCodexRolloutLines(lines)
    : stepsFromClaudeLines(lines, { agentFromTaskToolUse: true });

  return assembleProgress({
    runId: `session-${card.sessionId ?? 'unknown'}`,
    source: 'transcript',
    runtime: format,
    runStatus: card.status === 'in_progress' ? 'running' : 'completed',
    startedAt: card.startedAt ?? card.createdAt,
  }, steps);
}
