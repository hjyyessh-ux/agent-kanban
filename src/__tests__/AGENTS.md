<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-08 | Updated: 2026-07-01 -->

# src/__tests__/ — Bun Unit and Integration Tests

## Purpose

All Bun-based test coverage lives here as `*.test.ts` files (60+ suites). The suite leans on real temp directories, real `createServer()` instances, manual stubs, and explicit invariant tests rather than mocking frameworks.

## Key Files

| File | Description |
|------|-------------|
| `setup.ts` | Shared test factories/temp dirs — `createTestCard()`, `createTestBoard()`, `withTempDir()`; preloaded via `bunfig.toml` |
| `plugin-hooks.test.ts` | Hook invariants — subagent linking, dedup, sanitization, idle completion (highest-risk suite, 149KB) |
| `workflow-regression.test.ts` | Cross-flow regressions — parent-child + idle completion + Telegram follow-up |
| `telegram-poller.test.ts` | Telegram polling runtime behavior via `globalThis.fetch` stubs (highest-risk suite, 103KB) |
| `feedback-session-reuse.test.ts` | Session reuse invariants for feedback flow (highest-risk suite) |
| `store.test.ts`, `filelock.test.ts`, `scheduler-store.test.ts`, `settings-store.test.ts`, `script-store.test.ts` | Temp-dir backed persistence/locking store tests |
| `cc-settings-store.test.ts` | Vertex/proxy detection, tool-search effective-state, skill-visibility override logic for `core/cc-settings-store.ts` |
| `cold-storage-store.test.ts` | Freeze/restore/move/copy + content hashing for skills and MCP entries in `core/cold-storage-store.ts` |
| `mcp-config-store.test.ts` | MCP inventory reads, plaintext-secret detection, safe `.claude.json` mutation, copy/move/remove for `core/mcp-config-store.ts` |
| `codex-mcp-config.test.ts` | Codex TOML stdio/http parsing, surgical round-trip preservation, quoted names, tool policy, CAS conflict/backup, runtime identity |
| `scope-inventory-route.test.ts` | Runtime-aware `/api/scope/inventory` merge, Codex chain/trust diagnostics, Skill/Claude fail-open regression |
| `capabilities-runtime-integration.test.ts` | Isolated temporary HOME/data fixture combining Claude/Codex MCP chains and Claude/Codex/OpenCode Skill discovery without touching real user files |
| `placement-targets-store.test.ts` | Runtime-aware builtin target seeding (`claude user`, `codex user`, `cold`), legacy migration, and custom target CRUD |
| `skill-store.test.ts` | Existing persisted Claude/Codex/Opencode skill inventory compatibility |
| `skill-frontmatter.test.ts` | `disable-model-invocation` frontmatter add/update/preserve-body logic for `core/skill-frontmatter.ts` |
| `dispatch-tracker.test.ts`, `integration.test.ts` | Cross-module dispatch flows |
| `question-monitor.test.ts`, `question-routes.test.ts` | SSE/poll proxy behavior |
| `server.test.ts`, `plugin-server.test.ts`, `server-monitor.test.ts` | Real server + fetch, recovery behavior |
| `subagent-parent-registry.test.ts` | Session-to-parent mapping |
| `types.test.ts` | Shared type invariants |
| `stale-checker.test.ts` | Orphan/stuck heuristics |
| `cron-parser.test.ts` | Natural language → cron |
| `archive.test.ts` | Monthly archive behavior |
| `retry.test.ts` | Backoff/timeout edges |
| `smoke.test.ts` | Basic plugin load validation |

## Subdirectories

- `fixtures/` — captured real-CLI artifacts used as parser test ground truth. Currently holds `claude-task-stream-2.1.195.jsonl` (a real `claude --output-format stream-json` capture of an `Agent`/`Task` subagent run) plus `README.md` documenting capture provenance, CLI version, and the key event lines (`task_started` → `task_updated` → `task_notification`) each fixture verifies. Add new captures here with a matching `README.md` entry rather than inlining large JSONL blobs in test files.

## For AI Agents

### Working In This Directory

- Add new `*.test.ts` files at the top level; only fixture data (not code) belongs under `fixtures/`.
- New store modules under `src/core/` should get a matching `<name>-store.test.ts` here that uses `withTempDir()` for isolation (see `cc-settings-store.test.ts`, `cold-storage-store.test.ts`, `mcp-config-store.test.ts`, `placement-targets-store.test.ts` as the current template).
- Before touching dispatch, hooks, Telegram, or feedback flows, read `docs/invariants.md` first — these are the project's designated high-risk areas.

### Testing Requirements

- `bunfig.toml` preloads `setup.ts` automatically for every test run.
- Use `withTempDir()` for filesystem isolation; never write to the real `~/.agent-kanban/` data dir from a test.
- Start real servers with port `0` in unit/integration tests — never hardcode a port.
- Run the high-risk suite explicitly after touching dispatch/hooks/Telegram/feedback code:
  `bun test src/__tests__/plugin-hooks.test.ts src/__tests__/telegram-poller.test.ts src/__tests__/feedback-session-reuse.test.ts src/__tests__/workflow-regression.test.ts`

### Common Patterns

- Prefer manual stubs/spies over external mocking libraries.
- `globalThis.fetch` is the standard seam for Telegram and question-monitor tests.
- Test names use present tense and describe the observable behavior (e.g. `'seeds two builtin targets on first load'`).
- Pure-function logic (e.g. `applyDisableModelInvocation`) gets its own `describe` block separate from I/O-touching tests in the same file.

## Dependencies

### Internal

- Exercises modules under `../core/`, `../plugin/`, and `../server/` directly (no test doubles for the modules under test — only for external I/O like `fetch`).

### External

- `bun:test` (`describe`, `test`, `expect`, `beforeEach`) — no Jest/Vitest/Mocha.

## ANTI-PATTERNS

- Shared mutable state across tests
- Hardcoded ports in server tests
- Deleting or loosening invariant tests to make regressions pass
- Assuming test order or relying on residue from previous tests

## NOTES

- `plugin-hooks.test.ts`, `telegram-poller.test.ts`, and `workflow-regression.test.ts` are the highest-risk workflow suites; update them whenever parent-child, idle, Telegram routing, or feedback reuse rules change.

<!-- MANUAL: -->
