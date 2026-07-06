<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Scripts

## Purpose
CRUD and execution UI for user-defined operational scripts (bash/other languages) that get synced into the backend `ScriptStore` on plugin boot. Also embedded inside `Capabilities/CapabilitiesView.tsx`'s `list` view mode, since scripts are treated as a `CapabilityItem` type alongside skills there.

## Key Files
| File | Description |
|------|-------------|
| `ScriptEditModal.tsx` | Create/edit form for a `ScriptEntry` — name, description, language, content, optional project directory. Rendered from `Capabilities/CapabilitiesView.tsx` (there is no standalone Scripts tab). |
| `ScriptHistoryPanel.tsx` | Modal showing a script's past `ScriptRun`s, fetched via `fetchScriptHistory`. Reused by `Capabilities/CapabilitiesView.tsx` as well. |
| `Scripts.css` | `.scripts-*` styling; also imported by `Capabilities.css`'s consumers since scripts render inside the Capabilities list view. |

## For AI Agents
### Working In This Directory
- `ScriptEditModal` and `ScriptHistoryPanel` are shared components — imported directly by `Capabilities/CapabilitiesView.tsx`. Any prop-shape change here must be checked against that call site too.
- Script execution is fire-and-forget from the UI's perspective: `onRunEntry`/`onRunScript` triggers a backend run, and the UI polls/refetches (`onRefreshEntries`/`onRefreshScripts`) to pick up the resulting `lastRunStatus`/`lastRunAt`/history.
- `language` field drives a `scripts-badge--${language}` CSS class — when adding a new supported language, add the corresponding badge style in `Scripts.css`.

### Testing Requirements
- No colocated tests currently. If adding validation (e.g. required fields, language-specific linting hints) extract as pure functions for unit testing.

### Common Patterns
- Same three-part list/modal/history-panel shape as `Scheduler/` — keep relative-time formatting and run-status badge conventions consistent between the two if changed.

## Dependencies
### Internal
- `src/core/types.ts` — `ScriptEntry`, `ScriptRun`, `CreateScriptInput`, `UpdateScriptInput`, `ScriptSyncResult`.
- `web/src/hooks/useScriptsApi.ts` — `fetchScriptHistory` and CRUD calls.
- `web/src/hooks/useModalAccessibility.ts`, `usePersistedDialogSize.ts`

### External
- `react`

<!-- MANUAL: -->
