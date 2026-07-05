<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-06 -->

# src/daemon/ — Standalone Runtime Entrypoint

## Purpose

Bootstraps the agent-kanban backend as a standalone Bun process, independent of the `@opencode-ai/plugin` host. This is the **primary entrypoint** (`bun start`, `package.json` `main`/`exports["."]`) for codex/claude-driven installs. `index.ts` is a thin wrapper over `createKanbanApp()` in `src/plugin/bootstrap.ts`: it supplies the standalone dispatch engine (`createStandaloneRuntimeHost()`) and owns process lifecycle (graceful shutdown, keep-alive timers); all store/server/Telegram/wiki/scheduler wiring lives in the shared bootstrap.

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Thin daemon entrypoint: calls `createKanbanApp()` with `opencodeInput: null` and a `createDispatch` factory that builds `createStandaloneRuntimeHost()` (claude/codex adapters, opencode marked unavailable). Registers the runtime host's watchdog as an owner-gated singleton service, wires `SIGINT`/`SIGTERM` shutdown, and holds keep-alive timers |

## For AI Agents

### Working In This Directory

- `index.ts` runs top-level `await` at module scope — it is a script, not an exported module. Shared boot behavior is tested through `src/plugin/bootstrap.ts`'s collaborators; the standalone dispatch engine through `plugin/runtimes/runtime-host.ts`.
- Only the `RuntimeLock` owner starts the "singleton" services (scheduler engine, watchdog, wiki worker, Telegram poller/reminder). That lifecycle — including `startSingleton()`/`stopSingleton()` idempotency and `runtimeLock.onChange()` takeover — lives in `createKanbanApp()`, not here. Route ownership behavior changes through the bootstrap.
- The daemon deliberately keeps its own dispatch implementation (`runtime-host.ts`) separate from the opencode plugin's inline `dispatchCard` — see `docs/invariants.md`. Do not merge them.
- Two `setInterval` calls at the bottom exist purely to keep the Bun process alive (all real work is timer-driven inside the services above) — do not remove them even though their callbacks are empty.

### Testing Requirements

- There is no `daemon/index.ts`-specific test file. `src/__tests__/daemon-runtime-host.test.ts` covers `createStandaloneRuntimeHost` (the dispatch engine this file supplies) — run it after touching runtime-host wiring:
  ```bash
  bun test src/__tests__/daemon-runtime-host.test.ts
  ```
- Changes here almost always touch fragile workflow surfaces (scheduler ownership, Telegram poller/reminder start/stop, wiki worker lifecycle). Per root `CLAUDE.md`, read `docs/invariants.md` and run the fragile-file test suite before and after:
  ```bash
  bun test src/__tests__/plugin-hooks.test.ts src/__tests__/telegram-poller.test.ts src/__tests__/feedback-session-reuse.test.ts src/__tests__/workflow-regression.test.ts
  ```

### Common Patterns

- Entrypoint-specific behavior is injected into `createKanbanApp()` via factories/options (`createDispatch`, `debugLabel`); the daemon passes only what differs from the opencode plugin.
- Debug/lifecycle events are recorded via `appendRuntimeDebugLog(event, payload)` (`daemon.runtime.start`, `daemon.runtime.stop`, `daemon.runtime.owner.*`, `daemon.init`) rather than `console.log`.

## Dependencies

### Internal

- `../plugin/bootstrap` (shared boot wiring), `../plugin/config`, `../plugin/debug-log`, `../plugin/runtimes/runtime-host`

### External

- `bun` runtime (`Bun.serve` indirectly via `ServerMonitor`, process signal handling via Node-compatible `process.on`)

<!-- MANUAL: -->
