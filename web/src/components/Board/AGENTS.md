<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Board

## Purpose
Renders the kanban board itself: grid (column) view and list view, drag-and-drop status changes, per-card view models, filtering, and the modal used to inspect a completed/done session's full conversation. This is the highest-traffic screen in the app (polled every 3s per the workflow invariants).

## Key Files
| File | Description |
|------|-------------|
| `BoardScreen.tsx` | Top-level board container. Builds columns via `selectColumns`, applies `BoardFilters`, and switches between grid (`BoardColumn`) and `BoardListView`. |
| `BoardColumn.tsx` | Single status column: renders `BoardCard`/`BoardCompleteSessionView` children, handles native HTML5 drag-and-drop reordering (`getDragAfterElement`). |
| `BoardColumnHeader.tsx` | Column title, card count, WIP-limit warning (`WIP_LIMIT = 3`), "hide all sessions" / "complete all" / "archive" actions. |
| `BoardColumnHeader.test.tsx` | Tests for header count/WIP-limit rendering. |
| `BoardCard.tsx` | Individual card rendered in grid view; wires drag handlers, status-change buttons, dispatch/queue/delete actions, and delete-confirmation logic (`confirmBoardCardDelete`, exported for testing). |
| `BoardCard.test.tsx` | Tests `confirmBoardCardDelete`'s `window.confirm` gating. |
| `BoardCardSections.tsx` | Shared sub-pieces reused by card/list/session views: `RuntimeBadge`/`RuntimeBadgeIcon`, `TelegramBadge`, `FavoriteToggleButton`, `CardActions`, `NestedChildAccordion`, `ActionSpinner`, `QueueTargetChip`. |
| `BoardCompleteSessionView.tsx` | Groups `done`/`complete` cards into collapsible session groups (`CompleteSessionGroup`), used instead of the flat card list for finished work. |
| `SessionConversationModal.tsx` | Full-conversation modal opened from a completed session group; renders markdown turns and embeds `FeedbackPanel` for follow-up feedback. |
| `BoardFilterBar.tsx` | Search/date-range/session filter bar bound to `BoardFilters`. |
| `BoardListView.tsx` / `BoardListView.test.ts` | Dense list-mode alternative to the column grid, using `BoardListRowAction` for row-level start/reopen/done actions. |
| `BoardListRowAction.tsx` / `.test.ts` | Pure function `getRowActionConfig` deciding which single action (START/REOPEN/DONE) a row exposes, based on card status. |
| `BoardProjectSwitcher.tsx` | Dropdown to scope the board to one project directory, built from `buildDirectoryOptions`. |
| `board-selectors.ts` / `.test.ts` | Pure transforms from `KanbanCard[]` to `V2CardViewModel`/`V2ColumnViewModel`/`ChildItem` — the board's view-model layer. |
| `board-utils.ts` / `.test.ts` | `groupCardsByParent`, `sortCardsForColumn`, and the `CardWithChildren` shape used for nested/subagent card trees. |
| `board-filters.ts` | `BoardFilters` type, `DEFAULT_BOARD_FILTERS`, and `filterBoardCards`. |
| `directory-display.ts` | `getDirectoryProjectName`/`getDirectoryParentHint`/`buildDirectoryOptions` — derives short display labels from absolute project directory paths. |
| `index.ts` | Barrel export (`BoardScreen`, `BoardFilterBar`, `BoardCard`, `BoardListView`, `BoardListRowAction`). |
| `BoardScreen.test.tsx` | Integration-style tests over the full board container. |

## For AI Agents
### Working In This Directory
- View models (`V2CardViewModel`, `V2ColumnViewModel`) are the contract between selectors and rendering — add new derived fields in `board-selectors.ts`, not inline in JSX.
- Drag-and-drop is native HTML5 DnD (no external DnD library); reordering math lives in `getDragAfterElement` in `BoardColumn.tsx`.
- Nested/subagent/worker child cards are modeled via `ChildItem`/`linkKind` and rendered through `NestedChildAccordion` in `BoardCardSections.tsx`.
- Imports `../../styles/kanban-v2.tokens.css` and `../../styles/kanban-v2.components.css` (the `.kv2-*` design tokens) directly in `BoardScreen.tsx`.

### Testing Requirements
- Colocate `*.test.ts`/`*.test.tsx` next to the source file; prefer testing exported pure functions (`getRowActionConfig`, `groupCardsByParent`, `confirmBoardCardDelete`, `selectColumns`) over full DOM rendering.
- Run `bun test src/__tests__/plugin-hooks.test.ts ...` from the project root is unrelated backend guidance — for this directory, run `bun test web/src/components/Board` (or the specific `.test.tsx` file) after changes.

### Common Patterns
- Status-change and dispatch actions are passed down as callback props (`onStatusChange`, `onDispatch`, `onQueueOpen`) — components never call the API directly.
- `timeAgo`/duration formatting is centralized in `web/src/utils/format-duration.ts`, not reimplemented per component.

## Dependencies
### Internal
- `src/core/types.ts` (`KanbanCard`, `KanbanStatus`)
- `src/plugin/question-monitor.ts` (`QuestionRequest`, surfaced via `BoardScreen`)
- `web/src/constants/agents.ts` (`getAgentConfig`)
- `web/src/utils/agent-label.ts`, `web/src/utils/resume-command.ts`, `web/src/utils/format-duration.ts`
- `Card/DialogSkeleton.tsx`, `Card/FeedbackPanel.tsx`, `Card/CardMarkdown.tsx` (used by `SessionConversationModal`)

### External
- `react` (no external DnD/state library)

<!-- MANUAL: -->
