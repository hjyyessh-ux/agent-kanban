<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# styles/

## Purpose
All global and shared CSS for the SPA. Plain CSS only — no CSS-in-JS, CSS modules, or Tailwind. Two design-token generations coexist: a global neobrutalism system (`tokens.css`/`components.css`, imported once in `main.tsx`) and a newer, scoped `.kv2-*` board redesign (`kanban-v2.*.css`, imported only by `BoardScreen.tsx`).

## Key Files
| File | Description |
|------|-------------|
| `reset.css` | Minimal CSS reset (box-sizing, margin/padding zero, text-size-adjust). Imported by `base.css`. |
| `tokens.css` | Root-level `:root` design tokens for the neobrutalism system — colors, border width, shadow, radius. |
| `base.css` | Applies tokens to `html`/`body` and other root primitives; `@import`s `tokens.css` and `reset.css`. |
| `components.css` | Global `.neo-*` utility component classes (`.neo-card`, `.neo-button`, etc.) built on the tokens above. |
| `kanban-v2.tokens.css` | Design tokens for the v2 board redesign, scoped under a `.kv2` class (status colors, frame/background) to avoid colliding with the v1 tokens above. Sourced from a Penpot spec. |
| `kanban-v2.components.css` | Large (~6900 line) stylesheet of `.kv2-*` prefixed component classes (board layout, columns, cards, etc.) for the v2 board. Hot path — imported directly by `BoardScreen.tsx`, not `main.tsx`. |

## For AI Agents
### Working In This Directory
- `main.tsx` imports `reset.css`, `tokens.css`, `base.css`, `components.css` once, globally, in that order — this is the v1 neobrutalism baseline used app-wide (`.neo-*` classes).
- `kanban-v2.tokens.css` and `kanban-v2.components.css` are imported only from `web/src/components/Board/BoardScreen.tsx`, not globally. Do not move these imports to `main.tsx` — they are intentionally scoped to the board screen under the `.kv2` root class.
- When editing `kanban-v2.components.css`, always prefix new classes `.kv2-` and keep selectors scoped under `.kv2` to avoid leaking into v1 (`.neo-*`) styling. This file is large; use targeted search (`grep`) rather than reading it in full.
- Component-local CSS files (e.g. `components/Settings/Settings.css`, `components/Wiki/Wiki.css`, `components/Capabilities/Capabilities.css`) live next to their component, not here — this directory is for cross-cutting/global styles only.
- No Tailwind, CSS-in-JS, styled-components, or CSS modules anywhere in this project.

### Testing Requirements
- No automated tests target CSS directly. Visual changes to shared tokens (`tokens.css`, `kanban-v2.tokens.css`) can affect every consumer — check both the v1 board and v2 board screens after edits, and prefer the `run`/`verify` skill for a manual visual check over assuming correctness.

### Common Patterns
- Tokens are plain CSS custom properties (`--color-*`, `--kv2-*`) consumed via `var(...)` — do not hardcode hex values in component CSS if an equivalent token already exists.
- v1 and v2 systems intentionally do not share tokens or class prefixes; do not "unify" them without an explicit request — the v2 system is a scoped, in-progress redesign layered on top of v1.

## Dependencies
### Internal
- None — pure CSS, no imports from TS/TSX. Consumed by `main.tsx` (v1) and `components/Board/BoardScreen.tsx` (v2), plus component-local CSS files that assume these tokens are already loaded.

### External
- None.

<!-- MANUAL: -->
