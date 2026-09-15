<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-09-14 -->

# components/Mention

## Purpose
The `@` mention reference UI: a drop-in `<textarea>` replacement that opens an anchored popover on `@`, drops a plain-text token into the body, and renders a References chip strip beneath. One component serves **both** call sites (New Task prompt, Feedback panel) — there is no per-screen variant.

Design note: `docs/mockups/mention-reference-mockup.html` (the look) and the 설계문서 §7 (behaviour). Styles live in `web/src/styles/kv2/mention.css`, tokens in `kanban-v2.tokens.css` (`--kv2-ref-*`).

## Key Files
| File | Description |
|------|-------------|
| `MentionTextarea.tsx` | The drop-in. Owns caret detection, open/close, keyboard, selection, and the chip strip. Everything else here is presentation. |
| `MentionPopover.tsx` | Tabs (All/Sessions/Works/Docs), grouped list, snippets, highlight. Also exports `buildMentionRows`, the single flattener that makes screen order and `↑↓` order the same list. |
| `MentionChips.tsx` | References strip: one chip per **token parsed from the body**, labels filled in from the resolved references, plus the sent-block preview. |
| `mentionCaret.ts` | Pure string surgery — `findActiveMention` / `replaceActiveMention` / `removeMentionToken` / `buildMentionToken`. No React. |
| `mentionCaret.test.ts` | The four stop conditions, caret placement, token encoding round-trip through the core parser. |

Hooks: `hooks/useMentionSearch.ts` (`GET /api/mentions`, 150ms debounce) and `hooks/useMentionReferences.ts` (body → `parseMentionTokens` → `GET /api/mentions/resolve`, 300ms debounce). API wrappers: `fetchMentions` / `resolveMentions` in `hooks/useKanbanApi.ts`.

## For AI Agents
### Invariants
- **The body text is the single source of truth.** There is no `references[]` state anywhere. Chips are a render of `parseMentionTokens(value)`, and a chip's `×` deletes the token *from the body*. Do not add a selected-references array "for convenience" — that is exactly the desync this design removes.
- **dispatch is untouched.** References become part of `card.description` when the *call site* runs `appendReferenceBlock` just before submit. Nothing in `src/plugin/` knows this feature exists; keep it that way.
- **Keyboard contract** (`MentionTextarea.handleKeyDown`): `↑↓`/`Tab`/`Enter` call `preventDefault` (otherwise the caret moves, focus escapes, or a newline lands); `Escape` additionally calls **`stopPropagation`**, because `DialogSkeleton`'s own `onKeyDown` would otherwise close the whole dialog. `Enter` with no selectable row deliberately falls through to a normal newline.
- **`onPaste` must be passed through.** Both call sites attach clipboard-image handlers to it; dropping the prop silently kills screenshot attachment.
- The popover is **not a modal** — no overlay, no backdrop, no `DialogSkeleton`. It is `useAnchoredPopover` + `MetaPopoverPortal`, anchored to the textarea's bottom-left. Caret-coordinate mirroring is v2 and deliberately not attempted here.

### Gotchas
- `useAnchoredPopover` is generic over the trigger element (`useAnchoredPopover<HTMLTextAreaElement>`); its `popoverStyle.minWidth` is the *trigger* width, which for a dialog-width textarea would stretch the popover — `MentionTextarea` takes only the coordinates and lets the stylesheet own the 520px.
- Open state is derived (`wantOpen`) and pushed into the hook one-directionally. When the hook closes itself on an outside click, `wantOpen` has not changed, so the effect does not re-run and the popover stays closed. Making that effect two-way reintroduces a reopen loop.
- `Escape` sets `dismissedStart` to the current mention's **start index**; the caret is still inside the mention, so without that the popover reopens on the very next render. It was keyed on `start:query` first, which meant one more keystroke changed the key and the popover came straight back — Esc means "this `@` is not a mention", not "not this query". Leaving the span (`findActiveMention` → `null`) clears it, so a new `@` typed at the same index still opens.

### Testing Requirements
- `bun test web/src/components/Mention/mentionCaret.test.ts` — pure logic.
- `bunx tsc --noEmit` after any prop change (both call sites are typed against `MentionTextareaProps`).
- `e2e/mention.e2e.ts` covers the whole path (`@` → popover → `↓↓⏎` → chip → Create → block in `description`).

## Dependencies
### Internal
- `src/core/mention-reference.ts` (token parsing, block render, `MAX_REFERENCES`) and `src/core/mention-search.ts` (candidate DTOs) — imported directly, as the rest of `web/` does for shared types.
- `components/Card/MetaDropdown` (`useAnchoredPopover`, `MetaPopoverPortal`), `components/Board/BoardCardSections` (`RuntimeBadge`), `components/Works/worksAffinity` (`dirAccentClass` — same colour = same project as the Works tab).

### External
- None beyond React.
