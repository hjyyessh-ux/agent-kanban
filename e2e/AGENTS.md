<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-07-01 -->

# e2e

## Purpose

Playwright browser test specs covering the shipped React SPA end-to-end. Tests run sequentially (single worker) against `bun scripts/test-server.ts` on `http://127.0.0.1:24681`, using `.e2e-data/` as an isolated data directory instead of the real `~/.agent-kanban/` store.

## Key Files

| File | Description |
|------|-------------|
| `agent-type.e2e.ts` | Agent/runtime type selection and dispatch edge cases |
| `archive.e2e.ts` | Card archival flow |
| `board.e2e.ts` | Core board rendering/layout |
| `board-detail-actions.e2e.ts` | Bulk board actions and card detail interactions |
| `capabilities.e2e.ts` | Capabilities tab: skills, MCP config, scope inventory/targets, storage drawer |
| `card-button-visibility.e2e.ts` | Conditional button visibility on cards by state |
| `card-creation.e2e.ts` | New card creation form flow |
| `card-detail-modal.e2e.ts` | Card detail modal interactions |
| `card-detail-restart.e2e.ts` | Restart-from-card-detail flow |
| `card-lifecycle.e2e.ts` | Full todo -> in_progress -> complete -> done transitions |
| `deck-capture.e2e.ts` | Screenshot capture flow used to produce presentation deck assets |
| `dialog-position.e2e.ts` | Dialog/modal positioning behavior |
| `dispatch.e2e.ts` | Card dispatch to a runtime session |
| `error-handling.e2e.ts` | API/form error-path UI behavior |
| `foldable-ui.e2e.ts` | Foldable/collapsible UI section behavior |
| `polling.e2e.ts` | Board polling / eventual-consistency assertions |
| `progress-result.e2e.ts` | Progress summary and result field rendering |
| `responsive.e2e.ts`, `responsive-columns.e2e.ts` | Responsive layout and column behavior across viewport sizes |
| `runtime-integration.e2e.ts` | Cross-runtime (opencode/Codex/Claude) integration behavior |
| `screenshot.e2e.ts` | Screenshot upload/attachment UI |
| `sorting.e2e.ts` | Card ordering/sorting behavior |
| `theme.e2e.ts` | Light/dark/system theme toggle, `data-theme` + localStorage persistence |
| `v2-visual-audit.e2e.ts` | V2 design-system compliance checks (light + dark screenshot variants) |
| `wiki-archive-cards.e2e.ts` | LLM wiki processing triggered by card archival, excluding child cards |
| `tsconfig.json` | TypeScript config scoped to the e2e test tree |

## Subdirectories

| Directory | Description |
|-----------|-------------|
| `fixtures/` | Shared Playwright fixtures (`kanban.ts`) and static test assets (`test-screenshot.png`) |
| `helpers/` | API seeding helpers (`api.ts`) for creating/updating/deleting cards and scripts without driving the UI |
| `results/` | Playwright test-result output (generated; not source) |

## For AI Agents

### Working In This Directory

- Import `test` and `expect` from `./fixtures/kanban`, not directly from `@playwright/test` — the custom fixture adds `seedCard`, `seedCardWithStatus`, and `trackCard` (auto-cleanup via `apiDeleteCard`) on top of the base test.
- Seed data through `e2e/helpers/api.ts` (`apiCreateCard`, `apiUpdateCard`, `apiDeleteCard`, `apiGetCards`, `apiArchiveCards`, `apiUploadScreenshot`, `apiGetScreenshotUrl`, `apiCreateScript`, `apiDeleteScript`, `apiGetScripts`) rather than clicking through creation forms, unless the UI path itself is what's under test.
- Base URL for API helpers defaults to `http://127.0.0.1:24681`, overridable via `E2E_BASE_URL`.
- Rely on Playwright auto-waiting and locator assertions; avoid `page.waitForTimeout()` as a synchronization mechanism.
- Track every card you create for cleanup (the `trackCard`/`seedCard` fixtures do this automatically — use them instead of raw `apiCreateCard` calls where possible).

### Testing Requirements

- Run the full suite with `bun run test:e2e` (alias for `npx playwright test`).
- `playwright.config.ts` sets `workers: 1`, `fullyParallel: false`, `testIgnore: ['**/photo-compare.e2e.ts']` (that spec no longer exists in the tree — the ignore entry is stale), and starts `bun scripts/test-server.ts` as its web server.
- The test server wipes `.e2e-data/` on each run unless `E2E_KEEP_DATA=true` is set.

### Common Patterns

- One spec file per feature area, named `<feature>.e2e.ts`.
- Specs that touch card state always clean up via the `trackCard`/`seedCard` fixture pattern rather than manual `afterEach` deletion.

## Dependencies

### Internal
- `scripts/test-server.ts` (server under test)
- `web/dist` (built SPA served by the test server)

### External
- `@playwright/test`

<!-- MANUAL: -->
