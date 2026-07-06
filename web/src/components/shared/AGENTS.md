<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# shared

## Purpose
Small, domain-agnostic UI primitives reused across multiple component directories. Currently holds only the standard error/alert banner; add future cross-cutting presentational components here rather than duplicating them per domain.

## Key Files
| File | Description |
|------|-------------|
| `AppTabs.tsx` | Main section tab strip (`role="tablist"`, roving tabindex, Arrow/Home/End keys). Exports `MainTab`, `MAIN_TABS`, `TAB_IDS`, `PANEL_IDS` used by `App.tsx` for the tabpanel wiring. |
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
