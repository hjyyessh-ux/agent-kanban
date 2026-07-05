<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# Question

## Purpose
Global banner that surfaces pending agent questions (an agent session paused mid-run waiting for user input) across the whole app, independent of which card/tab is currently open. Distinct from `Card/QuestionPanel.tsx`, which renders a single question inline inside an already-open card detail dialog.

## Key Files
| File | Description |
|------|-------------|
| `QuestionBanner.tsx` | Renders one or more pending `QuestionRequest`s as a dismissible banner. Internally maps each request's `QuestionInfo` options to a `QuestionBlock` that tracks the user's per-question selections (checkbox/radio options plus optional custom free-text) before submitting via `onReply`, or discarding via `onReject`. |
| `Question.css` | `.question-*` styling for the banner and its option blocks. |

## For AI Agents
### Working In This Directory
- `QuestionBanner` is intentionally decoupled from card state — it receives `questions: QuestionRequest[]` and two callbacks (`onReply`, `onReject`) as props; the caller (likely `App.tsx`) is responsible for polling/fetching pending questions and wiring these callbacks to `useQuestionsApi`.
- Answers are collected as `string[][]` (one array of selected option values per question in the request) — match this shape exactly when wiring new option types.
- If a question's answer flow needs to change, check whether `Card/QuestionPanel.tsx` needs the equivalent change — the two components render the same underlying `QuestionRequest`/`QuestionInfo`/`QuestionOption` types from different contexts and should stay behaviorally consistent.

### Testing Requirements
- No colocated tests currently. If adding logic beyond simple selection state (e.g. validation before submit), extract it as a pure function so it can be unit tested independent of rendering.

### Common Patterns
- Per-question selection state is local component state inside `QuestionBlock`, lifted to the parent via `onSelectionsChange(questionIndex, newSelections)` — don't hoist this into global state unless multiple banners need to share it.

## Dependencies
### Internal
- `web/src/hooks/useQuestionsApi.ts` — `QuestionRequest`, `QuestionInfo`, `QuestionOption` types and the fetch/answer/reject API functions consumed by the parent that renders this banner.

### External
- `react`

<!-- MANUAL: -->
