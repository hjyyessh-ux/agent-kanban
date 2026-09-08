<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-06 -->

# styles/

## Purpose
All global and shared CSS for the SPA. Plain CSS only — no CSS-in-JS, CSS modules, or Tailwind. The **kv2 design system is the only system** (`kanban-v2.tokens.css` + the `kv2/` slices behind the `kanban-v2.components.css` barrel, all loaded globally from `main.tsx`). The legacy neobrutalism system was fully retired — do not reintroduce `.neo-*` classes or v1 tokens.

**MUST READ before any UI work: [`docs/design-system.md`](../../../docs/design-system.md)** — primitives table, DialogSkeleton contract, new-screen checklist, forbidden patterns.

## Key Files
| File | Description |
|------|-------------|
| `reset.css` | Minimal CSS reset (box-sizing, margin/padding zero, text-size-adjust). |
| `base.css` | Applies kv2 tokens to `html`/`body` (fonts, scrollbar, selection, focus ring); imports `reset.css`. |
| `kanban-v2.tokens.css` | Global (`:root`) kv2 design tokens — every token carries the `--kv2-` prefix (status/agent colors, surfaces, typography, `--kv2-font-scale`-scaled text sizes). |
| `kanban-v2.components.css` | `@import` barrel over `kv2/*.css`. Import order preserves the cascade — **do not reorder**. |
| `kv2/board.css` | Board workspace/Quick Actions side sheet, responsive/container-query columns, done-session groups, cards, and card actions. |
| `kv2/primitives.css` | Dialog shell and modal side-sheet variant, form elements (`kv2-input/select/textarea`), buttons (`kv2-btn` + variants), dialog footer/actions. |
| `kv2/card-detail.css` | Detail/create dialog layouts, agent selector, radio group, badge, queue mode, children. |
| `kv2/panels.css` | Detail sidebar panels: session resume, meta, phases, run metadata/progress, question, feedback, screenshot, queue settings. |
| `kv2/conversation.css` | Session conversation modal speaker blocks. |
| `tokenColor.ts` | **Test-only.** sRGB colour maths (luminance, contrast, `color-mix` as a lerp, hue) plus a reader that parses `kanban-v2.tokens.css` into light/dark token maps and evaluates a token's value through `var()` chains and `color-mix`. The one exception to this directory's "no TS" rule: the assertions it enables are about the tokens, so it belongs beside them. It restates **no** palette value — everything is read out of the stylesheet, so a token cannot drift away from its guard. |

## For AI Agents
### Working In This Directory
- `main.tsx` imports, in order: `base.css` (which imports `reset.css`), `kanban-v2.tokens.css`, `kanban-v2.components.css`. Do not import kv2 files from components.
- New classes are always `.kv2-`-prefixed and belong in the matching `kv2/` slice. New primitive variants go in `kv2/primitives.css`.
- kv2 tokens are global `:root` custom properties — no marker class is needed for scoping.
- Component-local CSS files (e.g. `components/Wiki/Wiki.css`) live next to their component and must contain **layout only** — colors/typography/control looks come from tokens and primitives. Never override a `kv2-*` primitive from a local file.
- No Tailwind, CSS-in-JS, styled-components, or CSS modules anywhere in this project.

### Testing Requirements
- `no-hardcoded-colors.test.ts` greps every `*.css` under `web/src` (except `kanban-v2.tokens.css`) for hex/rgba literals and fails on anything outside the allowlist documented in `docs/dark-mode-token-map.md` — keeps new colors routed through `--kv2-*` tokens instead of leaking past dark-mode.
- `token-contrast.test.ts` evaluates the Works affinity **text** tokens (`--kv2-dir-{1..8}-text`, `--kv2-affinity-chain-text`) out of the stylesheet and fails below WCAG AA (4.5:1) in either theme — against every panel surface *and* against the 14% accent tint `.works-dir-chip` paints under its own label. It also asserts the layer ① swatches are not restated in the dark block, that each `-text` token keeps its slot hue (mixing all the way to ink would pass a contrast check and destroy the palette), and that hue-adjacent slots differ in luminance. Retune a mix percentage or a swatch and this is what tells you whether it still reads. Layer ① swatches themselves are exempt: a 4px bar is not text.
- `e2e/v2-visual-audit.e2e.ts` asserts key kv2 metrics (board gap, card radius, dialog width) and captures screenshots (light + dark) — run it plus `board.e2e.ts` after touching shared tokens or `kv2/` files.

### Common Patterns
- Tokens are plain CSS custom properties consumed via `var(--kv2-…)` — do not hardcode hex values if an equivalent token exists.
- Text sizes use the `--kv2-text-*` scale (multiplied by `--kv2-font-scale`, set via JS) — do not hardcode font-size px in component CSS.

## Dependencies
### Internal
- None at runtime — pure CSS, no imports from TS/TSX. Consumed globally via `main.tsx`; component-local CSS files assume these tokens are already loaded. (`tokenColor.ts` is imported by tests only — here and by `components/Works/worksAffinity.test.ts` — and never by a component.)

### External
- None.

<!-- MANUAL: -->
