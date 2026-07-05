// Aggregate tool/skill/MCP/subagent usage from a run's events.jsonl lines into
// a CardUsageStats. Self-contained parser (does not reuse claude-stream-parser
// so it has no side effects on the streaming path). Every malformed or
// unrelated line is skipped silently — aggregation is best-effort telemetry.
//
// events.jsonl format (Claude stream): each line is one JSON event.
//   - assistant.message.content[] items with type==='tool_use' carry the
//     tool `name` (and `input` for Skill).
//   - system/task_started events carry `subagent_type` for spawned subagents.
//
// events.jsonl format (Codex stream): each line is one JSON event with
// type==='item.completed' wrapping an `item` whose `type` is one of
// command_execution (shell, including the command string), file_change
// (apply_patch) or mcp_tool_call ({server, tool}). Codex has no Skill/subagent concept in its stream, so
// those buckets stay empty. See aggregateCodexUsage below.

import type { CardUsageStats } from '../../core/types';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

// Decompose an MCP tool name `mcp__<server>__<tool>` into its parts. The server
// segment is everything up to the first `__` after the prefix; the tool is the
// remainder (which may itself contain `__`). Returns null for non-MCP names.
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

// Mutable buckets shared by the per-line parsers below; finalize() turns them
// into a CardUsageStats, attaching only the buckets that have signal.
interface UsageAccumulator {
  tools: Record<string, number>;
  mcpTools: Record<string, number>;
  mcpServers: Set<string>;
  commands: string[];
  skillsUsed: Set<string>;
  subagents: Set<string>;
}

function newAccumulator(): UsageAccumulator {
  return {
    tools: {},
    mcpTools: {},
    mcpServers: new Set<string>(),
    commands: [],
    skillsUsed: new Set<string>(),
    subagents: new Set<string>(),
  };
}

function finalize(acc: UsageAccumulator): CardUsageStats {
  const stats: CardUsageStats = { updatedAt: new Date().toISOString() };
  if (Object.keys(acc.tools).length) stats.tools = acc.tools;
  if (acc.mcpServers.size) stats.mcpServers = [...acc.mcpServers].sort();
  if (Object.keys(acc.mcpTools).length) stats.mcpTools = acc.mcpTools;
  if (acc.commands.length) stats.commands = acc.commands;
  if (acc.skillsUsed.size) stats.skillsUsed = [...acc.skillsUsed].sort();
  if (acc.subagents.size) stats.subagents = [...acc.subagents].sort();
  return stats;
}

// Each line of JSON is parsed and handed to `onRecord`; malformed/blank lines
// are skipped silently — aggregation is best-effort telemetry.
function forEachRecord(lines: string[], onRecord: (record: JsonRecord) => void): void {
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
    if (record) onRecord(record);
  }
}

export function aggregateUsage(lines: string[]): CardUsageStats {
  const tools: Record<string, number> = {};
  const mcpTools: Record<string, number> = {};
  const mcpServers = new Set<string>();
  const commands: string[] = [];
  const skillsUsed = new Set<string>();
  const subagents = new Set<string>();

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

    // Subagent spawn: system/task_started carries the agent type.
    if (type === 'system' && asString(record.subtype) === 'task_started') {
      const agentType = asString(record.subagent_type);
      if (agentType) subagents.add(agentType);
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

      // Skill invocation: record the invoked skill, not the Skill tool itself.
      if (name === 'Skill') {
        const skill = asString(asRecord(partRecord.input)?.skill);
        if (skill) skillsUsed.add(skill);
        else tools[name] = (tools[name] ?? 0) + 1; // malformed → count as a tool
        continue;
      }

      // MCP tool: mcp__server__tool → server + per-tool count.
      const mcp = parseMcpName(name);
      if (mcp) {
        mcpServers.add(mcp.server);
        const key = `${mcp.server}__${mcp.tool}`;
        mcpTools[key] = (mcpTools[key] ?? 0) + 1;
        continue;
      }

      if (name === 'Bash') {
        const command = asString(asRecord(partRecord.input)?.command);
        if (command) commands.push(command);
      }

      tools[name] = (tools[name] ?? 0) + 1;
    }
  }

  return finalize({ tools, mcpTools, mcpServers, commands, skillsUsed, subagents });
}

// Codex variant: same CardUsageStats shape, parsed from the Codex stream.
// We count each tool invocation once by reading only `item.completed` events
// (every item also emits `item.started`, which we ignore to avoid double
// counting). command_execution → 'Shell', file_change → 'Edit', and
// mcp_tool_call → mcpServers/mcpTools. Codex emits no Skill/subagent items.
export function aggregateCodexUsage(lines: string[]): CardUsageStats {
  const acc = newAccumulator();

  forEachRecord(lines, (record) => {
    if (asString(record.type) !== 'item.completed') return;
    const item = asRecord(record.item);
    if (!item) return;

    const itemType = asString(item.type);
    if (itemType === 'command_execution') {
      acc.tools.Shell = (acc.tools.Shell ?? 0) + 1;
      const command = asString(item.command);
      if (command) acc.commands.push(command);
      return;
    }
    if (itemType === 'file_change') {
      acc.tools.Edit = (acc.tools.Edit ?? 0) + 1;
      return;
    }
    if (itemType === 'mcp_tool_call') {
      const server = asString(item.server);
      const tool = asString(item.tool);
      if (!server) return;
      acc.mcpServers.add(server);
      if (tool) {
        const key = `${server}__${tool}`;
        acc.mcpTools[key] = (acc.mcpTools[key] ?? 0) + 1;
      }
    }
  });

  return finalize(acc);
}
