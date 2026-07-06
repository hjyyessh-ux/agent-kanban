<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Capabilities

## Purpose
Discovery, inventory, and lifecycle management for skills, MCP servers, and operational scripts across scopes (`user` / `local` / `project` / `cold`). This is the largest and most actively developed component directory: it implements a full "scope manager" — inventory browsing, visibility overrides (context-token control), copy/move between scopes, freeze-to-cold-storage/restore, secret detection warnings, and diff-preview-before-apply for every config mutation. Backed by `useScopeInventory`, `useScopeTargets`, and `useSkillsApi` hooks.

## Key Files
| File | Description |
|------|-------------|
| `CapabilitiesView.tsx` | Top-level tab container (root carries the `.kv2` class so Board design tokens resolve). Owns view-mode switch (`inventory` / `list` / `storage`, rendered as two-line labeled tabs: Inventory / Skills & Scripts / Cold Storage), skill/script search+filter state, sync orchestration (`onSyncSkills` + `onSyncScripts` in parallel), the runtime "Commands" enable/disable checklist, and mounts the remaining modals (roots, skill detail, new/import skill, script edit/history). Script *creation* UI was removed (edit/history still reachable from the list view). |
| `InventoryView.tsx` | Unified MCP + skill inventory list for the `inventory` view mode. Renders the inline `PlacementTargetsPanel` at the top, then per-item rows with a per-placement list (`.inv-placement-row`: `ScopeChip` + config path + dir + per-placement Freeze button), estimated context-token cost (`estSkillTokens`, and `preloadReason`-aware badge for MCP), alwaysLoad/secret/managed chips, and expandable `SkillVisibilityControl` panels per skill row. Skill runtime chips reuse `RuntimeBadge` from `Board/BoardCardSections`. Opens `SkillDetailModal`/`McpDetailModal` on row click. |
| `PlacementTargetsPanel.tsx` | Inline (always-visible) Placement Targets manager at the top of the inventory view — list + add/remove for `PlacementTarget`s (replaces the old header "Targets" button + `TargetRegistrationModal`). Auto-sets `teamShared` when kind is `project`. |
| `McpDetailModal.tsx` | Per-MCP-server detail dialog built on `Card/DialogSkeleton` (kv2-dialog): masked definition JSON preview (`maskSecretDef`), per-placement remove/freeze actions, and a Copy/Move-to-target workflow that previews a diff (`DiffPreview`) before applying, with a forced-apply path when a plaintext secret is detected. |
| `SkillDetailModal.tsx` | Per-skill detail dialog built on `Card/DialogSkeleton` (kv2-dialog): markdown preview (via `CardMarkdown`, stripping YAML frontmatter) or raw edit mode, duplicate-to-another-root, move-to-root-or-target, freeze-to-cold-storage, "Improve with Claude" (creates a board card with an improvement prompt), and "Port to Agent" (creates a board card to translate the skill to another runtime's format). |
| `SkillRootsModal.tsx` | CRUD for skill root directories (`SkillRoot`): add a directory + agent runtime, toggle enabled, remove. |
| `StorageDrawer.tsx` | Cold-storage browser (`storage` view mode). Lists frozen skills/MCPs (`ColdManifestEntry`) grouped by kind, with per-entry restore-to-target and permanent-delete actions. |
| `VisibilityControl.tsx` | Two exported controls: `SkillVisibilityControl` (skillOverrides: on/name-only/user-invocable-only/off + `disable-model-invocation`) and `McpAlwaysLoadControl` (toggle forced tool-schema preloading). Both preview a diff before the user applies. |
| `DiffPreview.tsx` | Generic before/after diff renderer (`computeDiffLines`) shared by every mutation flow (visibility, copy/move, alwaysLoad) — always shown before a config file write, with a git-tracked-file warning banner. |
| `DiagnosticsBar.tsx` | Context-budget health strip at the top of the inventory view: `ENABLE_TOOL_SEARCH` effective state, user-scope MCP count, alwaysLoad count, and estimated preload token cost. |
| `ScopeChip.tsx` | Small colored badge for a `CapScope` (`user`/`project`/`local`/`cold`), with optional ⚡ alwaysLoad / 🔒 managed icons. |
| `ImportSkillModal.tsx` | Drag-and-drop or file-picker import of an existing `SKILL.md`/`.txt` into a chosen skill root, deriving a slug name from the filename. |
| `NewSkillModal.tsx` | Create-from-scratch skill form (name, target root, description, markdown body) seeded with a `DEFAULT_INSTRUCTIONS` template. |
| `Capabilities.css` | All `.cap-*`, `.inv-*`, `.ptp-*`, `.scope-*`, `.diag-*`, `.cold-*`, `.mcp-detail-*`, `.vis-*`, `.diff-preview-*` styling for this directory — written on kv2 tokens/primitives (see `docs/design-system.md`). Modals render through `Card/DialogSkeleton`; buttons/inputs/badges are kv2 primitives. |

## For AI Agents
### Working In This Directory
- Every mutating action (visibility patch, copy, move, alwaysLoad toggle) follows a **preview-then-apply** pattern: call a `preview*` hook function to get a `VisibilityChange[]`, render it with `DiffPreview`, only call the corresponding `patch*`/apply function on explicit user confirmation. Don't skip the preview step when adding new mutation flows.
- Freeze/move on anything with `scope === 'project'` or `source.includes('project')` must show a `window.confirm` warning that it's a git-tracked file — follow the existing pattern in `SkillDetailModal.handleMove`/`handleFreeze` and `InventoryView.handleFreezeSkill`.
- Secret detection: when a copy/move preview returns `result.secretWarning`, hold the request in `secretPendingBody` and require an explicit "force" re-submit (`handleForceApply` in `McpDetailModal.tsx`) rather than silently proceeding.
- New scope-mutation API calls belong in `web/src/hooks/useScopeInventory.ts` (not inline `fetch`), matching `copyMcpServer`/`moveMcpServer`/`removeMcpServer`/`freezeMcpApi`/`freezeSkillApi`/`moveSkillApi`.
- All modals in this directory use the resizable-dialog pattern (`usePersistedDialogSize` with a unique `cap-*-size` localStorage key) plus the overlay-mousedown-vs-click dismiss guard.

### Testing Requirements
- No colocated `.test.tsx` files currently exist in this directory; new logic worth unit testing (diff computation, secret masking, name sanitization) should be extracted into a plain function and tested the way `Board/board-selectors.test.ts` tests its selectors.
- Manually verify against a real `~/.claude.json` / project `.mcp.json` when touching copy/move/freeze — these mutate real config files (guarded behind "new session required" messaging).

### Common Patterns
- Token-cost estimation everywhere uses the `chars/4` heuristic (see `estSkillTokens` in `InventoryView.tsx` and the diagnostics bar).
- `timeAgo(dateStr)` (relative time formatting) is duplicated locally in `CapabilitiesView.tsx` and `StorageDrawer.tsx` — if adding a third copy, consider hoisting to `web/src/utils/`.
- Board-card-creation side effects ("Improve with Claude", "Port to Agent") build a description string and call `createSkillCard` from `useSkillsApi` rather than performing the file edit client-side.

## Dependencies
### Internal
- `src/core/types.ts` — `DiscoveredSkill`, `SkillRoot`, `SkillRuntime`, `SkillVisibility`, `McpInventoryItem`, `McpPlacement`, `PlacementTarget`, `CapScope`, `ContextDiagnostics`, `ScriptEntry`, etc.
- `web/src/hooks/useScopeInventory.ts`, `useScopeTargets.ts`, `useSkillsApi.ts`, `usePolling.ts`, `usePersistedDialogSize.ts`
- `Card/CardMarkdown.tsx`, `Card/DirectoryPicker.tsx` (reused inside skill detail / target registration)
- `Scripts/ScriptEditModal.tsx`, `Scripts/ScriptHistoryPanel.tsx` (rendered from the `list` view mode)
- `web/src/constants/commands.ts`

### External
- `react`

<!-- MANUAL: -->
