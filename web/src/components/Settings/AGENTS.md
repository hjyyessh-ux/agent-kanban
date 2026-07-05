<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Settings

## Purpose
Key/value settings entry management plus a self-update/maintenance panel that lets the user trigger and monitor the plugin's own install/restart scripts from the UI.

## Key Files
| File | Description |
|------|-------------|
| `SettingsView.tsx` | Tab container: lists `SettingsEntry` items, model-catalog sync (`useModelSync`, `readSyncedCatalog`) against `CLAUDE_MODELS`/`CODEX_MODELS` from `src/core/runtime-config.ts`, font-scale control (`useFontScale`), and mounts `SettingsEntryModal`/`SettingsMaintenancePanel`. |
| `SettingsEntryModal.tsx` | Create/edit form for a single `SettingsEntry` (key/value pair). |
| `SettingsMaintenancePanel.tsx` | Runs and polls status for `bash scripts/install.sh` / `bash scripts/restart-opencode-plugin.sh --yes` via `applyUpdateAndRestart`/`fetchMaintenanceStatus`/`fetchMaintenanceLog`, showing a running/success/failed state machine. |
| `Settings.css` | `.settings-*` styling, including maintenance status color states. |

## For AI Agents
### Working In This Directory
- `SettingsMaintenancePanel.tsx` triggers real shell commands on the host (install/restart scripts) — treat any change to `COMMANDS` or the trigger flow as high-risk; it is effectively a remote-execution button in the UI, gated only by the existing confirm/status UX. Do not add new arbitrary commands to `COMMANDS` without explicit instruction.
- Model catalog visibility (`isModelVisible`, `readEnabledSet` from `useModelCatalog`) is shared with `Card/CreateCardDialog.tsx` and `Card/CardDetailDialog.tsx` — changes to catalog filtering here affect model pickers everywhere.
- Font scale (`useFontScale`) is a global UI preference persisted outside this tab's own settings entries — don't conflate it with `SettingsEntry` CRUD.

### Testing Requirements
- No colocated tests currently. `SettingsMaintenancePanel`'s status-label/class mapping functions (`getStatusLabel`, `getStatusClass`) are simple pure functions worth unit testing if extended.

### Common Patterns
- Async mutation panels follow the fetch-status-then-poll pattern: kick off an action, then poll a status endpoint until `success`/`failed`, mirroring the polling model used elsewhere in the app (`usePolling`).

## Dependencies
### Internal
- `src/core/types.ts` — `SettingsEntry`, `CreateSettingsInput`, `UpdateSettingsInput`.
- `src/core/runtime-config.ts` — `CLAUDE_MODELS`, `CODEX_MODELS`, `RuntimeCatalogModel`.
- `web/src/hooks/useSettingsApi.ts`, `useKanbanApi.ts` (`fetchModels`), `useModelCatalog.ts`, `useFontScale.ts`, `uiAlert.ts`.
- `shared/ErrorAlert.tsx`

### External
- `react`

<!-- MANUAL: -->
