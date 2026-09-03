<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-06 -->

# components

## Purpose
React SPA component tree for the agent-kanban web UI. Owns all presentational and stateful UI for the board, card detail/create dialogs, capability (skill/MCP/script) management, scheduler, settings, and the wiki knowledge base. Every domain has its own subdirectory with a matching `.css` file; shared cross-domain primitives live in `shared/`. `App.tsx` (one level up) owns tab/modal state and wires these components to hooks.

## Key Files
This directory itself contains no files — see Subdirectories below.

## Subdirectories
| Directory | Description |
|-----------|--------------|
| [Board](Board/AGENTS.md) | Kanban board grid/list views, drag-and-drop columns, card view-model selectors, and the completed-session conversation modal. |
| [Capabilities](Capabilities/AGENTS.md) | Skill/MCP/script inventory, scope (user/local/project/cold) management, visibility overrides, freeze/restore to cold storage, and diff-preview-driven config edits. Large and actively evolving. |
| [Card](Card/AGENTS.md) | Card detail and create dialogs plus their sub-panels (meta, phases, queue, session picker, screenshots, feedback, questions). |
| [Question](Question/AGENTS.md) | Inline question/answer banner shown when an agent session is blocked waiting on user input. |
| `QuickActions/` | Compact left-edge launcher, modal side-sheet runner, and dedicated DialogSkeleton editor. `quickActionEditorModel.ts` owns icon payloads and untouched new-Prompt runtime/model defaulting; Script editing hides those agent fields. |
| [Scheduler](Scheduler/AGENTS.md) | Cron-style scheduled job list, create/edit modal, and run-history panel. |
| [Scripts](Scripts/AGENTS.md) | User-defined operational script CRUD, run history, and the scripts tab view. |
| [Settings](Settings/AGENTS.md) | Key/value settings entries CRUD plus the self-update/maintenance panel. |
| `Works/` | Works tab (Inbox triage, Work list, detail dialog, settings panel) and the Timeline tab (`TimelineView.tsx` + `timelineModel.ts` + `Timeline.css`). Both read one `useWorks` list; the timeline is a plain CSS grid (day columns × Work rows), no chart or calendar library. A Work's dates are editable two ways — dragging a bar's edge handle, or the detail dialog's date inputs — and both call the same `useWorks.updateWorkDates`. Both edges move on every Work: an open Work's right edge sets a *planned* end that survives completion. Grid placement lives on `.tl-bar-slot` (the wrapper), not `.tl-bar`, because the bar is a `<button>` that cannot nest the handles; drags use the handle's own pointer capture, ending on `lostpointercapture` only. `WorkDetailDialog` is one vertical stack (Summary → 기간 → 산출물 → 세션) — add a full-width row, do not reintroduce the old right-hand panel column that duplicated session info. Domain contract: [`docs/works.md`](../../../docs/works.md). |
| [Wiki](Wiki/AGENTS.md) | LLM-generated knowledge base view: config panel, force-directed doc graph, per-card wiki dialog. |
| [shared](shared/AGENTS.md) | Small cross-cutting UI primitives reused across domains (error alert banner, main tab strip). |

## For AI Agents
### Working In This Directory
- **MUST READ before adding or changing any UI: [`docs/design-system.md`](../../../docs/design-system.md).** Board cards and the Card Detail dialog define the look; every screen reuses the kv2 primitives (`kv2-btn`, `kv2-input`, `kv2-badge`, …) and `Card/DialogSkeleton.tsx` for modals. No local overrides of `kv2-*` primitives, no hand-rolled modal overlays.
- Never fork DTOs — all shared types come from `src/core/types.ts` (imported via the `../../../../src/core/types` relative path from most component files).
- `fetch()` calls belong in `web/src/hooks/*`, not in components. Components receive data/handlers as props or call hook-exported functions (e.g. `useScopeInventory`, `useSkillsApi`).
- Each domain directory owns at most one `.css` file containing **layout only** (grid/flex/gap) plus domain badge/status variants; colors, typography, and control looks come from kv2 tokens/primitives. No CSS-in-JS, no Tailwind.
- Modals use `Card/DialogSkeleton.tsx` (overlay/backdrop/dialog structure, `useModalAccessibility` focus trap + Escape, optional size persistence). Do not build a bespoke overlay.
- Resizable dialogs use `usePersistedDialogSize(storageKey, ref, defaultSize)` to remember width/height in localStorage.
- **Single-key shortcuts inside a `DialogSkeleton` must bind on `window` in the capture phase** (`addEventListener('keydown', fn, true)`), not via an `onKeyDown` prop on an inner element. `DialogSkeleton` calls `stopPropagation()` on every non-Escape key, and React's synthetic `stopPropagation` forwards to the native event at the React root — so a bubble-phase listener never fires, and a subtree `onKeyDown` only fires when focus happens to sit inside that subtree (DialogSkeleton's initial focus can legitimately land on the dialog's × button). `Works/BulkAssignModal.tsx` is the reference implementation; leave Escape to `useModalAccessibility`.
- Quick Action Add/Edit stays separate from the side-sheet runner. The collapsed desktop launcher is a labeled `⚡ Quick ›` edge tab positioned in the Board's left gutter without consuming layout width; mobile shows the same horizontal tab above the Board. The expanded `DialogSkeleton` overlays from the left, dims/inerts Board/List without changing geometry, and becomes full viewport on mobile. The runner unmounts while Add/Edit is open so modal focus traps do not overlap. A new Prompt draft uses `useRuntimeDefaults().prefs.runtime ?? "opencode"` and `useRuntimeModelSelection().getDefaultModelForRuntime()`; saved edits win, and asynchronous defaults must respect per-field Runtime/Model touched state.

### Testing Requirements
- Bun test runner (`bun:test`), colocated as `ComponentName.test.tsx` / `.test.ts` next to the component (see `Board/`, `Card/`).
- Prefer testing extracted pure functions/selectors (e.g. `board-selectors.ts`, `board-utils.ts`, `confirmBoardCardDelete`) over full component rendering.

### Common Patterns
- View-model selector modules (e.g. `Board/board-selectors.ts`) transform raw `KanbanCard[]` into render-ready shapes, keeping components declarative.
- Polling via `usePolling(refreshFn, intervalMs, enabled?)` is the sync model — no websockets, no React Query/SWR.
- Destructive actions (delete, freeze, remove) confirm via `window.confirm(...)` before calling the hook mutation.

## Dependencies
### Internal
- `src/core/types.ts` — all shared DTOs/enums.
- `web/src/hooks/*` — data fetching, polling, persisted UI state.
- `web/src/constants/*` — agent/command catalogs.

### External
- `react`, `react-dom`
- `react-markdown`, `remark-gfm`, `remark-breaks` (Card/Wiki markdown rendering)
- `react-force-graph-2d` (Wiki graph)

<!-- MANUAL: -->
