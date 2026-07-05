<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-07-01 -->

# src/plugin/tools/ — Plugin Tool Factories

## OVERVIEW

Factory functions that expose plugin tools. Registry lives in `index.ts`; individual files define tool descriptions, arg schemas, and string-returning execute handlers for kanban, scheduler, settings, and screenshot operations.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Register or rename tools | `index.ts` | Update factory exports and returned tool map |
| Change kanban card tool behavior | `kanban_*.ts` | Create/list/get/update/delete/archive/screenshot |
| Change scheduler tool behavior | `scheduler_*.ts` | Create/list/update/delete/toggle/run |
| Change settings tool behavior | `settings_*.ts` | Read/list settings entries |

## CONVENTIONS

- Import `tool` from `@opencode-ai/plugin` and bind `const z = tool.schema`.
- Tool files export `create<Name>Tool(...)` factory functions.
- `execute()` must return `string`; JSON payloads are `JSON.stringify(...)`, human-readable summaries are plain strings.
- Registry functions group tools by domain: `createKanbanTools`, `createSchedulerTools`, `createSettingsTools`.
- Tool descriptions are user-facing contract text; keep them aligned with server/store behavior.
- `kanban_create` contains session dedup behavior for already-dispatched sessions.
- Scheduler creation/update tools accept natural-language cron input via `parseNaturalLanguageToCron()`.

## ANTI-PATTERNS

- Importing `zod` directly
- Returning raw objects from `execute()`
- Registering a new tool in its file but not in `index.ts`
- Re-implementing store validation rules in UI-facing text without matching server/store behavior

## NOTES

- Tool coverage currently spans 7 kanban tools (create, list, get, update, delete, archive, screenshot), 6 scheduler tools (create, list, update, delete, toggle, run), and 2 settings tools (list, get).
- Skill-backed scheduler actions deliberately warn about token cost; runtime execution still fails intentionally in `SchedulerEngine`.
- `kanban_create` dedups against already-dispatched sessions; its logic sits directly upstream of the dispatch/hook flow documented in `../hooks/AGENTS.md` — coordinate changes if you touch both.

<!-- MANUAL: -->
