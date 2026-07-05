# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Quick Reference

```bash
bun install                # Install dependencies
bun run dev                # Vite dev server (port 5173, proxies /api → :24680)
bun start                  # Run standalone daemon (primary entrypoint)
bun run dev:plugin         # Run opencode plugin directly
bun run build              # Build backend (daemon + plugin) + web
bun run build:backend      # Daemon + plugin only
bun run build:web          # Web SPA only
bunx tsc --noEmit          # Type check
bun test                   # All unit/integration tests
bun test src/__tests__/plugin-hooks.test.ts  # Single test file
bun run test:e2e           # Playwright e2e (sequential, port 24681)
```

## Architecture

Bun plugin backend + React/Vite SPA. JSON file persistence under `~/.agent-kanban/`, resolved by `resolveKanbanDataDir()` in `src/core/data-dir.ts` (overridable via `KANBAN_DATA_DIR`).

- **`src/core/`** — Shared types (`types.ts`), stores, file locking, agent config
- **`src/plugin/`** — @opencode-ai/plugin runtime: tools, hooks, dispatch, Telegram, schedulers
- **`src/server/`** — `Bun.serve()` HTTP + REST routes (`routes.ts`) + static SPA serving
- **`web/src/`** — React SPA: `App.tsx` owns tabs/modals; hooks do fetching/polling; plain CSS
- **`e2e/`** — Playwright specs with API seed helpers, `.e2e-data/` isolation
- **`scripts/`** — Operational CLI scripts (synced into ScriptStore on plugin boot)

## Key Rules

- **Bun-first**: `bun install`, `bun test`, `bun run`. Bun loads `.env` automatically.
- **No**: `as any`, `@ts-ignore`, `console.log` in app code, Express/Hono, React Router, Tailwind, CSS-in-JS, React Query/SWR.
- **Shared types**: `src/core/types.ts` is the single source. Web imports types from there — never fork DTOs.
- **Agent config**: `src/core/agent-config.ts` — never hardcode agent labels/models elsewhere.
- **Tools**: use `tool.schema` for validation, always return `string`.
- **Server**: `Bun.serve()` only. All responses include CORS headers. Errors return `{ error: string }`.
- **UI hooks**: `fetch()` lives in hooks, not components. Polling is the sync model (board 3s, others 10s).
- **Styling**: plain CSS with `.neo-*` token classes. No CSS-in-JS or utility frameworks.
- **Persistence**: each domain has its own JSON store with temp-file atomic writes and dual locking.

## Workflow Invariants

Changes to dispatch, hooks, Telegram, or feedback flows are high-risk. Before modifying these files, read `docs/invariants.md` and run targeted tests first:

```bash
bun test src/__tests__/plugin-hooks.test.ts src/__tests__/telegram-poller.test.ts src/__tests__/feedback-session-reuse.test.ts src/__tests__/workflow-regression.test.ts
```

Fragile files that require synchronized code + test + AGENTS.md updates:
`chat-message.ts`, `event-handler.ts`, `telegram-poller.ts`, `telegram-commands.ts`, `telegram-state-store.ts`, `plugin/index.ts`

## Documentation Hierarchy

Each directory has an `AGENTS.md` with local-scope guidance. The nearest one overrides parent. Prefer source + nearest AGENTS.md over README or older docs. See `AGENTS.md` (root) for the full hierarchy and detailed conventions.
