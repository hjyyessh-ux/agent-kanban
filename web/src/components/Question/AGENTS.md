<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Question

## Purpose
Global banner that surfaces pending agent questions (an agent session paused mid-run waiting for user input) across the whole app, independent of which card/tab is currently open. Distinct from `Card/QuestionPanel.tsx`, which renders a single question inline inside an already-open card detail dialog.

## Key Files
| File | Description |
|------|-------------|
| `QuestionBanner.tsx` | Renders the first pending `QuestionRequest` as a modal (`role="dialog"`, `aria-modal`, `aria-labelledby` → the title). Internally maps each request's `QuestionInfo` options to a `QuestionBlock` that tracks the user's per-question selections (checkbox/radio options plus optional custom free-text) before submitting via `onReply`. **Escape, a backdrop click and the header `—` only minimize** it to a corner pill (`.question-reopen-pill`) that reopens it; `onReject` is reachable only through the explicit `Reject` button. Title is `<runtime label> needs your input` via the `runtimeLabel(sessionId)` prop. |
| `questionBannerModel.ts` | Pure helpers: `resolveQuestionEscape` (`'minimize' \| 'ignore'` — never reject), `hasOtherEscapeLayer` + `OTHER_ESCAPE_LAYER_SELECTOR` (other open dialogs/menus/popovers get Escape first), `questionRuntimeLabel` (card → `RUNTIME_CATALOG` label + opencode preset name from `agent-config`). |
| `QuestionBanner.test.tsx` | Escape decision table (no input combination rejects), layer detection, runtime labels, and SSR markup (dialog attributes, title, `onReject` never called on render). |
| `Question.css` | `.question-*` styling for the banner and its option blocks. |

## For AI Agents
### Working In This Directory
- `QuestionBanner` is intentionally decoupled from card state — it receives `questions: QuestionRequest[]` and two callbacks (`onReply`, `onReject`) as props; the caller (likely `App.tsx`) is responsible for polling/fetching pending questions and wiring these callbacks to `useQuestionsApi`.
- Answers are collected as `string[][]` (one array of selected option values per question in the request) — match this shape exactly when wiring new option types.
- If a question's answer flow needs to change, check whether `Card/QuestionPanel.tsx` needs the equivalent change — the two components render the same underlying `QuestionRequest`/`QuestionInfo`/`QuestionOption` types from different contexts and should stay behaviorally consistent.

- **Never wire Escape or the backdrop to `onReject`.** Rejecting discards the agent's question; a global Escape used to reject it while the user was only closing a filter popover. Keyboard dismissal is minimize-only.
- The Escape listener sits on `window` (bubble) so `document`/element handlers of other layers run first. It yields when `event.defaultPrevented` or when any element matching `OTHER_ESCAPE_LAYER_SELECTOR` outside the banner is still mounted. Add a new popover's class there if it closes on Escape without `preventDefault`. Do **not** add `role="listbox"` — Board columns are permanent listboxes.
- Runtime/agent labels come from `src/core/runtime-config.ts` (`RUNTIME_CATALOG`) and `src/core/agent-config.ts`; never hardcode `opencode` in the title.
- The banner keeps its own overlay (pre-DialogSkeleton legacy). Migrating it to `DialogSkeleton` would need `onClose` = minimize.

### Testing Requirements
- No DOM in `bun test`: behaviour lives in `questionBannerModel.ts` pure functions and markup is checked with `renderToStaticMarkup` (`QuestionBanner.test.tsx`).

### Common Patterns
- Per-question selection state is local component state inside `QuestionBlock`, lifted to the parent via `onSelectionsChange(questionIndex, newSelections)` — don't hoist this into global state unless multiple banners need to share it.

## Dependencies
### Internal
- `web/src/hooks/useQuestionsApi.ts` — `QuestionRequest`, `QuestionInfo`, `QuestionOption` types and the fetch/answer/reject API functions consumed by the parent that renders this banner.

### External
- `react`

<!-- MANUAL: -->
