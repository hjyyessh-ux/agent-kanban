<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# shared

## Purpose
Small, domain-agnostic UI primitives reused across multiple component directories. Currently holds only the standard error/alert banner; add future cross-cutting presentational components here rather than duplicating them per domain.

## Key Files
| File | Description |
|------|-------------|
| `AppTabs.tsx` | Main section tab strip (`role="tablist"`, roving tabindex, Arrow/Home/End keys). Exports `MainTab`, `MAIN_TABS`, `TAB_IDS`, `PANEL_IDS` used by `App.tsx` for the tabpanel wiring. Optional `badges` prop renders a count pill next to a tab label (`.app-tab-badge` + `.app-tab-badge--<tab>`): Board = unread completions (unread-colour fill), Works = unassigned Inbox sessions. The badge's `aria-label` is `"<N> <noun>"` from `BADGE_NOUNS` — add the noun there when a new tab gets a badge. `AppTabs.test.tsx` covers the labels. Adding a tab means adding its key to **all five** exports (`MainTab`, `MAIN_TABS`, `TAB_IDS`, `PANEL_IDS`, `TAB_LABELS`) plus the `tabRefs` record — the `Record<MainTab, …>` types make a miss a type error. Order: `board, works, timeline, wiki, capabilities, scheduler, settings`. |
| `IdChip.tsx` / `.test.tsx` | The single identifier primitive. `IdChip` (`#` + 8 via `utils/short-id.ts`, click copies the raw id, `✓ 복사됨` for 1.5s via `hooks/useCopyFeedback`), `IdText` (same look, inert — for ids inside a row that is itself a button/option), `ResumeCopyButton` (`⏎ resume`, copies a `buildResumeCommand` string). Used by Board, Card, Works, Mention, Capabilities. Styles: `.kv2-id-chip*` / `.kv2-resume-copy` in `styles/kv2/primitives.css`. |
| `ImageLightbox.tsx` / `.test.ts` | Full-screen screenshot preview portalled to `document.body`: opens fitted, zooms by `+`/`−`/wheel/double-click (`stepZoom`, 10%–800%), drag pans a zoomed image, `화면 맞춤`/`원본 100%`. Swallows its own Esc so the surrounding `DialogSkeleton` stays open. Used by `Card/ScreenshotPanel`, `Card/FeedbackPanel`, `Board/SessionConversationModal`. Styles: `.kv2-screenshot-lightbox*` in `styles/kv2/panels.css`. |
| `ErrorAlert.tsx` | Reusable error banner (`role="alert"`, `aria-live="assertive"`) with a title, message, optional action button, and optional dismiss button. Supports `banner` (full-width) and `inline` variants via `.kv2-alert*` classes. Used by `Card/CreateCardDialog.tsx`, `Scheduler/SchedulerView.tsx`, `Scheduler/SchedulerJobModal.tsx`, `Settings/SettingsView.tsx`, `Settings/SettingsEntryModal.tsx`. |

## For AI Agents
### Working In This Directory
- Before adding a new component here, confirm it is genuinely used by 2+ domain directories — single-use UI belongs in its own domain folder, not `shared/`.
- `ErrorAlert` takes a `UiAlert`-shaped error via its `title`/`message` props in most call sites (see `web/src/hooks/uiAlert.ts`) — keep that convention when wiring new error states rather than inventing a parallel error-display component.

### Testing Requirements
- No colocated tests. `ErrorAlert` is presentational only (no internal state) — unlikely to need dedicated tests beyond what covers its call sites.

### Common Patterns
- Uses the kv2 design system (`.kv2-alert*` classes); styling lives in `web/src/styles/kv2/primitives.css`, not a local `.css` file in this directory. See `docs/design-system.md`.

## Dependencies
### Internal
- None (pure presentational component; consumers pass in `UiAlert`-shaped data from `web/src/hooks/uiAlert.ts`).

### External
- `react` (implicit via JSX)

<!-- MANUAL: -->
