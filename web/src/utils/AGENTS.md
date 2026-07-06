<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# utils/

## Purpose
Small, pure, stateless helper functions shared across components — label formatting, duration formatting, stale-card visual state, and resume-command string building. No `fetch()`, no React state; these are the kind of logic that should never end up duplicated inline in a component.

## Key Files
| File | Description |
|------|-------------|
| `agent-label.ts` | `formatAgentTypeLabel(agentType)` normalizes an agent type via `normalizeAgentType()` and returns a display label, checking `AGENT_LABEL_OVERRIDES` first (for names like "Sisyphus-Junior" that don't title-case cleanly) then falling back to generic hyphen-aware title-casing. |
| `format-duration.ts` | `formatDuration(ms)` converts milliseconds into a compact human string (`"45s"`, `"1h 12m"`, `"12m 3s"`). Returns `''` for invalid/negative input. |
| `stale-visibility.ts` | `shouldShowStaleStatus(card)` and `staleCardVisualState(card)` decide whether/how a card's stale badge (`orphan` \| `stuck`) should render, based on `status === 'in_progress'` plus `staleStatus`/`staleDetectedAt` presence. |
| `resume-command.ts` | `buildResumeCommand(runtime, sessionId, projectDir)` builds the shell-quoted CLI command to resume a session for a given `AgentRuntime` (`codex resume`, `claude --resume`, or `opencode session`), prefixed with `cd <projectDir> &&` when a project directory is set. |
| `resume-command.test.ts` | Unit tests for `buildResumeCommand()` across runtimes and quoting edge cases. |
| `cardUpdate.ts` | `applyCardUpdates(card, updates)` merges an `UpdateCardInput` into a `KanbanCard` with the API's semantics: `undefined` keeps, `null` deletes the optional field, values replace. Used by `App.tsx`'s detail-dialog `onUpdate`. |
| `cardUpdate.test.ts` | Unit tests for the keep/delete/replace contract and non-mutation of the input card. |
| `stale-visibility.test.ts` | Unit tests for `shouldShowStaleStatus()`/`staleCardVisualState()`. |

## For AI Agents
### Working In This Directory
- These are consumed directly by board/card components (`BoardCard.tsx`, `CardDetailDialog.tsx`, `CardMetaPanel.tsx`, `board-selectors.ts`, `BoardCompleteSessionView.tsx`, `SessionConversationModal.tsx`) — keep function signatures narrow (accept `Pick<KanbanCard, ...>` rather than the full type) so callers don't need to construct full objects just to format a label.
- Functions here must stay pure and side-effect free. If new logic needs `fetch()`, polling, or component state, it belongs in `hooks/`, not here.
- `agent-label.ts` and `constants/agents.ts` both maintain agent-name override tables independently (label-only vs. full visual config) — when adding a new agent type, check whether it needs an entry in one, the other, or both.

### Testing Requirements
- Every non-trivial helper here should have a co-located `*.test.ts`. `resume-command.ts` and `stale-visibility.ts` already do; `agent-label.ts` and `format-duration.ts` currently do not — add tests if you change their branching logic.
- Run `bun test web/src/utils` (or the specific `*.test.ts` file) after edits.

### Common Patterns
- Defensive returns over throwing: invalid input yields `''`/`null`/`false` rather than an exception (see `formatDuration`'s `Number.isFinite` guard and `formatAgentTypeLabel`'s `null` on unrecognized type).
- Shell-argument safety: `resume-command.ts`'s `shellQuote()` is the canonical pattern for embedding arbitrary strings (session ids, paths) in a shell command string — reuse it rather than hand-rolling quoting elsewhere.

## Dependencies
### Internal
- `src/core/agent-type.ts` (`normalizeAgentType`)
- `src/core/types.ts` (`KanbanCard`, `AgentRuntime`)

### External
- None.

<!-- MANUAL: -->
