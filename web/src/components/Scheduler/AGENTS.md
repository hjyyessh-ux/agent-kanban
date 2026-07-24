<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Scheduler

## Purpose
Cron-style scheduled job management tab: list existing schedules, create/edit a job (cron expression + action to run), enable/disable, trigger a manual run, and inspect run history.

## Key Files
| File | Description |
|------|-------------|
| `SchedulerView.tsx` | Tab container: lists `SchedulerEntry` items with relative time formatting (`timeAgo`), wires create/update/delete/toggle/run handlers, and opens `SchedulerJobModal`/`SchedulerHistoryPanel`. Surfaces errors via `shared/ErrorAlert`. |
| `SchedulerJobModal.tsx` | Create/edit form for a `SchedulerEntry`: `간편 설정` / `Cron 직접 입력` 2모드와 local shared-helper preview, plus `SchedulerActionType` selection. |
| `SchedulerHistoryPanel.tsx` | Modal listing a job's past `SchedulerRun`s, lazily fetched via `fetchSchedulerHistory` and refreshable independent of the parent list. |
| `Scheduler.css` | `.scheduler-*` styling for the list, modal, and history panel. |

## For AI Agents
### Working In This Directory
- Schedule parsing/validation is centralized in `src/core/scheduling.ts` and shared by web/server. The modal should call the shared helper directly so preview and POST/PATCH stay identical.
- Modals here use `useModalAccessibility` (focus trap/Escape) and `usePersistedDialogSize` (resizable, localStorage-persisted) — follow the same hooks when adding new dialogs, matching `Card/DialogSkeleton.tsx`'s conventions even though these modals don't wrap `DialogSkeleton` directly.
- `SchedulerActionType` determines what a job actually does when triggered (e.g. dispatch a card, run a script) — check `src/core/types.ts` before adding a new action type, since the backend scheduler executor must support it too.

### Testing Requirements
- No colocated tests currently. Cron parsing edge cases and action-type validation are good candidates for extraction + unit testing if added.

### Common Patterns
- List + modal + history-panel mirrors `Scripts/` (`ScriptEditModal` / `ScriptHistoryPanel`, driven from the Capabilities tab) — check that directory for a consistent implementation when changing shared UX (e.g. relative-time formatting, run-status badges).

## Dependencies
### Internal
- `src/core/types.ts` — `SchedulerEntry`, `SchedulerRun`, `CreateSchedulerInput`, `UpdateSchedulerInput`, `SchedulerActionType`.
- `web/src/hooks/useSchedulerApi.ts` — CRUD + `parseCron`.
- `web/src/hooks/useModalAccessibility.ts`, `usePersistedDialogSize.ts`, `uiAlert.ts` (`UiAlert` type).
- `shared/ErrorAlert.tsx`

### External
- `react`

<!-- MANUAL: -->
