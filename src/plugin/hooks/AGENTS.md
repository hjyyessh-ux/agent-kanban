<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-03-25 | Updated: 2026-07-01 -->

# src/plugin/hooks/ — Message and Session Lifecycle Hooks

## OVERVIEW

Event-driven glue between opencode sessions and kanban cards. Handles card creation from `chat.message`, dispatch/session dedup, subagent parenting, slash-command tracking, and `session.idle` completion.

> **HIGH RISK**: `chat-message.ts` and `event-handler.ts` are two of the six fragile workflow files called out in root `CLAUDE.md` and `docs/invariants.md`. Read `docs/invariants.md` before changing card-hierarchy or completion-transition behavior here, and run `bun test src/__tests__/plugin-hooks.test.ts src/__tests__/telegram-poller.test.ts src/__tests__/feedback-session-reuse.test.ts src/__tests__/workflow-regression.test.ts` before the full suite. Any change to these two files must update docs/tests together per the invariants checklist.

## WHERE TO LOOK

| Task | Location | Notes |
|------|----------|-------|
| Change initial card creation from user prompts | `chat-message.ts` | Sanitization, dedup, parent linking |
| Change idle completion behavior | `event-handler.ts` | Session activity gating + result capture |
| Change slash-command metadata capture | `command-tracker.ts` | Consumed by `chat-message.ts` |
| Change dispatch dedup | `dispatch-tracker.ts` | `dispatchCard()` registers here before prompting |
| Change observed-session gating | `session-activity-registry.ts` | Prevents startup false positives |
| Change explicit subagent parent mapping | `subagent-parent-registry.ts` | Session-created child mapping |
| Change hook registration shape | `index.ts` | `'chat.message'`, `event`, `'command.execute.before'` |

## CONVENTIONS

- `chat-message.ts` sanitizes system markers before creating cards.
- `messageID` dedup is the first guard; dispatch-tracker dedup is the second guard.
- Prompts containing `WIKI_INTERNAL_MARKER` (from `wiki/wiki-prompts.ts`) are skipped — the wiki worker's one-shot codex/claude calls must never become cards (else they re-archive into the wiki queue, a feedback loop). Legacy marker cards minted before this guard are swept off the board at boot by `sweepWikiInternalCards` (`wiki/wiki-sweep.ts`), which soft-deletes them so they also stay out of archive + the wiki queue via the `isActiveCard` filter chain.
- Known subagents are whitelist-based; unknown agent types stay top-level until added intentionally.
- Subagent parent selection waterfalls through same-session and same-project candidates.
- Subagent titles use `AgentName#N` derived from sibling count.
- `event-handler.ts` ignores `session.idle` until real chat activity was observed.
- Idle completion updates matching completable `in_progress` cards in the same session: newest completable card is marked as the final completion target, older completable cards are marked as superseded, then dispatch/session-activity state is cleared afterward.
- Idle completion is blocked for top-level parent cards while any direct child card remains `in_progress`.
- Parent/child waiting semantics must stay aligned with `stale-checker.ts` so waiting parents are not shown as orphaned while a direct child is still `in_progress`.
- Idle completion may auto-dispatch the first queued `todo` card linked by `queuedAfterCardId`.
- Telegram completion messages and question history recording happen from the event path, not the UI.
- After a `session.idle` completion finishes (completion + queue dispatch + Telegram), `event-handler.ts` runs `captureGitEndAndUsage` (from `runtimes/git-capture.ts`) as a best-effort, last, never-throwing step. It must stay last so a git capture cannot delay completion/queue/Telegram. The opencode path has no `events.jsonl`, so only git is captured (usage is skipped).

## ANTI-PATTERNS

- Reintroducing unconditional `session.idle` completion
- Turning subagent detection into a broad deny-list or heuristic guess
- Creating cards from unsanitized system prompt text
- Moving dedup/dispatch state updates after prompt submission

## NOTES

- `chat-message.ts` is intentionally dense: most card-creation invariants live there and are enforced by `plugin-hooks.test.ts`.
- `event-handler.ts` also handles `session.created` to pre-register parent mappings for child sessions.

<!-- MANUAL: -->
