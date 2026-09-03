<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-02 | Updated: 2026-09-02 -->

# src/plugin/works/ — Works Settings, Summary & Completion Lifecycle

## Purpose

Backend for the Works tab's settings panel and the Work Summary pipeline. A `Work`
(see `src/core/work-store.ts`) groups one or more sessions; this directory owns
the `works.*` settings (independent of the wiki's LLM config) and the on-demand
LLM that turns a Work's connected-session transcripts into a 3–5 line Korean
summary, plus the completion lifecycle that turns "this Work is done" into a
bulk card done→archive sweep feeding the wiki pipeline. No background worker —
summaries are generated per Work on a button click
(`POST /api/works/:id/summary`) and the lifecycle runs inside
`PATCH /api/works/:id`, so there is nothing to start/stop.

## Key Files

| File | Description |
|------|-------------|
| `works-config.ts` | `WORKS_SETTING_KEYS`/`WORKS_SETTING_DEFAULTS` under the `works.*` namespace (`summary_model` default `claude-sonnet-5`, `summary_lines` default `4`, `assign_prefer_same_dir`/`assign_suggest_resume_chain` default `true`, `stale_days` default `5`, `done_confirm` default `false`). `loadWorksConfig()` reads them into a `WorksConfig`; `loadWorksConfigDto()` adds `configured` + the derived `route` (via `resolveWikiLlmRoute` from `../wiki/wiki-llm`); `saveWorksConfig()` writes only provided fields. `WORKS_SUMMARY_LINE_OPTIONS` = `[3,4,5]` is the single source for line-count validation. |
| `work-lifecycle.ts` | `applyWorkPatch()` — the `PATCH /api/works/:id` body of work. On `status: 'done'` it selects every card of every linked session, flips the non-`done` ones to `done`, hands them to `store.archiveCards()` (which stamps `wiki.status='pending'`), then stamps the Work's `archivedAt`. `works.done_confirm` defers the sweep until `confirmArchive: true`. `selectWorkCards()` / `resolveSessionStartedAt()` are the pure helpers (the latter also backs the first-link `startedAt` back-dating). |
| `works-summary.ts` | `generateWorkSummary()` — feeds every connected session's transcript to an injected `WikiLlmRunner`, skips sessions whose transcript is unavailable (reported in `skippedSessions`), throws when none is usable or the model returns nothing. `buildWorkSummaryPrompt()` (Korean, "무엇을 했나 → 결정 → 남은 일" ordering, exactly N lines). `parseSummaryLines()` strips bullet/number markers + preamble and caps at N lines. |

## For AI Agents

### Working In This Directory

- Works Summary reuses the wiki's one-shot LLM abstraction (`createWikiLlm`, `WikiLlmRunner`, `resolveWikiLlmRoute`) from `../wiki/wiki-llm.ts` and the transcript loader `loadClaudeTranscript` from `../wiki/wiki-transcript.ts`. The Summary **model is a separate setting** (`works.summary_model`) — never fall back to `wiki.model`. The route (codex vs claude) is derived from the model prefix, so only the model id is persisted (no separate runtime key).
- `generateWorkSummary` takes the runner + transcripts as injected deps and does no I/O itself — keep it pure so it stays unit-testable without spawning a CLI (`src/__tests__/works-config.test.ts` injects a fake runner). The route in `src/server/routes.ts` builds the real runner, resolves each session's transcript from the board cards (session → card → `agentRuntime`/`projectDir`), persists the result via `workStore.updateWork({ summary })`, and returns a `WorkSummaryResponse`.
- Route ordering matters: `GET/POST /api/works/config` must be registered **before** the `/^\/api\/works\/([^/]+)$/` catch-all (otherwise `config` is parsed as a Work id). There is a regression test for this.
- `applyWorkPatch` is the **only** place card-level completion side effects belong. Two hard rules, both regression-tested: (1) never call `store.archiveCards([])` — an empty seed list means "archive every done card on the board", so a Work with no linked cards must short-circuit to `archiveSkipped='no-cards'`; (2) card status changes go through the plain `store.updateCard` write, never a completion hook, so bulk-closing a Work cannot trigger queue auto-dispatch. The card sweep runs *before* the Work is stamped so a failed sweep leaves a retryable Work rather than one advertising an archive that did not happen. Read `docs/invariants.md` → "Work 완료 라이프사이클" before touching this file.
- `discarded` is deliberately cheap: resolution stamps only, no card mutation, and `WikiWorker` drops those cards from its queue as terminal `skipped`. Do not add an archive step to the discard path — the Timeline needs the cards to stay put.
- Transcript loading is Claude-only and best-effort; a Work whose sessions have no readable transcript returns `422` ("No session transcripts available"), never a fabricated summary.
