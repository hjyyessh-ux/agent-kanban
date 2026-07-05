<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# constants/

## Purpose
Static lookup tables that map backend identifiers (agent types, runtime commands) to UI display metadata — labels, colors, emoji, descriptions. These are presentation-layer constants derived from `src/core/` definitions, not sources of truth themselves.

## Key Files
| File | Description |
|------|-------------|
| `agents.ts` | Builds `AGENT_CONFIGS` from `src/core/agent-config.ts`'s `PRIMARY_AGENT_CONFIGS`, merging in per-agent visuals (emoji/color/textColor). `AGENT_DISPLAY_OVERRIDES` covers secondary/subagent types (explore, librarian, oracle, plan, metis, momus, etc.) not in the primary config. `getAgentConfig(agentType)` normalizes via `normalizeAgentType()` and resolves either table, returning `null` for unknown types. |
| `commands.ts` | Wraps `src/core/commands.ts` for the UI: `getAllCommands()`/`getCommandsForRuntime()` list available slash commands per `AgentRuntime`, `getFilteredCommandsForRuntime()` applies the user's enabled-commands preference from `localStorage` (`kanban-enabled-commands`), and `getCommandHint()`/`formatCommandName()` do safe lookups that never throw on unknown/dynamic skill ids. |

## For AI Agents
### Working In This Directory
- Never hardcode an agent's label, model, or color inline in a component — add it to `AGENT_DISPLAY_OVERRIDES` in `agents.ts` (or to `PRIMARY_AGENT_CONFIGS` in `src/core/agent-config.ts` if it's a primary runtime agent) and consume it via `getAgentConfig()`.
- `commands.ts` treats command ids as an open string set (`CommandId = string`), not a closed union — skills discovered on disk register dynamic ids at runtime. Do not reintroduce a static enum/union for command ids.
- `parseStoredEnabledCommandIds()` auto-enables dynamically discovered skill commands for users whose stored preference predates them; if you add new dynamic command sources, preserve this backward-compat behavior.

### Testing Requirements
- No dedicated test file for this directory currently. Changes to `getFilteredCommandsForRuntime()`'s `localStorage` migration logic or `getAgentConfig()`'s override resolution should be covered by tests in the consuming component/hook (e.g. `CommandPicker`, `useKanbanBoard.test.ts`) if touched.

### Common Patterns
- Both files re-export/derive from `src/core/` — always resolve display data through the exported helper function (`getAgentConfig`, `getCommandHint`, etc.) rather than reaching into the raw tables directly, so unknown/dynamic values degrade gracefully instead of crashing.
- `localStorage` access in `commands.ts` is wrapped in `try/catch` and falls back to the unfiltered list — follow this pattern for any new persisted UI preference.

## Dependencies
### Internal
- `src/core/agent-type.ts` (`normalizeAgentType`)
- `src/core/agent-config.ts` (`PRIMARY_AGENT_CONFIGS`)
- `src/core/commands.ts` (`getAllCommandEntries`, `getCommandDefinitionById`, `getDynamicSkillCommandIds`)
- `src/core/types.ts` (`AgentRuntime`)

### External
- Browser `localStorage` (in `commands.ts` only).

<!-- MANUAL: -->
