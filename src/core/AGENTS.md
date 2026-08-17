<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-25 | Updated: 2026-07-01 -->

# src/core/ — Shared Contracts, Stores, Locks

## OVERVIEW

Shared data layer for every runtime. Defines card/scheduler/settings/script/Telegram/capability types, primary-agent and runtime-model defaults, cron parsing, retry helpers, secret detection, and filesystem-backed stores with dual locking — including the Scope Manager stores for Claude Code settings, MCP config, cold storage, and placement targets.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Change card, screenshot, stale, feedback fields | `types.ts` | Shared by backend, web, tests |
| Change scheduler action/history schema | `types.ts`, `scheduler-store.ts` | Scheduler JSON lives in `schedulers.json` |
| Change settings secrets/toggles storage | `settings-store.ts` | Persists `settings.json` |
| Change synced script storage/history | `script-store.ts` | Persists `scripts.json`, syncs `KANBAN_DATA_DIR/scripts/` |
| Change settings/parameter env injection or redaction | `execution-environment.ts` | Shared by scheduler and ScriptExecutionService; `AK_PARAM_*` is reserved for validated parameters |
| Change Quick Action schema, validation, templates, or persistence | `types.ts`, `quick-action-store.ts` | `quick-actions.json`; Prompt run idempotency state is stored on the generated card |
| Change board/archive/screenshot persistence | `store.ts` | `active.json`, archive files, screenshot paths, queue helpers, scheduled-dispatch claim/recovery |
| Change wiki state stamping/queueing on archived cards | `store.ts`, `types.ts` | `CardWikiState`; archive stamps `wiki.status='pending'`; `markWikiPending()` drives backfill |
| Change Telegram chat/session pinning | `telegram-state-store.ts` | Persists `telegram-state.json` |
| Change cron parsing or descriptions | `cron-parser.ts` | Korean/English natural language support |
| Change primary agent labels/models | `agent-config.ts`, `agent-type.ts` | Shared by web + plugin |
| Change per-runtime model catalog (Claude/Codex/Opencode) | `runtime-config.ts` | `RUNTIME_CATALOG`, `CLAUDE_MODELS`, `CODEX_MODELS`, Codex reasoning/sandbox defaults |
| Change lock or retry behavior | `filelock.ts`, `retry.ts` | Reused by multiple stores |
| Change `~/.claude/settings.json` skill overrides / MCP toggles / diagnostics | `cc-settings-store.ts` | Merges user/project/local scope; `ContextDiagnostics` (tool-search effective, Vertex/proxy detection) |
| Change `~/.claude.json` MCP server placement (copy/move/remove across user/local/project) | `mcp-config-store.ts` | CAS engine `safeMutateClaudeJson` (etag compare-and-swap, backup, post-write verify, rollback); also drives `.mcp.json` for project scope |
| Change Codex MCP config (`~/.codex/config.toml`, `<dir>/.codex/config.toml`) | `codex-mcp-config.ts` | Surgical TOML table edits preserve unrelated config/comments; CAS + lock + backup + verify |
| Change Claude/Codex MCP routing or inventory aggregation | `mcp-runtime-adapter.ts` | Runtime strategy boundary; legacy requests default to Claude |
| Change cold-storage freeze/restore/read for skills and MCP servers | `cold-storage-store.ts` | `manifest.json` + MCP `registry.json` under `<dataDir>/cold-storage/`; same-volume rename vs cross-volume copy+hash-verify+unlink. `readColdSkillContent`/`getColdManifestView` expose frozen content + per-entry summaries for the UI (ref is path-guarded) |
| Change plaintext-secret heuristics for MCP defs | `secret-detect.ts` | Checks env values, URL credentials, auth headers; used before writing to team-shared (project) scope |
| Change user-defined placement targets (custom directories skills/MCP can be filed under) | `placement-targets-store.ts` | Persists `placement-targets.json`; seeds builtin `Global (user)` / `Cold Storage` targets, dedupes by `dir` |
| Change `disable-model-invocation` frontmatter toggling on `SKILL.md` | `skill-frontmatter.ts` | Pure-transform + atomic-write pair; preserves all other frontmatter/body verbatim |
| Change skill discovery from disk (Claude/Codex/Opencode skill roots) | `skill-scanner.ts` | Parses `SKILL.md` frontmatter incl. tool/MCP refs; inode + id de-dup so user skills shadow system ones |

## CONVENTIONS

- `types.ts` is the single source of truth for shared DTOs.
- Store classes resolve `~`, generate IDs with `nanoid()`, write temp files, then `renameSync()` atomically.
- Writes always go through in-process mutex + `FileLock`.
- Board, schedulers, settings, scripts, Telegram state, and placement targets each persist to separate JSON files.
- `description` is required on cards.
- `findCardBySessionId()` returns the newest matching card.
- `UpdateTelegramChatStateInput` uses `null` to clear persisted optional fields.
- Script and scheduler stdout/stderr are capped to 8KB by UTF-8 bytes.
- Execution settings env cannot replace interpreter/system/internal reserved keys. Script Quick Action parameters use only normalized `AK_PARAM_<UPPER_SNAKE_KEY>` names; masked settings and secret parameters must be redacted before persistence.
- `ScriptStore.beginRun()` is the atomic per-script concurrency claim. Terminal updates replace the matching running row, running entries cannot be deleted, and stale running rows are reconciled after process restart.
- Scheduled-dispatch reservations are store-owned and atomic: `scheduled -> dispatching -> dispatched/failed`, with explicit stale-claim recovery after restart.
- Quick Action card reservation is store-owned and atomic on `(quickActionId, quickActionRequestId)`; only the caller receiving `created: true` may dispatch it.
- Primary-agent defaults live here; UI and plugin must not fork model/label maps.
- Clearing selected Telegram session/card state must not implicitly clear sticky default agent/model fields.
- `feedbackForCardId`, `telegramChatId`, and Telegram selected-session fields are part of fragile workflow contracts tracked in `docs/invariants.md`.
- `card.wiki` is written only by `archiveCards()` (pending stamp) and the wiki archive methods (`updateArchivedCardsWiki`, `markWikiPending`) — never through `updateCard()`. Wiki updates must not bump `card.updatedAt` (archive files are grouped by it).
- `resolveDir()` (leading-`~` expansion) lives in `data-dir.ts`; stores import it instead of redefining it.
- Writes to `~/.claude.json` always go through `safeMutateClaudeJson()` in `mcp-config-store.ts` — never a raw `readFileSync`/`writeFileSync` pair — because Claude Code itself writes that file concurrently and ignores our `FileLock`.
- Any MCP definition written into a `project` (team-shared) scope must pass through `detectPlaintextSecret()` first; callers surface `{ secretWarning: true }` instead of silently persisting a secret.
- `CapScope` (`'user' | 'project' | 'local' | 'cold'`) is the shared vocabulary for where a skill/MCP server lives; don't invent parallel scope strings.
- Cold storage entries are keyed by `kind:ref` (`skill:<runtime>/<name>` or `mcp:<name>`) inside `manifest.json`; MCP defs additionally live in their own `registry.json` since the original `~/.claude.json` entry is deleted on freeze.
- `placement-targets-store.ts` seeds three non-deletable builtins (`builtin-user`, `builtin-codex-user`, `builtin-cold`); `removeTarget()` must reject `builtin: true` targets.
- Missing persisted placement-target `runtime` migrates to `claude`; target dedupe uses `runtime + dir`.
- MCP inventory identity is `${runtime}:${name}`. Same-name Claude/Codex servers must never merge; same-runtime placements may merge.
- Claude MCP JSON/parser/writer/CLI fallback stays in `mcp-config-store.ts`. Codex support remains additive through `mcp-runtime-adapter.ts`.
- Codex TOML writes may replace only the selected `[mcp_servers.*]` table family; non-MCP tables/comments/order stay untouched.
- MCP write previews are read-only; apply routes explicitly call the existing Claude writer or the Codex writer. `alwaysLoad` is a Claude-only adapter capability.
- Cold MCP entries preserve their runtime and exact source placement; missing legacy metadata defaults to Claude/sourceScope.
- Codex inventory evaluates each registered directory from its git/project root down to the target directory; nearer `.codex/config.toml` definitions win for that target. Project trust is reported as required with status unknown, never inferred.
- MCP discovery is fail-open across runtimes and config layers: malformed Codex TOML becomes diagnostics and must not hide Claude MCP or persisted Skill inventory.

## ANTI-PATTERNS

- Duplicating shared interfaces in `web/`, `plugin/`, or tests
- Writing JSON directly outside store classes
- Adding a new persisted store without temp-file + dual-lock behavior
- Hardcoding agent labels/models outside `agent-config.ts`
- Hardcoding a per-runtime model list outside `runtime-config.ts`
- Mutating `~/.claude.json` without going through the CAS engine in `mcp-config-store.ts`
- Re-serializing all of Codex `config.toml` to modify one MCP server
- Skipping `detectPlaintextSecret()` before writing an MCP def into project/team-shared scope

## NOTES

- `store.ts` also owns screenshot persistence, queue ordering helpers, and scheduled-dispatch recovery helpers.
- `script-store.ts` tags runtime-synced entries with `Synced from data scripts/<file>` descriptions.
- `settings-store.ts` carries runtime toggles such as `network_exposed` and secret tokens.
- `retry.ts` is the shared utility for retryable runtime edges.
- `mcp-config-store.ts` prefers shelling out to the `claude` CLI (`claude mcp add/remove`) when available and operating on the real `~/.claude.json`, falling back to the CAS engine otherwise (always used for overridden paths in tests).
- `cold-storage-store.ts` rejects symlinks on all move/copy/freeze/restore operations (`guardNotSymlink`) and verifies directory hashes after cross-volume copies before deleting the source.

<!-- MANUAL: -->
