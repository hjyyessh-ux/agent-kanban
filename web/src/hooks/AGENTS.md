<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# web/src/hooks/ — API Wrappers, Reducers, Polling

## OVERVIEW

All web-side data flow lives here: raw `/api` wrappers, reducer-based domain hooks, polling cadence, persisted UI preferences, and modal/dialog accessibility utilities. Components should consume these hooks instead of owning network logic.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Change card API contract | `useKanbanApi.ts` | Cards, dispatch, screenshots, models, questions |
| Change board reducer/polling/queue behavior | `useKanbanBoard.ts` | 3s polling, queue reorder, complete-all |
| Change shared list-CRUD state (entries/polling/errors) | `useCrudResource.ts` | Generic reducer behind the three hooks below |
| Change scheduler data flow | `useSchedulerApi.ts`, `useScheduler.ts` | Thin wrapper over `useCrudResource` + toggle/run |
| Change scripts data flow | `useScriptsApi.ts`, `useScripts.ts` | Thin wrapper over `useCrudResource` + run/sync |
| Change settings data flow | `useSettingsApi.ts`, `useSettings.ts` | Thin wrapper over `useCrudResource` |
| Change question overlay data flow | `useQuestionsApi.ts`, `useQuestions.ts` | 3s polling, reply/reject |
| Change skills data flow | `useSkillsApi.ts`, `useSkills.ts` | Discovery + sync; registers dynamic skill commands via `src/core/commands.ts` |
| Change skill-roots data flow | `useSkillRootsApi.ts`, `useSkillRoots.ts` | CRUD for scanned skill root directories |
| Change scope/capabilities inventory data flow | `useScopeInventory.ts` | MCP inventory, discovered skills, context diagnostics, cold-storage manifest |
| Change scope placement-target data flow | `useScopeTargets.ts` | CRUD for `PlacementTarget`s (where scoped configs get written) |
| Change runtime/model catalog data flow | `useRuntimes.ts`, `useModelCatalog.ts`, `useRuntimeDefaults.ts` | Runtime list, model catalog merge, per-runtime default permission/sandbox settings |
| Change wiki data flow | `useWikiApi.ts` | Wiki config, ingest, query, archive-eligible cards |
| Change modal focus trapping | `useModalAccessibility.ts` | Escape + tab loop |
| Change resizable-dialog persistence | `usePersistedDialogSize.ts` | Debounced size persistence per dialog |
| Change directory-picker history | `useDirectoryHistory.ts` | `localStorage`-backed recent-directories list |
| Change font-scale preference | `useFontScale.ts` | `localStorage` + cross-component custom event |
| Change generic polling helper | `usePolling.ts` | Shared interval wrapper |
| Change alert dialog plumbing | `uiAlert.ts` | Shared `UiAlert` shape + factory used by `App.tsx` |

## CONVENTIONS

- API wrappers own raw `fetch()` and `ApiError`/`handleResponse()` handling; most target `/api` via a local `BASE_URL` constant.
- Domain hooks own reducer state, optimistic updates, refresh logic, and user-facing error strings.
- Board/questions poll continuously; scheduler/scripts/settings poll only when their tab is active.
- Hooks import shared backend types directly from `src/core/types.ts` (and `src/core/runtime-config.ts`, `src/core/commands.ts` where relevant), plus question types from `src/plugin/question-monitor.ts`.
- `useKanbanBoard.ts` keeps queue/order logic in the hook, not in board components.
- `useModalAccessibility.ts` is the shared place for focus trap + escape-close behavior.
- Persisted UI preferences (font scale, directory history, dialog size) use `localStorage` directly inside the hook, wrapped defensively so a corrupt/missing value never throws.

## ANTI-PATTERNS

- Duplicating `ApiError`/`handleResponse()` logic inside components
- Hiding polling timers inside component trees
- Mixing domain reducers across board/scheduler/scripts/settings/capabilities instead of keeping one hook per domain
- Recreating question or modal accessibility logic ad hoc in components
- Reading/writing `localStorage` directly from a component instead of through the owning hook

## NOTES

- `useKanbanApi.ts` is broader than its name: it also exposes models, screenshots, and question endpoints used elsewhere in the app.
- Scheduler/scripts/settings hooks all share the same reducer + active-tab polling pattern; keep them consistent when extending one domain.
- `useScopeInventory.ts` and `useScopeTargets.ts` back the Capabilities tab's scope-manager UI (inventory browsing + placement-target registration); they are newer additions and don't yet follow the exact reducer pattern of scheduler/scripts/settings — check both before assuming one is canonical.
- `useRuntimes.ts` depends on `useModelCatalog.ts` (`mergeSyncedModels`) to reconcile the static `RUNTIME_CATALOG` with server-synced models — keep that merge one-directional (server data augments, never silently drops static entries).
