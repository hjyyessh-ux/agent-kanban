<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# src/plugin/wiki/ — LLM Wiki Pipeline

## Purpose

Turns archived kanban cards into persistent Obsidian vault documents. Archiving a card only stamps `wiki.status = 'pending'` (in `src/core/store.ts`); `WikiWorker` here picks pending cards up on an interval, groups them by session, runs a two-stage LLM pipeline (triage keep/skip → classify into a typed doc), writes the doc + `index.md` + `log.md` into the vault, and records the outcome back on the archived cards. Opt-in (disabled by default, no boot-time auto-seed) and singleton-runtime-only (starts/stops alongside the scheduler, stale checker, and Telegram poller).

## Key Files

| File | Description |
|------|-------------|
| `wiki-config.ts` | `WIKI_PROMPT_VERSION` (bump to invalidate old classifications and re-queue them as backfill targets), `WIKI_SETTING_KEYS`/`WIKI_SETTING_DEFAULTS` (`wiki.enabled` default `false`, `wiki.vault_dir` default blank, `wiki.model` default `gpt-5.5`), `loadWikiConfig()` reads all four settings into a `WikiConfig` |
| `wiki-llm.ts` | One-shot LLM runner abstraction (`WikiLlmRunner`). `resolveWikiLlmRoute(model)`: `gpt-*` → Codex, else Claude. `createClaudeWikiLlm()` spawns `claude -p --output-format json`; `createCodexWikiLlm()` spawns `codex exec --json -s read-only -c mcp_servers={}` (skips user MCP servers for speed); both set `WIKI_INTERNAL_ENV=1` so Claude/Codex `UserPromptSubmit` hooks skip card creation for these calls. `createWikiLlm()` is the model-routing composite used in production |
| `wiki-prompts.ts` | `buildTriagePrompt()` / `buildClassifyPrompt()` (Korean prompts, prefixed with `WIKI_INTERNAL_MARKER`), `buildGroupContext()` renders a `WikiSourceGroup` as shared source material, `parseTriageResult()`/`parseClassifyResult()` validate the LLM's JSON response, `extractJsonObject()` tolerates code fences/prose and repairs unescaped control chars via `sanitizeJsonLiterals()` (gpt-5.5 sometimes emits raw newlines in `body`) |
| `wiki-sweep.ts` | `sweepWikiInternalCards()` — boot-time cleanup that soft-deletes any active board card whose title/description contains `WIKI_INTERNAL_MARKER` (legacy cards minted before `chat-message.ts` learned to skip marker prompts); idempotent, runs on every store-owning boot path |
| `wiki-transcript.ts` | `loadClaudeTranscript()` — best-effort enrichment reading `~/.claude/projects/<munged-dir>/<sessionId>.jsonl`; Claude runtime only, returns `undefined` on any miss/error; head+tail truncated (4k/8k chars) |
| `wiki-worker.ts` | `WikiWorker` class — the orchestrator: `start()`/`stop()`/`restart()` (interval + reentrancy-guard reset), `kick()` (immediate pass), `backfill()`/`reprocess()` (re-queue via `store.markWikiPending`), `processQueue()` (reentrancy-guarded, groups pending cards, runs group workers up to `concurrency`), `getStatus()`/`getConfig()`/`saveConfig()` for the `/api/wiki/*` routes and Settings panel; `groupCardsBySession()` is the exported grouping helper |
| `wiki-writer.ts` | `WikiVaultWriter` — `writeDocument()` (frontmatter + body, `uniqueDocPath()` avoids slug collisions), `updateIndex()` (dedup-by-link upsert into `index.md` via `buildIndexLine()`), `appendLog()` (Karpathy-style `log.md`), `readDocument()` (frontmatter-stripped read for UI preview, with a path-traversal guard) |

## For AI Agents

### Working In This Directory

- `WIKI_INTERNAL_MARKER` (defined in `src/core/types.ts`, re-exported from `wiki-prompts.ts` for existing import paths) must prefix **every** one-shot prompt sent to Claude/Codex from this pipeline. `chat-message.ts` (`src/plugin/hooks/`) uses this marker to skip card creation for these one-shot calls — if a new prompt-building function is added here without the marker, its LLM call will re-enter the board as a card, which can archive again and feed back into the wiki queue (an infinite loop). This is a hard invariant, not a style preference.
- Bump `WIKI_PROMPT_VERSION` in `wiki-config.ts` whenever `buildTriagePrompt`/`buildClassifyPrompt` change in a way that should invalidate prior classifications — `backfill()` and stale-prompt-version detection both key off this constant.
- `WikiWorker` must only run on the singleton runtime owner — it is started/stopped together with the scheduler engine, stale checker, and Telegram poller in `plugin/index.ts`. Do not add a second instantiation path.
- Failed groups are **not** auto-retried (`processGroup` catch records `status: 'failed'` and moves on); they only re-enter the queue via explicit `backfill()`/`reprocess()`. Do not add automatic retry-on-failure without discussing the token-cost implications — this was a deliberate choice to avoid burning LLM calls on a permanently-broken group.
- Vault writes (`writeDocument`, `updateIndex`, `appendLog`) are read-modify-write against the same files, so `WikiWorker.withVaultWriteLock()` serializes them across concurrent group workers even though LLM calls themselves run outside that lock. Any new vault-mutating step must go through this same lock, not a fresh one.
- `wiki-llm.ts` runners must keep setting `WIKI_INTERNAL_ENV` on the spawned process — this is the only signal the Claude/Codex hook side has to distinguish a wiki one-shot from a real user prompt.

### Testing Requirements

```bash
bun test src/__tests__/wiki-worker.test.ts
bun test src/__tests__/archive.test.ts       # wiki.pending stamping on archive
bun test src/__tests__/plugin-hooks.test.ts  # WIKI_INTERNAL_MARKER card-creation skip
```

Wiki processing is not in the `docs/invariants.md` high-risk table, but it directly touches `chat-message.ts` (marker-based skip) — if you change anything that affects what gets sent as a wiki-internal prompt, re-run `plugin-hooks.test.ts` per the "고위험 워크플로" guidance in `../hooks/AGENTS.md`.

### Common Patterns

- All prompts are Korean with English technical terms/commands preserved verbatim (matches the project-wide response-language convention); `body` output is markdown with code blocks for commands, no leading H1 (the writer adds `# {title}`).
- `ClassifyResult.slug` is sanitized independently by the writer (`sanitizeSlug()` in `wiki-writer.ts`) — prompts should not attempt to pre-sanitize slugs themselves.
- Reprocessing overwrites the previous doc at its existing `docPath` (looked up via `group.cards.find(c => c.wiki?.docPath)`) instead of creating an orphaned duplicate — preserve this lookup when touching `processGroup()`.

## Dependencies

### Internal

- `src/core/types.ts` — `KanbanCard`, `WikiDocType`, `CardWikiState`, `WikiConfigDto`/`WikiConfigInput`, `WikiLogEntry`, `WikiWorkerStatus`, `WikiLlmRoute`, `WIKI_INTERNAL_MARKER`, `WIKI_INTERNAL_ENV`
- `src/core/runtime-config.ts` — `CODEX_REASONING_EFFORT_VALUES`/`DEFAULT_CODEX_REASONING_EFFORT`
- `src/core/store.ts` (`KanbanStore`) — `getWikiPendingCards`, `markWikiPending`, `updateArchivedCardsWiki`, `getWikiStats`
- `src/core/settings-store.ts` — `wiki.*` setting persistence
- `../runtimes/claude-binary.ts` — shared Claude binary resolution reused by `createClaudeWikiLlm`
- `../hooks/chat-message.ts` — consumes `WIKI_INTERNAL_MARKER` to suppress card creation for wiki one-shots (see invariant above)

### External

- `Bun.spawn` — one-shot `claude -p` / `codex exec` process execution
- `nanoid` — temp file naming for the Codex last-message path
- Node `node:fs`, `node:path`, `node:os` — vault file I/O and transcript path resolution

<!-- MANUAL: -->
