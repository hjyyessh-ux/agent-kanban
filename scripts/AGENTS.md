<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-07-01 -->

# scripts

## Purpose

Standalone operational scripts that run outside the main plugin runtime: the Playwright E2E test server, install/uninstall of the opencode plugin and Claude Code/Codex hooks, runtime-owner restart helpers, and the LLM wiki backfill/reindex maintenance tools. These are repo-managed CLI entrypoints, not the user-managed Scripts-tab sync source (that data lives under `KANBAN_DATA_DIR/scripts/`).

## Key Files

| File | Description |
|------|-------------|
| `test-server.ts` | Boots `createServer()` on port `E2E_PORT` (default 24681) against `.e2e-data/`; wires all core stores (Kanban, Settings, Scheduler, Script, Skill, SkillRoots), `SchedulerEngine`, and `WikiWorker`; builds `web/dist` on demand. Used by Playwright (`playwright.config.ts`) |
| `install.sh` | Builds the project and installs the opencode plugin bundle plus Claude Code/Codex hooks into global config dirs; supports `--uninstall` to strip agent-kanban entries via `jq` |
| `restart-main-session.sh` | Gracefully restarts the current agent-kanban runtime-owner process using the singleton lock/peers files under the kanban data dir; supports `--dry-run`, `--force`, `--data-dir`; falls back to a cold-start command (`KANBAN_RESTART_COMMAND`, default `opencode`) when no live owner is found |
| `restart-opencode-plugin.sh` | Restart helper scoped to the opencode plugin process, same data-dir resolution pattern as `restart-main-session.sh` |
| `wiki-backfill.ts` | One-off/maintenance script to backfill LLM wiki documents from existing archived cards, using `WikiWorker`/`groupCardsBySession` |
| `wiki-reindex.ts` | Pure reformat of the wiki `index.md`: re-derives `processed` date + `topics` per row from each document's frontmatter via `buildIndexLine()`; no LLM calls, idempotent, writes a timestamped `.bak` before changing anything. Usage: `bun scripts/wiki-reindex.ts [vaultDir] [--dry-run]` |

## For AI Agents

### Working In This Directory

- `console.log` is acceptable here — these are CLI/runtime scripts, exempt from the app-wide no-`console.log` rule.
- `test-server.ts` runs TypeScript source directly (`bun scripts/test-server.ts`), not compiled dist output — keep it in sync with `src/server/index.ts` and store constructors when their signatures change.
- Wiki scripts (`wiki-backfill.ts`, `wiki-reindex.ts`) import directly from `src/plugin/wiki/` and `src/core/`; keep them aligned with `WikiDocType`, `loadWikiConfig()`, and `buildIndexLine()` if those change shape.
- Shell scripts (`install.sh`, `restart-*.sh`) resolve `KANBAN_DATA_DIR` with the same fallback-to-`$HOME/.agent-kanban` pattern; preserve that convention if adding new scripts that touch the data dir.

### Testing Requirements

- No dedicated unit tests for this directory. Validate `test-server.ts` changes by running `bun run test:e2e` (it is the E2E harness entrypoint).
- Validate shell script changes manually with `--dry-run` where supported (`restart-main-session.sh`).

### Common Patterns

- Bash scripts use `set -euo pipefail` and a `resolve_data_dir()` helper honoring `KANBAN_DATA_DIR`.
- TypeScript scripts are run directly via `bun scripts/<name>.ts`, never compiled first.

## Dependencies

### Internal
- `src/core/store.ts`, `src/core/settings-store.ts`, `src/core/scheduler-store.ts`, `src/core/script-store.ts`, `src/core/skill-store.ts`, `src/core/skill-roots-store.ts`, `src/core/data-dir.ts`
- `src/plugin/scheduler-engine.ts`, `src/plugin/wiki/wiki-worker.ts`, `src/plugin/wiki/wiki-writer.ts`, `src/plugin/wiki/wiki-config.ts`
- `src/server/index.ts`

### External
- `jq` (used by `install.sh` for JSON hook config editing)

<!-- MANUAL: -->
