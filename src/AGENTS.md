<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# src

## Purpose
Backend TypeScript source for the agent-kanban plugin + server. This directory is a container that organizes the backend into shared primitives (`core/`), the opencode plugin runtime (`plugin/`), the HTTP/REST layer (`server/`), the standalone daemon bootstrap (`daemon/`), and the test suite (`__tests__/`). There are no top-level files here — all code lives in the subdirectories below.

## Subdirectories
| Directory | Purpose |
|-----------|---------|
| `core/` | Shared types (`types.ts` — single source of truth for DTOs), JSON stores with atomic writes + dual locking, agent config, data-dir resolution, Scope Manager stores (see `core/AGENTS.md`) |
| `plugin/` | Backend runtime: shared boot wiring (`bootstrap.ts`), opencode plugin entrypoint, tools, hooks, dispatch, Telegram, schedulers, runtime adapters, wiki pipeline (see `plugin/AGENTS.md`) |
| `server/` | `Bun.serve()` HTTP server + REST routes (`routes.ts`) + static SPA serving (see `server/AGENTS.md`) |
| `daemon/` | Standalone daemon entrypoint (primary): thin wrapper over `plugin/bootstrap.ts` + standalone runtime host (see `daemon/AGENTS.md`) |
| `__tests__/` | `bun test` unit + integration suites, including high-risk regression tests (see `__tests__/AGENTS.md`) |

## For AI Agents

### Working In This Directory
- **Never fork DTOs.** `core/types.ts` is the single source of truth; both the server and the web SPA import from there.
- Changes to dispatch, hooks, Telegram, or feedback flows are **high-risk** — read `docs/invariants.md` and run the targeted regression suites before modifying `plugin/`.
- Bun-first: `bun install`, `bun test`, `bun run`. No `as any`, `@ts-ignore`, or `console.log` in app code.

### Testing Requirements
- `bunx tsc --noEmit` for type checking.
- `bun test` for the full suite; scope to a single file (e.g. `bun test src/__tests__/plugin-hooks.test.ts`) while iterating.

### Common Patterns
- Each persistence domain has its own JSON store in `core/` with temp-file atomic writes and dual locking.
- Tools use `tool.schema` for validation and always return `string`.

## Dependencies

### Internal
- Consumed by `web/src/` (types) and the plugin host runtime.

### External
- `@opencode-ai/plugin` — plugin runtime contract
- Bun runtime (`Bun.serve`, `bun:test`, `bun:sqlite` where used)

<!-- MANUAL: -->
