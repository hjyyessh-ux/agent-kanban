<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-07-01 -->

# src/plugin/ — Plugin Runtime Orchestration

## OVERVIEW

Plugin entrypoint for `@opencode-ai/plugin`. Boots stores, tool factories, event hooks, dispatch flow, server monitor, scheduler engine, stale-card checker, question monitor, Telegram poller, and reminder service.

## STRUCTURE

```text
plugin/
├── index.ts              # Runtime bootstrap + dispatch flow + beforeExit cleanup
├── server.ts             # ServerMonitor: staticDir resolution + recovery
├── scheduler-engine.ts   # Croner-backed scheduler runtime
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
| Change plugin startup / shutdown | `index.ts` | Stores, monitors, `beforeExit` cleanup |
| Change dispatch prompt/model/agent resolution | `index.ts` | `buildDispatchPromptBody()` + `dispatchCard()` |
| Change static file discovery or recovery | `server.ts` | Resolves `web/dist`, restarts on failure |
| Change cron runtime behavior | `scheduler-engine.ts` | Shell execution + next-run updates |
| Change stale-card detection | `stale-checker.ts` | Orphan/stuck heuristics |
| Change question ingestion or auto-answering | `question-monitor.ts` | `/event` SSE + `/question` polling |
| Change Telegram command routing | `telegram-commands.ts` | Explicit commands and aliases |
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
- `index.ts` is the orchestration shell: stores → tools → hooks → monitors.
- `dispatchCard()` validates `projectDir`, updates the card to `in_progress`, registers dispatch tracking, then calls `promptAsync()`.
- `stale-checker.ts` must stay aligned with parent/child idle guards: top-level parents waiting on direct child work are not stale/orphan candidates.
- `buildDispatchPromptBody()` converts `provider/model` strings and resolves shared agent labels from `src/core/agent-config.ts`.
- Plugin startup ensures the runtime `KANBAN_DATA_DIR/scripts/` directory exists and keeps ScriptStore as the source of persisted script state.
- Plugin startup also runs `SkillStore.sync()` (best-effort) to scan `~/.claude/skills` and `~/.codex/skills`, then `setDynamicSkillCommands()` so user-authored skills register as runtime commands. `POST /api/skills/sync` re-runs this at runtime; a scan failure must never block startup.
- TUI navigation and toast calls are best-effort and wrapped in try/catch.
- Every long-lived runtime started here must also be stopped in `beforeExit`.
- `WikiWorker` runs only on the singleton runtime owner (started/stopped with the scheduler, stale checker, and Telegram poller). It never auto-retries failed groups — they stay `failed` until a backfill/reprocess re-queues them.
- Wiki LLM calls are one-shot CLI runs routed by model (`wiki/wiki-llm.ts`): `gpt-*` → `codex exec` (read-only sandbox), otherwise `claude -p --output-format json`. The runner is injectable for tests.
- `dispatchCard()` reuses the original session for feedback cards only through `feedbackForCardId`.
- Telegram command routing must stay deterministic; explicit commands are parsed before natural message dispatch.
- Telegram agent/model overrides must come from shared core agent config, not duplicated plugin-local constants.
- Telegram ACK and warning messages default to plain text; only explicit parse modes should set `parse_mode`.
- Idle completion must stay gated by observed session activity; do not reintroduce unconditional `session.idle` completion.
- Parent/child waiting semantics must stay aligned with stale detection so top-level parents waiting on direct child work are not flagged as orphaned.
- Telegram selected-session reuse, sticky default agent/model behavior, and idle-completion boundaries must stay aligned with `docs/invariants.md`.

## FRAGILE WORKFLOW FILES

- `index.ts` — feedback session reuse and dispatch ordering
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
