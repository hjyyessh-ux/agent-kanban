<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Board

## Purpose
Renders the kanban board itself: grid (column) view and list view, drag-and-drop status changes, per-card view models, filtering, and the modal used to inspect a completed/done session's full conversation. This is the highest-traffic screen in the app (polled every 3s per the workflow invariants).

## Key Files
| File | Description |
|------|-------------|
| `BoardScreen.tsx` | Top-level board container. Builds columns via `selectColumns`, applies `BoardFilters` then (when on) `filterUnreadOnly`, and switches between grid (`BoardColumn`) and `BoardListView`. Owns unread navigation: consumes `App`'s `UnreadJumpRequest` (toolbar ↑/↓, `u`/`Shift+U`) and the column pill, and forwards `onMarkCardsRead` to the complete column's `⋯ → 모두 읽음`. Jump targets are found by `data-card-id` (set on the flat card wrapper, the session turn `<article>`, and the list row). |
| `BoardWorkspace.tsx` | Relative shell that overlays the labeled `⚡ Quick ›` edge tab in the left gutter and marks shared Board/List content inert/aria-hidden while the modal side sheet is open. |
| `BoardColumn.tsx` | Single status column: renders `BoardCard`/`BoardCompleteSessionView` children, handles native HTML5 drag-and-drop reordering (`getDragAfterElement`). |
| `BoardColumnHeader.tsx` | Column title, card count, WIP-limit warning (`WIP_LIMIT = 3`), and on the complete column the filled `● N` unread pill (`column.unreadCount`) — a button when `onUnreadJump` is wired (jumps to the column's next unread). The bulk actions (`모두 숨기기`/`모두 접기` · `모두 읽음` · `모두 완료` · `모두 아카이브` — `COLUMN_MENU_COPY`; `모두 읽음` only while `unreadCount > 0`, and it stamps read without moving cards to Done) are built by the pure `getColumnMenuItems()` and rendered inside one `⋯` `BoardColumnMenu` — never as header buttons again: they squeezed the label to `COMP…`. The label is `flex: 0 0 auto`. |
| `BoardColumnMenu.tsx` | The header's `⋯` menu: `useAnchoredPopover` (body portal, outside-click close) + `WorkSessionMenu`'s keyboard pattern (focus first item on open, ↑/↓/Home/End, Escape returns focus to the trigger). The trigger keeps `kv2-column-action` and is named `"<Label> column actions"` (e2e selects it by that role name). |
| `BoardColumnHeader.test.tsx` | Tests `getColumnMenuItems` (labels, order, no event forwarded into handlers), that the header renders a `BoardColumnMenu` instead of buttons, and the unread pill's visibility rules. |
| `BoardCard.tsx` | Individual card rendered in grid view; wires drag handlers, status-change buttons, dispatch/queue/delete actions, and delete-confirmation logic (`confirmBoardCardDelete`, exported for testing). Layout (anatomy in `docs/kanban-board.md`): row 1 `.kv2-card-top` = project chip (`works-dir-chip kv2-project-chip` + `dirAccentClass`, full path on `title`) ··· right group (`.kv2-card-header-meta`: unread · origin badges · ☆ · `#ID`, never shrinks); title; one-line prompt (always shown, even when equal to the title); divider; `.kv2-card-meta-row` = `ExecutionTypeBadge` + `BoardCardTimeMeta`. No `Session:`/`Proj:`/`Created` lines on the card face — resume copy lives in `CardDetailDialog`. |
| `BoardCard.test.tsx` | Tests `confirmBoardCardDelete`'s `window.confirm` gating, row-1 chip/ID, runtime badge placement, prompt-always-shown, absence of `Session:`/`Proj:`, and every status branch of the time line (incl. live in-progress elapsed). |
| `BoardCardSections.tsx` | Shared sub-pieces reused by card/list/session views: runtime/Telegram/origin/execution badges, favorite/action controls, nested children, spinner, and queue target. `CardActions` renders `primaryActionFor` + `secondaryActionFor` (`constants/card-actions.ts`) — never its own status → label branch. |
| `BoardCompleteSessionView.tsx` | Groups `done`/`complete` cards into collapsible session groups (`CompleteSessionGroup`), used instead of the flat card list for finished work (always for `done`; for `complete` only while the "세션 묶기" toggle is on). A turn row's Result line summarizes `splitCardResult(card).final`, so it shows the deliverable rather than the interim output that preceded it. A feedback card's turn row is summarized by its instruction — `stripFeedbackHeader()` peels the generated `[Feedback for: …]` block first, which would otherwise fill the whole row (`board-selectors.ts`'s `getBoardSummary` does the same for board/list cards). An expanded group shows the newest `INITIAL_VISIBLE_TURNS` (5) turns and folds the older ones behind a `Show N more` button — the slice is taken on the newest-first array, before the per-group sort toggle reverses it, so it stays the newest five in either direction. When folded turns are unread the button reads `Show N more · k unread`. **Latest and unread are separate signals**: the latest turn (`--current`) gets an ink-filled node and a `LATEST · hh:mm` stamp only — never the complete accent or any unread colour on its border; an unread turn (`--unread`, from `isUnreadCompletion`) gets `--kv2-unread-surface`, an unread border, a `NEW` tag and a ringed node; a group with any unread turn adds `--unread` (left strip in unread colour) and a filled `● N unread` pill ahead of the `N cards` chip. Turn stamps come from `formatTurnStamp` (`hh:mm` today, else `MM-DD hh:mm`). |
| `SessionConversationModal.tsx` | Full-conversation modal opened from a completed session group; renders markdown turns and embeds `FeedbackPanel` for follow-up feedback. |
| `BoardFilterBar.tsx` | Search/date-range/session filter bar bound to `BoardFilters`. |
| `BoardListView.tsx` / `BoardListView.test.ts` | Dense list-mode alternative to the column grid, using `BoardListRowAction` for row-level start/reopen/done actions. |
| `BoardListRowAction.tsx` / `.test.ts` | Pure function `getRowActionConfig` — the row's single action is the card's **primary** action from `primaryActionFor` (`constants/card-actions.ts`), the same mapping `CardActions` and Card detail use: todo → 시작/지금 시작, in_progress → 실행 종료 (→ complete), complete → 완료 (→ done), done → 다시 열기. The List used to offer REOPEN on in_progress cards. |
| `BoardProjectSwitcher.tsx` | The project bar under the header (not a dropdown): `All` + as many project chips as fit on one line + `+N More ▾`. Fitting is measured — a hidden `.app-project-switcher-measure` copy of every chip and the More trigger is laid out off-screen, a `ResizeObserver` watches the `<nav>`, and the pure `splitDirectoryOptions` picks the visible prefix (the bar never scrolls; `overflow-x: auto` is gone). Chips wear the shared project colour (`dirAccentClass`, `.is-tinted`), stop at `max-width: 190px` with `…`, carry the full path + `active · done · child` breakdown on `title`; the selected chip is `.is-selected` (outline in its own colour) while `All` keeps `.is-active` (e2e `v2-visual-audit` reads it). `ProjectMoreMenu` is the More combobox: `useAnchoredPopover(330)` + search input (`filterDirectoryOptions`, name or path) + `role="listbox"` rows (project chip · `count · age`), ↑/↓/Home/End/Enter on the input, Escape returns focus to the trigger. |
| `board-selectors.ts` / `.test.ts` | Pure transforms from `KanbanCard[]` to `V2CardViewModel`/`V2ColumnViewModel`/`ChildItem` — the board's view-model layer. Also owns the single unread rule, `isUnreadCompletion(card)` / `countUnread(cards)` (completion moment = `responseAt ?? completedAt ?? updatedAt`, unread while `completedSeenAt` is absent or earlier, never unread without a moment). The card badge, `BoardCompleteSessionView`'s `N unread` / `NEW` / hidden-turn count, `selectColumns`' `unreadCount`, and `App.tsx`'s open-card stamp, Board tab badge and `document.title` all call it — never re-derive it inline. |
| `board-utils.ts` / `.test.ts` | `groupCardsByParent`, `sortCardsForColumn`, and the `CardWithChildren` shape used for nested/subagent card trees. |
| `board-filters.ts` / `.test.ts` | `BoardFilters` type, `DEFAULT_BOARD_FILTERS`, `filterBoardCards`, and `filterUnreadOnly(cards, { groupBySession })` — the toolbar `Unread만` predicate, applied by `BoardScreen` after `filterBoardCards`. Session grouping keeps every `complete` card of a session with any unread turn; children follow their kept parent. Deliberately **not** a `BoardFilters` field: those also drive the Timeline's `sessionFilter`, and the Timeline ignores read state. |
| `unread-navigation.ts` / `.test.ts` | Pure unread-jump model: `selectBoardNavOrder(columns, cards, layout)` (reading order — columns as given, session-grouped columns group-newest-first then turn-newest-first; read cards kept so a cursor keeps its position), `nextUnreadTarget(entries, cursor, direction, status?)` (wraps; `status` = column pill), and `isTypingTarget` (the `u`/`Shift+U` guard). `BoardScreen` owns the cursor (a ref) and turns a target into a `CardRevealRequest` (`BoardCompleteSessionView` expands the group / `Show N more`, `BoardListView` opens the section), then scrolls the `[data-card-id]` element to centre and rings it for `UNREAD_FOCUS_RING_MS`. |
| `directory-display.ts` | Pure model for the project bar. `getDirectoryProjectName`/`getDirectoryParentHint` derive short labels (`name · parent` on duplicate names). **Count rule**: `buildDirectoryOptions` / `buildDirectoryTotals` count in-flight top-level cards (`todo`/`in_progress`/`complete`, top level per `groupCardsByParent`) — never `done`, never a child — so `All` equals the sum of the three active column counts; `doneCount`/`childCount` only feed the tooltip (`formatDirectoryCountBreakdown` → `active 12 · done 40 · child 2`). **Order**: `recentCount` (top-level cards touched in the last 7 days) → `count` → newest activity → label. **Top-N**: `splitDirectoryOptions` takes measured widths, keeps the longest fitting prefix (reserving room for More), and moves an overflowing selected option into the last visible slot — the sort itself never pins, so clicking a visible chip does not reorder the bar. Also `filterDirectoryOptions` and `formatActivityAge` (`5m`/`3h`/`2d`). |
| `directory-display.test.ts` | Count definition (incl. `All` == active column sum via `selectColumns`), 7-day ordering, Top-N split/selected pinning, search and age format. |
| `index.ts` | Barrel export (`BoardScreen`, `BoardFilterBar`, `BoardCard`, `BoardListView`, `BoardListRowAction`). |
| `BoardScreen.test.tsx` | Integration-style tests over the full board container. |

## For AI Agents
### Working In This Directory
- View models (`V2CardViewModel`, `V2ColumnViewModel`) are the contract between selectors and rendering — add new derived fields in `board-selectors.ts`, not inline in JSX.
- Quick Action provenance (`quickActionId`, `executionKind`, `scriptName`) is mapped by the selector and rendered by `OriginExecutionBadges` in both grid and list views.
- Drag-and-drop is native HTML5 DnD (no external DnD library); reordering math lives in `getDragAfterElement` in `BoardColumn.tsx`.
- Nested/subagent/worker child cards are modeled via `ChildItem`/`linkKind` and rendered through `NestedChildAccordion` in `BoardCardSections.tsx`.
- kv2 tokens/components are loaded globally from `main.tsx`; `BoardScreen.tsx` imports no CSS itself.
- The in-progress live clock (`BoardCardTimeMeta`) calls `useNowTick(live)` inside its own leaf component, so only that `<span>` re-renders each second and only while the card is `in_progress` with a `startedAt`. Never lift the tick into `BoardCard`/`BoardColumn`/`BoardScreen` — that repaints the whole board every second.
- `.kv2-card-directory` (`Proj:` line) is no longer used by `BoardCard`; only the complete-session group header (`BoardCompleteSessionView`) still renders it.

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
