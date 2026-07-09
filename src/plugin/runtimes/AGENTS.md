<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# src/plugin/runtimes/ — Standalone Runtime Adapters

## Purpose

Runtime layer for the standalone daemon (non-opencode dispatch path). Defines the `AgentAdapter` contract and implements it for `claude` (Claude Code CLI, streaming JSON) and `codex` (Codex CLI, JSONL), plus an unavailable stand-in for `opencode` when running outside the opencode plugin host. Also owns run bookkeeping (`RuntimeRunStore`), subagent→child-card linking, stuck-run watchdog, and the shared git/usage capture helpers used by both the standalone host and the embedded plugin dispatch path.

## Key Files

| File | Description |
|------|-------------|
| `types.ts` | `AgentAdapter`, `AdapterStartInput`, `DispatchHandle`, `AdapterRunResult`, `RuntimeRegistry`, `RuntimeDispatchError` — the shared adapter contract |
| `runtime-registry.ts` | `createRuntimeRegistry()` maps `AgentRuntime` → `AgentAdapter`; throws on duplicate runtime or missing adapter |
| `runtime-host.ts` | `createStandaloneRuntimeHost()` wires store/settings/adapters together; `dispatchCard()` validates `projectDir`, resolves the adapter, captures git-start, and resolves resume/queue/feedback session id via `resolveResumeSessionId()` |
| `claude-adapter.ts` | `createClaudeAdapter()` — spawns `claude -p --output-format stream-json --resume <id>`, parses `system/init` for `session_id`, streams `subagent_started/updated/completed` into `ChildLinker`, finalizes card on exit (complete/todo), fires Telegram completion + queue dispatch + git/usage capture |
| `codex-cli-adapter.ts` | `createCodexCliAdapter()` — spawns `codex exec --json -o <last-message> resume <threadId>`, parses `thread.started`/`session_configured` for the thread id, same completion/queue/capture contract as the Claude adapter |
| `opencode-adapter.ts` | `createOpencodeAdapter()` — the embedded (non-standalone) opencode dispatch path: session create/reuse, `runCommandThenPrompt`, fallback-to-new-session on prompt failure when reusing |
| `unavailable-opencode-adapter.ts` | Standalone-only stub: opencode dispatch always fails 409 with `STANDALONE_OPENCODE_UNAVAILABLE_REASON` and returns the card to `todo` |
| `runtime-run-store.ts` | `RuntimeRunStore` — JSON-persisted run records (`runtime-runs/runs.json` + per-run `prompt.md`/`events.jsonl`/`stderr.log`/`last-message.md`); `findActiveRunByCard/BySession` enforce one active run per card/session; `reconcileStale()` runs at boot to fail orphaned `starting`/`running` rows, re-derive child cards from `events.jsonl`, close stuck subagent children, and return parent cards to `todo` |
| `child-linker.ts` | `ChildLinker.onChildEvent()` — creates/updates/completes subagent child cards from Claude stream events; dedups by `(parentCardId, childRunId, taskId)` and cross-run by `(parentCardId, childTaskId)` |
| `claude-codex-watchdog.ts` | `ClaudeCodexWatchdog` — 30s poll over `in_progress` claude/codex cards; no active run → back to `todo`; active run idle >30min → `staleStatus: 'stuck'`. Skips organic CLI hook cards (`sourceContext` `codex`/`claude-code`) which never open a run — their lifecycle is owned by the prompt/stop hooks |
| `claude-stream-parser.ts` | `parseClaudeStreamLine()` — one line of `claude --output-format stream-json` → `ClaudeStreamEvent` union (`system/init`, `assistant`, `result`, `subagent_*`, `error`) |
| `codex-jsonl-parser.ts` | `parseCodexJsonlLine()` — one line of `codex exec --json` → `CodexJsonlEvent` union (`thread_started`, `turn_completed`, `agent_message`, `error`); tolerates multiple Codex event-shape variants for the thread id |
| `claude-binary.ts` | `createClaudeBinaryResolver()` — resolves `claude` via `Bun.which`, else falls back to a pinned `npx @anthropic-ai/claude-code@<version>` (setting `agent.claude.npx_version`); result cached, `resetCache()` for tests |
| `git-capture.ts` | `captureGitStart()` / `captureGitEndAndUsage()` — best-effort, **never-throwing** git snapshot + usage aggregation, shared by standalone dispatch and the opencode `session.idle` completion path |
| `usage-aggregator.ts` | `aggregateUsage()` (Claude events.jsonl) / `aggregateCodexUsage()` (Codex events.jsonl) — pure functions that turn a run's event lines into `CardUsageStats` (tools, MCP servers/tools, commands, skills, subagents) |
| `spawn-lock.ts` | `withSpawnLock(key, fn)` — per-key async mutex serializing concurrent spawns for the same card/session |
| `runtime-registry.ts` (types re-export) | See `types.ts`; `RuntimeRegistry.pickAdapter()` is the single dispatch entry point used by `runtime-host.ts` |

## For AI Agents

### Working In This Directory

- Both CLI adapters (`claude-adapter.ts`, `codex-cli-adapter.ts`) follow the **identical lifecycle shape**: acquire card+session spawn locks (`withSpawnLock`) → reject if the card or session already has an active run (`RuntimeRunStore`) → create a `RuntimeRun` + write `prompt.md`/`events.jsonl`/`stderr.log` → spawn → stream stdout into the events log while extracting the continuation id (`session_id` for Claude, `thread_id`/`threadId` for Codex) → on exit, finalize the card (`complete`+`resolution: completed` or `todo`+`[failed]`/`[aborted]` `progressSummary`) → notify Telegram → `dispatchNextQueuedTodoCard()` → `captureGitEndAndUsage()` **last**. When touching one adapter's completion path, check whether the same fix applies to the other — they are intentionally parallel, not shared, because the wire formats differ.
- `resolveResumeSessionId()` in `runtime-host.ts` is the **single source of truth** for which prior session a dispatch reuses: feedback (`feedbackForCardId`) > explicit `resumeSessionId` > queue continuation (`resolveQueueReusedSession`, only when the predecessor is not still `in_progress`) > same-card retry after a recent failure (`isRecentlyFailed`, imported from `../hooks/event-handler`). Do not reorder this waterfall without re-reading `docs/invariants.md`'s "Runtime dispatch" and "Feedback 카드" sections.
- `sessionId` in adapter output must always be the runtime's **actual continuation id** — never `runId`, a `pending-*` placeholder, or an empty string (`docs/invariants.md`). Timeouts (`waitForSessionId` / `waitForThreadId`, default 30s, configurable via `sessionIdTimeoutMs`/`threadIdTimeoutMs`) kill the process, mark the run `failed`, and return the card to `todo` rather than let a dispatch hang indefinitely.
- `git-capture.ts` functions are called from two places per runtime: dispatch start (`runtime-host.ts` / embedded `plugin/index.ts`) and completion (adapter success branch here / `event-handler.ts`'s `session.idle` for opencode). They must stay best-effort — wrap new logic in the existing try/catch, never let a capture failure block dispatch, completion, queue auto-dispatch, or Telegram.
- `RuntimeRunStore.reconcileStale()` runs once at daemon boot (`createStandaloneRuntimeHost`) — if you add new run state that needs cross-restart recovery, extend the reconcile step rather than adding a second recovery path.

### Testing Requirements

Run before any change here, and always before the full suite:

```bash
bun test src/__tests__/claude-adapter.test.ts
bun test src/__tests__/codex-cli-adapter.test.ts
bun test src/__tests__/runtime-registry.test.ts
bun test src/__tests__/runtime-run-store.test.ts
bun test src/__tests__/daemon-runtime-host.test.ts
bun test src/__tests__/runtime-api.test.ts
bun test src/__tests__/runtime-lock.test.ts
```

Runtime dispatch is one of the high-risk areas tracked in `docs/invariants.md` ("Runtime dispatch" row) — its contract spans `src/core/types.ts`, `src/core/runtime-config.ts`, this directory, and `src/plugin/index.ts`. Read that doc's "Runtime dispatch" and "Git/Usage 캡처" invariant lists before changing adapter completion/failure branches, and update it alongside code + tests.

### Common Patterns

- Adapters are constructed via `create<Name>Adapter(deps)` factories taking `{ store, settingsStore, runStore, dispatchFn, commandOverride, ...timeouts }` — `commandOverride` and injected timeouts exist specifically so tests can swap the spawned binary and avoid real timeout waits.
- Card failure updates always set `staleStatus: null, staleDetectedAt: null` alongside `status: 'todo'` — clearing stale flags is part of the "return to todo" contract, not optional cleanup.
- `mirrorResult()` (both adapters, duplicated intentionally) truncates result text mirrored onto the card at 60,000 chars; full output always remains in the run directory's `last-message.md`/`events.jsonl`.
- Stream parsers (`claude-stream-parser.ts`, `codex-jsonl-parser.ts`) are pure functions with no I/O — extend them with new event variants rather than parsing JSON inline in the adapters.

## Dependencies

### Internal

- `src/core/types.ts` — `AgentRuntime`, `KanbanCard`, `DispatchResult`, `CardGitState`, `CardUsageStats`
- `src/core/runtime-config.ts` — `RUNTIME_CATALOG`, `resolveAgentRuntime`, model/sandbox/effort validation and defaults
- `src/core/store.ts` (`KanbanStore`) — card CRUD, `findByChildLink`, `getScreenshotPath`
- `src/core/settings-store.ts` — per-setting overrides (permission mode, sandbox, reasoning effort, npx pinned version, bypass flags)
- `src/core/git-info.ts` — git snapshot/branch-diff primitives consumed by `git-capture.ts`
- `src/core/filelock.ts`, `src/core/data-dir.ts` — `RuntimeRunStore` persistence
- `../hooks/event-handler.ts` — `dispatchNextQueuedTodoCard`, `isRecentlyFailed` (imported here, not duplicated)
- `../telegram-completion.ts` — `notifyTelegramCompletion` fired from both adapters' success branch
- `../dispatch-prompt.ts` — `buildDispatchPromptText` builds the prompt string dispatched to the CLI

### External

- `Bun.spawn` — process execution for both CLI adapters (stdin/stdout/stderr piping)
- `nanoid` — run id generation in `RuntimeRunStore`
- Node `node:fs`, `node:fs/promises`, `node:path` — run artifact I/O

<!-- MANUAL: -->
