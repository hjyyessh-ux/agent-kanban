<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# docs

## Purpose

Human-facing documentation for agent-kanban, written in Korean. Covers installation, the kanban board domain model, the scheduler, plugin tool contracts, the REST API, system architecture, and the workflow invariants that guard high-risk code paths. These docs are maintained by hand and can drift behind source — prefer reading source + the nearest `AGENTS.md` when counts or behavior are in question, but update these files when the documented behavior actually changes.

## Key Files

| File | Description |
|------|-------------|
| `README.md` | Docs index/table of contents, feature summary, quick start, data storage layout under `~/.agent-kanban/` |
| `getting-started.md` | Prerequisites (Bun, opencode), install steps, first card walkthrough |
| `kanban-board.md` | Board columns, card lifecycle, parent-child cards, Telegram/feedback flows |
| `scheduler.md` | `SchedulerEntry` shape, cron vs natural-language schedules, shell vs skill job types, croner engine lifecycle |
| `plugin-tools.md` | Contract reference for the kanban + scheduler plugin tools registered via `createKanbanTools()`/`createSchedulerTools()` |
| `api-reference.md` | REST endpoint reference for cards, schedulers, settings, scripts, screenshots, models, questions |
| `architecture.md` | Three-layer system diagram (plugin -> server -> web), tech stack, data flow |
| `design-system.md` | **MUST READ before UI work**: kv2 tokens/primitives, DialogSkeleton modal contract, new-screen checklist, forbidden UI patterns |
| `invariants.md` | Canonical checklist of workflow regression invariants (parent-child cards, completion transitions, Telegram follow-up, feedback reuse, runtime dispatch) tied to specific source files and tests |
| `assets/` | Screenshots referenced by the docs (`agent-kanban-board.png`, `capabilities.png`, `llm-wiki.png`) |

## Subdirectories

| Directory | Description |
|-----------|-------------|
| `assets/` | Static images embedded in the markdown docs; no AGENTS.md (image-only) |

## For AI Agents

### Working In This Directory

- Docs are written in Korean; match the existing tone and terminology when editing.
- `invariants.md` is the canonical source for workflow-critical behavior. Any change to the files it lists (`chat-message.ts`, `event-handler.ts`, `telegram-poller.ts`, `telegram-commands.ts`, `telegram-state-store.ts`, `plugin/index.ts`, runtime dispatch types/adapters) must be reflected here in the same change, per the root `CLAUDE.md` workflow invariants section.
- When shared types in `src/core/types.ts` change shape (cards, schedulers, scripts, settings), check whether `api-reference.md` and `plugin-tools.md` need matching updates.
- Do not treat these docs as authoritative over source when they conflict — verify against `src/` before trusting a count or field list here.

### Testing Requirements

- No tests run against this directory; it is documentation only. Verify accuracy by cross-referencing `src/core/types.ts`, `src/server/routes.ts`, and `src/plugin/tools/`.

### Common Patterns

- Each doc opens with an `## 개요` (Overview) section before detail sections.
- Tables are used heavily for field/endpoint/tool reference lists.
- Cross-references use relative markdown links back to `README.md`'s table of contents.

## Dependencies

### Internal
- Describes behavior implemented in `src/core/`, `src/plugin/`, `src/server/`, and `web/src/`.

### External
- None (static markdown + images).

<!-- MANUAL: -->
