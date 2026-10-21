<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-10-19 -->

# constants/

## Purpose
Static lookup tables that map backend identifiers (agent types, runtime commands, card statuses) to UI display metadata — labels, colors, emoji, descriptions — plus the UI copy shared across screens. These are presentation-layer constants derived from `src/core/` definitions, not sources of truth themselves.

## Key Files
| File | Description |
|------|-------------|
| `agents.ts` | Builds `AGENT_CONFIGS` from `src/core/agent-config.ts`'s `PRIMARY_AGENT_CONFIGS`, merging in per-agent visuals (emoji/color/textColor). `AGENT_DISPLAY_OVERRIDES` covers secondary/subagent types (explore, librarian, oracle, plan, metis, momus, etc.) not in the primary config. `getAgentConfig(agentType)` normalizes via `normalizeAgentType()` and resolves either table, returning `null` for unknown types. |
| `copy.ts` | UI copy in one place: `STATUS_LABELS` (board columns, Timeline legend, Work completion preview), `WORK_STATUS_LABELS`, `TAB_COPY`, `TOOLBAR_COPY`, `CARD_ACTION_COPY`, `COLUMN_MENU_COPY`, `CARD_DETAIL_COPY`, `SETTINGS_COPY`, `SCHEDULER_COPY`. Rules live in `docs/design-system.md` › "UI 문구". |
| `card-actions.ts` | `primaryActionFor(status, { scheduled, surface })` / `secondaryActionFor(status)` — the single status → main-action mapping (`kind`, `label`, `target`) used by BoardCard `CardActions`, `BoardListRowAction` and Card detail's footer. `finish` (in_progress → complete) and `done` (complete → done) are separate kinds with separate labels. |
| `commands.ts` | Wraps `src/core/commands.ts` for the UI: `getAllCommands()`/`getCommandsForRuntime()` list available slash commands per `AgentRuntime`, `getFilteredCommandsForRuntime()` applies the user's enabled-commands preference from `localStorage` (`kanban-enabled-commands`), and `getCommandHint()`/`formatCommandName()` do safe lookups that never throw on unknown/dynamic skill ids. |

## For AI Agents
### Working In This Directory
- Never hardcode an agent's label, model, or color inline in a component — add it to `AGENT_DISPLAY_OVERRIDES` in `agents.ts` (or to `PRIMARY_AGENT_CONFIGS` in `src/core/agent-config.ts` if it's a primary runtime agent) and consume it via `getAgentConfig()`.
- `commands.ts` treats command ids as an open string set (`CommandId = string`), not a closed union — skills discovered on disk register dynamic ids at runtime. Do not reintroduce a static enum/union for command ids.
- `parseStoredEnabledCommandIds()` auto-enables dynamically discovered skill commands for users whose stored preference predates them; if you add new dynamic command sources, preserve this backward-compat behavior.

- UI copy: Korean, with proper nouns / runtimes / section names (`Board`, `Works`, `Claude`, `Codex`, `Skill`) and `unread` left in English. Write literals in sentence case — where a label shows in capitals, CSS `text-transform: uppercase` does it; never keep an uppercase literal under an uppercasing class.
- Do not branch on `card.status` to pick an action label in a component — call `primaryActionFor` / `secondaryActionFor` and render `label`, dispatching on `target` (`'dispatch'` vs a `KanbanStatus`).
- `TIMELINE_STATUS_LABELS` (`Works/timelineRows.ts`) and `WORK_STATUS_LABELS` (`Works/worksAssign.ts`) are re-exports of `copy.ts` kept for existing imports; change the words in `copy.ts`.

### Testing Requirements
- `card-actions.ts` is covered through its consumers: `Board/BoardListRowAction.test.ts`, `Board/BoardCard.test.tsx` (`CardActions mapping`), `Card/CardDetailDialog.test.tsx`. Unit and e2e specs import the `copy.ts` constants rather than duplicating the strings.
- No dedicated test file for the other files. Changes to `getFilteredCommandsForRuntime()`'s `localStorage` migration logic or `getAgentConfig()`'s override resolution should be covered by tests in the consuming component/hook (e.g. `CommandPicker`, `useKanbanBoard.test.ts`) if touched.

### Common Patterns
- Both files re-export/derive from `src/core/` — always resolve display data through the exported helper function (`getAgentConfig`, `getCommandHint`, etc.) rather than reaching into the raw tables directly, so unknown/dynamic values degrade gracefully instead of crashing.
- `localStorage` access in `commands.ts` is wrapped in `try/catch` and falls back to the unfiltered list — follow this pattern for any new persisted UI preference.

## Dependencies
### Internal
- `src/core/agent-type.ts` (`normalizeAgentType`)
- `src/core/agent-config.ts` (`PRIMARY_AGENT_CONFIGS`)
- `src/core/commands.ts` (`getAllCommandEntries`, `getCommandDefinitionById`, `getDynamicSkillCommandIds`)
- `src/core/types.ts` (`AgentRuntime`, `KanbanStatus`, `Work`)

### External
- Browser `localStorage` (in `commands.ts` only).

<!-- MANUAL: -->
