<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-06 -->

# styles/

## Purpose
All global and shared CSS for the SPA. Plain CSS only — no CSS-in-JS, CSS modules, or Tailwind. The **kv2 design system is the standard** (`kanban-v2.tokens.css` + the `kv2/` slices behind the `kanban-v2.components.css` barrel, all loaded globally from `main.tsx`). The legacy neobrutalism system (`tokens.css`/`components.css`, `.neo-*` classes) is being retired screen by screen — do not add new `.neo-*` usage.

**MUST READ before any UI work: [`docs/design-system.md`](../../../docs/design-system.md)** — primitives table, DialogSkeleton contract, new-screen checklist, forbidden patterns.

## Key Files
| File | Description |
|------|-------------|
| `reset.css` | Minimal CSS reset (box-sizing, margin/padding zero, text-size-adjust). |
| `tokens.css` | **Legacy** v1 neobrutalism `:root` tokens. Retirement target — do not extend. |
| `base.css` | Applies v1 tokens to `html`/`body`. Retirement target. |
| `components.css` | **Legacy** global `.neo-*` classes. Retirement target — no new usage. |
| `kanban-v2.tokens.css` | Global (`:root`) kv2 design tokens — every token carries the `--kv2-` prefix (status/agent colors, surfaces, typography, `--kv2-font-scale`-scaled text sizes). |
| `kanban-v2.components.css` | `@import` barrel over `kv2/*.css`. Import order preserves the cascade — **do not reorder**. |
| `kv2/board.css` | Board layout, columns, done-session groups, cards, card actions, container queries. |
| `kv2/primitives.css` | Dialog shell, form elements (`kv2-input/select/textarea`), buttons (`kv2-btn` + variants), dialog footer/actions. |
| `kv2/card-detail.css` | Detail/create dialog layouts, agent selector, radio group, badge, queue mode, children. |
| `kv2/panels.css` | Detail sidebar panels: session resume, meta, phases, run metadata/progress, question, feedback, screenshot, queue settings. |
| `kv2/conversation.css` | Session conversation modal speaker blocks. |

## For AI Agents
### Working In This Directory
- `main.tsx` imports, in order: `reset.css`, `tokens.css`, `base.css`, `components.css` (legacy), then `kanban-v2.tokens.css`, `kanban-v2.components.css` (kv2). kv2 loads **after** neo so it wins ties during the migration. Do not import kv2 files from components.
- New classes are always `.kv2-`-prefixed and belong in the matching `kv2/` slice. New primitive variants go in `kv2/primitives.css`.
- kv2 tokens are global `:root` custom properties; the `.kv2` marker class on some roots/portals is a legacy leftover slated for removal — do not rely on it for scoping.
- Component-local CSS files (e.g. `components/Wiki/Wiki.css`) live next to their component and must contain **layout only** — colors/typography/control looks come from tokens and primitives. Never override a `kv2-*` primitive from a local file.
- No Tailwind, CSS-in-JS, styled-components, or CSS modules anywhere in this project.

### Testing Requirements
- No automated tests target CSS directly, but `e2e/v2-visual-audit.e2e.ts` asserts key kv2 metrics (board gap, card radius, dialog width) and captures screenshots — run it plus `board.e2e.ts` after touching shared tokens or `kv2/` files.

### Common Patterns
- Tokens are plain CSS custom properties consumed via `var(--kv2-…)` — do not hardcode hex values if an equivalent token exists.
- Text sizes use the `--kv2-text-*` scale (multiplied by `--kv2-font-scale`, set via JS) — do not hardcode font-size px in component CSS.

## Dependencies
### Internal
- None — pure CSS, no imports from TS/TSX. Consumed globally via `main.tsx`; component-local CSS files assume these tokens are already loaded.

### External
- None.

<!-- MANUAL: -->
