<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# src/daemon/ — Standalone Runtime Entrypoint

## Purpose

Bootstraps the agent-kanban backend as a standalone Bun process, independent of the `@opencode-ai/plugin` host. `index.ts` wires up every core store, the scheduler engine, the peer-session coordinator, the Telegram poller/reminder services, the wiki worker, and the HTTP monitor, then owns process lifecycle (singleton-runtime lock acquisition, graceful shutdown, keep-alive timers). This is the entrypoint used when agent-kanban runs outside of an opencode plugin host (e.g. `bun run dev:plugin`-adjacent standalone mode).

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | Single-file daemon bootstrap: constructs all core stores (`KanbanStore`, `SchedulerStore`, `SettingsStore`, `ScriptStore`, `SkillStore`, `SkillRootsStore`, `PlacementTargetsStore`, `TelegramStateStore`), the standalone runtime host, `PeerSessionCoordinator`, `RuntimeLock` (singleton ownership), `WikiWorker`, `ServerMonitor`, `TelegramPoller`/`TelegramReminderService`, skill discovery/sync, and `SIGINT`/`SIGTERM` shutdown handling |

## For AI Agents

### Working In This Directory

- `index.ts` runs top-level `await` at module scope — it is a script, not an exported module. There is no class/function to unit test directly; behavior is verified through the modules it wires together (`plugin/runtimes/runtime-host.ts`, `plugin/server.ts`, `plugin/scheduler-engine.ts`, `plugin/peer-session-coordinator.ts`, `plugin/telegram-poller.ts`, `plugin/telegram-reminder.ts`, `plugin/wiki/wiki-worker.ts`).
- Only the `RuntimeLock` owner (`runtimeLock.acquire()` returning `true`) starts the "singleton" services — `schedulerEngine`, `telegramPoller`, `telegramReminder`, `wikiWorker`. Non-owner instances still start the HTTP monitor and stay ready to take over via `runtimeLock.onChange()`.
- `startSingleton()` / `stopSingleton()` are idempotent (guarded by `singletonStarted`) — always route ownership transitions through them rather than starting/stopping individual services inline.
- Skill discovery (`skillRootsStore.getRoots()` → `skillStore.sync()` → `setDynamicSkillCommands()`) is best-effort and wrapped in try/catch: a scan failure must never block daemon startup.
- `sweepWikiInternalCards(store)` runs before any other store use to hide legacy wiki-internal cards minted before the chat-message guard existed.
- Two `setInterval` calls at the bottom exist purely to keep the Bun process alive (all real work is timer-driven inside the services above) — do not remove them even though their callbacks are empty.

### Testing Requirements

- There is no `daemon/index.ts`-specific test file. `src/__tests__/daemon-runtime-host.test.ts` covers `createStandaloneRuntimeHost` (the runtime host this file constructs and depends on) — run it after touching runtime-host wiring:
  ```bash
  bun test src/__tests__/daemon-runtime-host.test.ts
  ```
- Changes here almost always touch fragile workflow surfaces (scheduler ownership, Telegram poller/reminder start/stop, wiki worker lifecycle). Per root `CLAUDE.md`, read `docs/invariants.md` and run the fragile-file test suite before and after:
  ```bash
  bun test src/__tests__/plugin-hooks.test.ts src/__tests__/telegram-poller.test.ts src/__tests__/feedback-session-reuse.test.ts src/__tests__/workflow-regression.test.ts
  ```

### Common Patterns

- Construct a store/service, pass it into the next constructor that needs it (e.g. `settingsStore` flows into `SchedulerEngine`, `TelegramPoller`, `ServerMonitor`) — dependency wiring is explicit constructor injection, no DI container.
- Runtime ownership changes flow through a single callback: `runtimeLock.onChange(async (owner) => { ... })`.
- Debug/lifecycle events are recorded via `appendRuntimeDebugLog(event, payload)` (`daemon.runtime.start`, `daemon.runtime.stop`, `daemon.init`) rather than `console.log`.

## Dependencies

### Internal

- `../core/store`, `../core/scheduler-store`, `../core/settings-store`, `../core/script-store`, `../core/skill-store`, `../core/skill-roots-store`, `../core/placement-targets-store`, `../core/commands`, `../core/telegram-state-store`
- `../plugin/scheduler-engine`, `../plugin/server`, `../plugin/runtime-lock`, `../plugin/peer-session-coordinator`, `../plugin/telegram-poller`, `../plugin/telegram-reminder`, `../plugin/wiki/wiki-worker`, `../plugin/wiki/wiki-sweep`, `../plugin/config`, `../plugin/debug-log`, `../plugin/runtimes/runtime-host`

### External

- `bun` runtime (`Bun.serve` indirectly via `ServerMonitor`, process signal handling via Node-compatible `process.on`)

<!-- MANUAL: -->
