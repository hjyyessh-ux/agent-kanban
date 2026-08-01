<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-07-06 -->

# src/plugin/ — Plugin Runtime Orchestration

## OVERVIEW

Backend runtime shared by both entrypoints. `bootstrap.ts` (`createKanbanApp()`) owns the boot wiring common to the standalone daemon (`src/daemon/index.ts`, the primary entrypoint) and the opencode plugin (`index.ts`): stores, settings seeds, skill discovery, server monitor, scheduler engine, Telegram poller/reminder, wiki worker, and the singleton-runtime lock lifecycle. `index.ts` layers the opencode-specific parts on top: tool factories, event hooks, the inline opencode `dispatchCard`, question monitor, and TUI toasts.

## STRUCTURE

```text
plugin/
├── bootstrap.ts          # createKanbanApp(): shared boot wiring for daemon + plugin
├── index.ts              # opencode plugin entrypoint: tools/hooks + inline dispatch + beforeExit cleanup
├── server.ts             # ServerMonitor: staticDir resolution + recovery
├── scheduler-engine.ts   # Croner-backed scheduler runtime (bash + prompt cards)
├── scheduled-dispatch-service.ts # Owner-gated due-card dispatcher for scheduled todo cards
├── stale-checker.ts      # Detect orphaned/stuck cards
├── question-monitor.ts   # SSE + polling bridge for pending questions
├── telegram-*.ts         # Telegram polling, commands, notifier, reminders
├── runtimes/AGENTS.md    # Runtime adapters (claude/codex CLI), run store, git/usage capture
├── wiki/AGENTS.md        # LLM wiki pipeline: config, prompts, llm, writer, worker
├── tools/AGENTS.md       # Tool factory and registry rules
└── hooks/AGENTS.md       # chat.message / event lifecycle rules
```

## Subdirectories

| Directory | Purpose | Guide |
|-----------|---------|-------|
| `hooks/` | `chat.message` / event lifecycle, dedup, subagent parenting, idle completion | `hooks/AGENTS.md` |
| `tools/` | Kanban/scheduler/settings tool factories exposed to `@opencode-ai/plugin` | `tools/AGENTS.md` |
| `runtimes/` | Claude/Codex CLI adapters, runtime registry, run store, git/usage capture | `runtimes/AGENTS.md` |
| `wiki/` | Archived-card triage/classify pipeline that writes Obsidian vault docs | `wiki/AGENTS.md` |

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Change shared startup (stores, seeds, singleton lifecycle) | `bootstrap.ts` | Affects daemon AND plugin — run fragile suites |
| Change opencode plugin startup / shutdown | `index.ts` | Tools, hooks, `beforeExit` cleanup |
| Change dispatch prompt/model/agent resolution | `index.ts` | `buildDispatchPromptBody()` + `dispatchCard()` |
| Change static file discovery or recovery | `server.ts` | Resolves `web/dist`, restarts on failure |
| Change cron runtime behavior | `scheduler-engine.ts` | Bash/prompt execution + next-run updates |
| Change scheduled todo auto-dispatch | `scheduled-dispatch-service.ts`, `bootstrap.ts`, `server/routes.ts` | Owner-gated due scan, stale-claim recovery, manual/auto race handling |
| Change stale-card detection | `stale-checker.ts` | Orphan/stuck heuristics |
| Change question ingestion or auto-answering | `question-monitor.ts` | `/event` SSE + `/question` polling |
| Change Telegram command routing | `telegram-commands.ts` | Explicit commands, aliases, inline keyboards, callback data |
| Change Telegram message sending or splitting | `telegram-notifier.ts` | 4096-cap part splitting, keyboards, `answerCallbackQuery` |
| Change Telegram follow-up/reminder behavior | `telegram-poller.ts`, `telegram-reminder.ts` | Session reuse + reminders |
| Change wiki triage/classification or vault output | `wiki/wiki-prompts.ts`, `wiki/wiki-writer.ts` | Bump `WIKI_PROMPT_VERSION` in `wiki/wiki-config.ts` on prompt changes |
| Change wiki queue/backfill behavior | `wiki/wiki-worker.ts` | Consumes wiki-pending archived cards; singleton-runtime only |

## CONVENTIONS

- **CRITICAL**: Tool args MUST use `tool.schema` from plugin input, NOT `import { z } from 'zod'`. Different zod instances cause runtime type incompatibility.
- Tool `execute(args, ctx)` — `ctx` provides: `sessionID`, `messageID`, `agent`, `directory`, `metadata()`, `ask()`
- Tools MUST return `string` — use `JSON.stringify()` for structured data
- Plugin default export is `async (input: PluginInput) => Promise<Hooks>`
- Hooks are spread into return: `return { tool: tools, ...eventHooks }`
- All `input.client.tui` calls wrapped in try/catch — TUI may not be available
- `process.env.KANBAN_DATA_DIR` and `process.env.KANBAN_PORT` override defaults
- `bootstrap.ts` is the orchestration shell (stores → dispatch factory → server → singleton services); `index.ts` injects opencode-specific factories (`createDispatch`, `createQuestionMonitor`, `createFollowUpFn`, `modelsFn`, `listNativeSessions`) and builds tools/hooks from the returned app.
- `ScheduledDispatchService` is started/stopped with the singleton runtime owner in `bootstrap.ts`; it does an immediate scan on start, reclaims stale `dispatching` reservations, and only dispatches cards that pass the store claim atomically.
- The two `dispatchCard` implementations stay separate on purpose: the plugin's inline one in `index.ts` (opencode session dispatch) and the daemon's `runtimes/runtime-host.ts`. Both are referenced by `docs/invariants.md` — do not merge them.
- `dispatchCard()` validates `projectDir`, updates the card to `in_progress`, registers dispatch tracking, then calls `promptAsync()`.
- Manual `POST /api/cards/:id/dispatch` uses the same scheduled-reservation wrapper as the background dispatcher so a due-card timer and a user click cannot double-dispatch the same card.
- `stale-checker.ts` must stay aligned with parent/child idle guards: top-level parents waiting on direct child work are not stale/orphan candidates.
- `buildDispatchPromptBody()` converts `provider/model` strings and resolves shared agent labels from `src/core/agent-config.ts`.
- `createKanbanApp()` ensures the runtime `KANBAN_DATA_DIR/scripts/` directory exists and keeps ScriptStore as the source of persisted script state.
- `createKanbanApp()` also runs `SkillStore.sync()` (best-effort) to scan `~/.claude/skills` and `~/.codex/skills`, then `setDynamicSkillCommands()` so user-authored skills register as runtime commands. `POST /api/skills/sync` re-runs this at runtime; a scan failure must never block startup.
- TUI navigation and toast calls are best-effort and wrapped in try/catch.
- Every long-lived runtime started here must also be stopped in `beforeExit`. Owner-gated services (watchdogs, stale checker) go through `DispatchEngine.singletonServices` so `startSingleton()`/`stopSingleton()` manage them symmetrically.
- `WikiWorker` runs only on the singleton runtime owner (started/stopped with the scheduler, stale checker, and Telegram poller). It never auto-retries failed groups — they stay `failed` until a backfill/reprocess re-queues them.
- Wiki LLM calls are one-shot CLI runs routed by model (`wiki/wiki-llm.ts`): `gpt-*` → `codex exec` (read-only sandbox), otherwise `claude -p --output-format json`. The runner is injectable for tests.
- `dispatchCard()` reuses the original session for feedback cards only through `feedbackForCardId`.
- Telegram command routing must stay deterministic; explicit commands are parsed before natural message dispatch.
- Telegram agent/model overrides must come from shared core agent config, not duplicated plugin-local constants.
- Telegram ACK and warning messages default to plain text; only explicit parse modes should set `parse_mode`.
- `sendTelegramMessage()` splits text over Telegram's 4096-code-unit cap into numbered parts instead of truncating. Never reintroduce a truncate helper on the completion path — a cut-off result loses exactly what the user asked for.
- Inline keyboards go through `TelegramCommandResult.keyboard`; taps arrive as `update.callback_query` and are resolved by `resolveTelegramCallback()`. Every callback path must call `answerTelegramCallbackQuery()` or the button spins forever.
- `/directory` callback data pins each button to a digest of its path. The recent-directory list is re-derived from cards at tap time, so a stale index must be rejected rather than silently switching to the wrong project.
- Commands marked `hiddenFromMenu` stay routable when typed but are filtered out of `setMyCommands`. `buildTelegramHelpText()` must still mention every command that IS registered — `telegram-poller.test.ts` asserts this.
- Model ids accept shorthand via `resolveModelId()`. An input matching nothing must stay rejected; when several match, only the runtime default may win.
- Idle completion must stay gated by observed session activity; do not reintroduce unconditional `session.idle` completion.
- Parent/child waiting semantics must stay aligned with stale detection so top-level parents waiting on direct child work are not flagged as orphaned.
- Telegram selected-session reuse, sticky default agent/model behavior, and idle-completion boundaries must stay aligned with `docs/invariants.md`.
- Telegram follow-up cards inherit the selected session `projectDir`; `/directory` remains sticky until changed or cleared, and dispatch/follow-up ACKs show the effective path.

## FRAGILE WORKFLOW FILES

- `index.ts` — feedback session reuse and dispatch ordering
- `bootstrap.ts` — shared boot wiring; a change here hits daemon and plugin at once
- `telegram-poller.ts` — selected session reuse, `/new_session`, sticky defaults, follow-up failure behavior
- `telegram-commands.ts` — explicit command semantics and force-new dispatch paths
- `telegram-reminder.ts` — reminder skip/throttle rules for selected sessions
- Changes to these files should re-run `telegram-poller.test.ts`, `feedback-session-reuse.test.ts`, and `workflow-regression.test.ts` before the full suite.

## ANTI-PATTERNS

- Calling `Bun.serve()` directly from plugin files instead of `ServerMonitor`
- Prompting a session before store/dispatch-tracker state is updated
- Forking agent label/model mappings in plugin-local constants
- Starting monitors/pollers without symmetric shutdown logic

## SUB-GUIDES

- `tools/AGENTS.md` — tool factory shape, registry updates, string-return rules
- `hooks/AGENTS.md` — message dedup, sanitization, subagent linking, idle completion
- `runtimes/AGENTS.md` — adapter contract, session/thread id resolution, git/usage capture
- `wiki/AGENTS.md` — triage/classify prompt contract, vault writer, prompt-version bump rule

<!-- MANUAL: -->
