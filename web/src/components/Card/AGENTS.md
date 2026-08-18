<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Card

## Purpose
Card detail and card creation dialogs, plus every sub-panel they compose: runtime/model/permission metadata, prompt/progress/result markdown phases, queue-chaining settings, session resume picker, screenshot attachments, feedback submission, and inline question answering. `CardDetailDialog` and `CreateCardDialog` are the two largest, most frequently touched files in the whole web app.

## Key Files
| File | Description |
|------|-------------|
| `CardDetailDialog.tsx` | Full detail/edit view for an existing card: inline field editing, runtime metadata, Script execution provenance/status, screenshots, queue settings, session resume, and question/feedback panels. Largest file in the component tree. |
| `CardDetailDialog.test.tsx` | Tests for the detail dialog. |
| `CreateCardDialog.tsx` | New-card form: runtime/model/permission selection, directory picker, command picker, queue-session-mode setup, resume-session picker. Mirrors much of `CardDetailDialog`'s field logic for the not-yet-created case. |
| `CardMetaPanel.tsx` | Shared metadata editing panel (runtime, model, Claude permission mode, Codex reasoning effort/sandbox) used by the detail dialog; exports the `EditingField` type and `CommandMetaRow` used across Card components. |
| `CardPhases.tsx` | Renders a card's Prompt / Progress / Result / Meta sections as collapsible "phase" cards with markdown rendering (`CardMarkdown`) and inline edit support wired through `CardMetaPanel`'s `EditingField`. The Progress phase renders the run's intermediate-step timeline (`ProgressSteps`, fed by `useCardProgress` → `GET /api/cards/:id/progress`, live-polled every 3s while in_progress). Collapsed mode shows 3 steps (the most recent 3 while live); expanded mode shows summary chips (skills/agents/MCP/memory) and every full, untruncated step. Steps with a `body` (Edit old/new diff, full Bash command, Write content, Task prompt) expand inline on click. The Meta phase shows usage chips for Branches/Skills/Agents/MCP/Tools/Commands. |
| `CommandPicker.tsx` | Runtime-aware slash-command dropdown (`CommandOption[]` filtered by `AgentRuntime`), used in both create and meta-edit contexts (`variant: "create" | "meta"`). |
| `CardMarkdown.tsx` | Thin `react-markdown` wrapper (with `remark-gfm`/`remark-breaks`) applying `.kv2-markdown-*` classes; the single markdown renderer reused by Card, Board, Wiki, and Capabilities. |
| `DialogSkeleton.tsx` | Shared modal chrome (header/title/close button, resizable via `usePersistedDialogSize`, accessibility via `useModalAccessibility`) that every dialog in `Card/`, `Scheduler/`, `Settings/` wraps its content in. |
| `DirectoryPicker.tsx` | Project-directory text input with autocomplete history (`useDirectoryHistory`) and a derived short display name. |
| `FeedbackPanel.tsx` | Textarea + pasted/attached screenshots for submitting follow-up feedback on a card (used inline in the detail dialog and inside `Board/SessionConversationModal`). |
| `MetaDropdown.tsx` | Generic body-portal popover anchored to a trigger button via fixed positioning — the low-level primitive several meta dropdowns are built on. |
| `QuestionPanel.tsx` | Renders a single pending `QuestionRequest` inline in the card detail view with answer/reject actions. |
| `QueueSettingsPanel.tsx` / `.test.tsx` | Queue-chaining configuration: session mode picker and the shared `QueueTargetList` (also used by `CreateCardDialog`) for picking which card to chain after. |
| `ScreenshotPanel.tsx` | Drag-and-drop / paste screenshot upload, thumbnail grid, and lightbox preview for a card's attachments. |
| `SessionPickerPanel.tsx` / `.test.tsx` | Resume-existing-session picker; supports both "editing an existing card" and "picking a resume session while creating a new card" modes via a discriminated prop union. |

## For AI Agents
### Working In This Directory
- `CardDetailDialog.tsx` and `CreateCardDialog.tsx` are **fragile/high-risk per the root `AGENTS.md`/`CLAUDE.md`** only insofar as they touch dispatch/queue flows — cross-check `docs/invariants.md` before changing queue-session or dispatch-triggering code paths here.
- Runtime-conditional fields (Claude permission mode vs. Codex reasoning effort/sandbox) are typed via `AgentRuntime`-discriminated props — extend `CardMetaPanel.tsx`'s existing branches rather than adding new ad hoc conditionals in the dialogs.
- Default model/permission/sandbox constants come from `src/core/runtime-config.ts` (`DEFAULT_CLAUDE_MODEL`, `DEFAULT_CODEX_MODEL`, `DEFAULT_CODEX_REASONING_EFFORT`, `DEFAULT_CODEX_SANDBOX`) — never hardcode these values locally.
- `CardPhases.tsx` strips/handles markdown rendering per phase; when adding a new phase type, follow the existing `tone: 'prompt' | 'progress' | 'result' | 'meta'` pattern.

### Testing Requirements
- Colocated `bun:test` files: `CardDetailDialog.test.tsx`, `QueueSettingsPanel.test.tsx`, `SessionPickerPanel.test.tsx`. Run via `bun test web/src/components/Card/<File>.test.tsx`.
- Prefer extracting pure logic (validation, config-building) into standalone functions that can be tested without rendering the full dialog, matching the existing test files' style.

### Common Patterns
- All fetch/mutation calls go through `web/src/hooks/*` (`useKanbanApi`, `useQuestionsApi`, `useRuntimes`, `useRuntimeDefaults`, `useModelCatalog`) — components never call `fetch` directly.
- Modals compose `DialogSkeleton` for chrome rather than reimplementing overlay/close/resize logic.
- Command/runtime label formatting is centralized in `web/src/constants/commands.ts` and `web/src/constants/agents.ts` (`formatCommandName`, `getCommandHint`, `getAgentConfig`) — don't inline label strings.

## Dependencies
### Internal
- `src/core/types.ts` — `KanbanCard`, `UpdateCardInput`, `CreateCardInput`, `AgentRuntime`, `ClaudePermissionMode`, `CodexReasoningEffort`, `CodexSandboxMode`, `QueueSessionMode`, `Screenshot`.
- `src/core/runtime-config.ts` — default model/effort/sandbox constants and `RuntimeCatalogEntry`.
- `web/src/hooks/*` — `useKanbanApi`, `useQuestionsApi`, `useRuntimes`, `useRuntimeDefaults`, `useModelCatalog`, `useDirectoryHistory`, `useModalAccessibility`, `usePersistedDialogSize`.
- `web/src/constants/agents.ts`, `web/src/constants/commands.ts`
- `Board/BoardCardSections.tsx` — `RuntimeBadge`/`RuntimeBadgeIcon` reused in meta panel and session picker.
- `shared/ErrorAlert.tsx`

### External
- `react`, `react-dom` (portals in `MetaDropdown`)
- `react-markdown`, `remark-gfm`, `remark-breaks`

<!-- MANUAL: -->
