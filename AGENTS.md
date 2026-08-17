# PROJECT KNOWLEDGE BASE

**Generated:** 2026-03-25
**Updated:** 2026-07-01
**Commit:** 6e337d5
**Branch:** feat/scope-manager-phase0

## OVERVIEW

`agent-kanban` combines a Bun backend (usable as an opencode plugin or as a Claude Code hook target) with a React/Vite SPA. It tracks kanban cards, schedulers, synced scripts, settings, screenshots, Telegram follow-ups, and pending questions, persisting runtime state under `~/.agent-kanban/` (overridable via `KANBAN_DATA_DIR`) in JSON stores.

## STRUCTURE

```text
.
├── src/
│   ├── core/        # Shared types, stores, file locking, cron parsing, agent defaults
│   ├── plugin/      # Plugin runtime: tools, hooks, dispatch, Telegram, monitors
│   ├── server/      # Bun.serve() server + REST routes + static SPA serving
│   └── __tests__/   # Bun unit/integration tests
├── web/src/         # React SPA: board, scheduler, scripts, settings, question UI
├── e2e/             # Playwright specs + fixtures + API seed helpers
├── scripts/         # Operational CLI/test/bootstrap scripts kept in-repo only
├── docs/            # Human docs; may drift behind source
├── dist/plugin/     # Plugin build output
└── web/dist/        # SPA build output
```

## Subdirectories

| Directory | Description |
|-----------|-------------|
| [`src/`](./src/AGENTS.md) | Bun backend: shared types/stores (`core/`), opencode plugin runtime (`plugin/`), Bun.serve() HTTP server (`server/`), unit/integration tests (`__tests__/`) |
| [`web/`](./web/src/AGENTS.md) | React/Vite SPA — board, capabilities, scheduler, scripts, settings, wiki UI |
| [`e2e/`](./e2e/AGENTS.md) | Playwright browser specs, fixtures, and API seed helpers |
| [`scripts/`](./scripts/AGENTS.md) | Operational CLI scripts: test server, install/restart, wiki maintenance |
| [`docs/`](./docs/AGENTS.md) | Human-facing docs (Korean): getting started, kanban board, scheduler, plugin tools, API reference, architecture, invariants |

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Change shared card/scheduler/script/settings schema | `src/core/types.ts` | Shared by backend, web, and tests |
| Change board persistence or queueing | `src/core/store.ts` | `active.json`, archive, screenshots, queue helpers |
| Change Quick Action contracts, persistence, or execution | `src/core/types.ts`, `src/core/quick-action-store.ts`, `src/plugin/script-execution-service.ts`, `src/server/routes.ts` | Prompt runs reuse dispatch; Script runs use the tracked async execution service |
| Change script execution env/security/lifecycle | `src/core/execution-environment.ts`, `src/core/script-store.ts`, `src/plugin/script-execution-service.ts` | Fixed interpreter argv, 8KB output cap, redaction, concurrency/orphan handling |
| Change scheduler runtime behavior | `src/plugin/scheduler-engine.ts` | Croner jobs + shell execution |
| Change plugin startup / dispatch flow | `src/plugin/index.ts` | Stores, tools, monitors, Telegram, script sync |
| Change plugin tool contracts | `src/plugin/tools/AGENTS.md` | Factory/registration rules live there |
| Change hook lifecycle / subagent behavior | `src/plugin/hooks/AGENTS.md` | Dedup, sanitization, idle completion |
| Change REST routes / API shape | `src/server/routes.ts` | Cards, schedulers, settings, scripts, screenshots, models, questions |
| Change server bootstrap / static SPA serving | `src/server/index.ts`, `src/plugin/server.ts` | Port retry + static dir resolution |
| Change UI state / fetch logic | `web/src/hooks/AGENTS.md` | API wrappers, polling, reducers, modal accessibility |
| Change board/Quick Actions/scheduler/scripts/settings/question UI | `web/src/App.tsx`, `web/src/components/` | App shell owns tabs + modal orchestration; Quick Actions reuse `DialogSkeleton` |
| Change unit/integration expectations | `src/__tests__/AGENTS.md` | Invariant-heavy coverage map |
| Change browser flows | `e2e/AGENTS.md` | Playwright fixtures + test server flow |
| Change operational scripts | `scripts/AGENTS.md` | Test server, install/restart, wiki backfill/reindex |
| Change LLM wiki pipeline (triage/classify/vault) | `src/plugin/wiki/` | Archive stamps `wiki.pending`; worker writes Obsidian vault docs; `/api/wiki/*` + Settings panel |
| Change human-facing docs | `docs/AGENTS.md` | Getting started, kanban board, scheduler, plugin tools, API reference, architecture, invariants |

## GLOBAL CONVENTIONS

- **Bun-first repo**: use `bun install`, `bun test`, `bun run build`, `bun run dev:plugin`.
- **Plugin output**: `dist/plugin/index.js` is the plugin bundle copied into the global opencode plugin directory by `scripts/install.sh`; web build lands in `web/dist`.
- **Shared contracts**: web code imports shared types from `src/core/types.ts`; do not fork DTOs.
- **Tool schema rule**: plugin tools use `tool.schema` and must return `string`.
- **Server rule**: `Bun.serve()` only; every API response keeps CORS headers and `{ error: string }` failures.
- **UI data flow**: raw `fetch()` lives in hooks, not components; polling is the default sync model.
- **Styling**: plain CSS only; kv2 tokens (`--kv2-*`) and primitives (`kv2-btn`, `kv2-input`, …) drive component styling.
- **Persistence**: store classes own JSON reads/writes, temp-file rename, and dual locking.
- **Doc hierarchy**: nearest `AGENTS.md` overrides parent guidance; child docs should contain local delta, not parent copy.
- **Workflow contract**: card lifecycle, Telegram routing, feedback reuse, and sanitization boundaries are anchored in `docs/invariants.md` and must stay in sync with tests.
- **UI contract (MUST READ before any UI work)**: `docs/design-system.md` — kv2 tokens/primitives, DialogSkeleton modal contract, new-screen checklist, forbidden patterns. New screens must reuse the Board/Card Detail look; no new `.neo-*`, no bespoke modals.

## CRITICAL INVARIANTS

- Known subagents become child cards when a parent candidate is found, and then use `AgentName#N` titles; primary agents stay top-level.
- `messageId` dedup and `sanitizeUserText()` prevent duplicate/system-prompt cards.
- `session.idle` completes matching `in_progress` cards in the same session (newest = final completion, older = superseded) and only after observed session activity.
- `session.idle` must not complete a top-level parent card while any direct child/subagent card is still `in_progress`.
- Duplicate `session.idle` events are idempotent once activity state is cleared.
- Feedback cards keep their wrapper text on idle completion; non-feedback cards may sanitize on idle.
- Dispatch updates the card and dispatch tracker before `promptAsync()` to avoid duplicate creation races.
- Telegram follow-ups reuse the selected session, while `/new_session` clears only the selected session and keeps sticky default agent/model.
- Telegram follow-up cards inherit the selected session `projectDir`; `/directory` remains sticky until changed or cleared, and new-session/follow-up ACKs show the effective path.
- Feedback dispatch reuses the original session strictly via `feedbackForCardId`, not by description text shape.
- Tool factories must keep string return values; route handlers must keep CORS.
- Cards, schedulers, settings, scripts, and Telegram chat state persist in separate JSON stores.
- Any change to `chat-message.ts`, `event-handler.ts`, `telegram-poller.ts`, `telegram-commands.ts`, `telegram-state-store.ts`, or `plugin/index.ts` must update docs/tests together.

## ANTI-PATTERNS

- `as any`, `@ts-ignore`, `@ts-expect-error`
- `console.log` in app/plugin/server source (CLI scripts are the exception)
- Importing `zod` directly inside plugin tool files
- Express/Hono/Koa, database backends, WebSocket/SSE-first sync flows
- React Router, React Query/SWR, Tailwind, CSS-in-JS, hardcoded mock card data
- Duplicating shared agent labels/models outside `src/core/agent-config.ts`

## COMMANDS

```bash
bun install
bun run dev           # Vite on 5173, API proxied to 24680
bun run dev:plugin    # Run src/plugin/index.ts directly
bun run build         # Build plugin + web UI
bunx tsc --noEmit
bun test
bun run test:e2e      # Alias for npx playwright test
```

## TESTING

- `bunfig.toml` preloads `src/__tests__/setup.ts`.
- `src/__tests__/` holds 60 Bun unit/integration test files.
- `e2e/` holds 24 Playwright specs; `playwright.config.ts` still lists `photo-compare.e2e.ts` in `testIgnore`, but that file no longer exists in the tree.
- Playwright runs sequentially with `workers: 1` and starts `bun scripts/test-server.ts`.
- E2E server uses `.e2e-data/` and `http://localhost:24681`.
- For fragile workflow files, run targeted regressions before the full suite: `plugin-hooks.test.ts`, `telegram-poller.test.ts`, `feedback-session-reuse.test.ts`, `telegram-state-store.test.ts`, `workflow-regression.test.ts`.

## AGENTS HIERARCHY

```text
AGENTS.md
├── src/core/AGENTS.md
├── src/plugin/AGENTS.md
│   ├── src/plugin/tools/AGENTS.md
│   └── src/plugin/hooks/AGENTS.md
├── src/server/AGENTS.md
├── src/__tests__/AGENTS.md
├── web/src/AGENTS.md
│   └── web/src/hooks/AGENTS.md
├── e2e/AGENTS.md
├── scripts/AGENTS.md
└── docs/AGENTS.md
```

## NOTES

- Prefer source files + nearest `AGENTS.md` over `README.md` or older docs when counts drift.
- `docs/invariants.md` is the canonical checklist for side-effect-prone workflow changes.
- `src/**/*.js` and `web/src/**/*.js` are compiled leftovers; edit the `.ts` / `.tsx` sources.
- Root `index.ts` is leftover `bun init` residue.
- User-managed script sync sources live under `KANBAN_DATA_DIR/scripts/`; the repo `scripts/` directory is not used as runtime user storage.
- `src/plugin/server.ts` resolves static assets from `web/dist`; missing build output means API-only mode.
