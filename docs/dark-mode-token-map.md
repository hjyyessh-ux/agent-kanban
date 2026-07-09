# Dark-mode token map (migration contract)

> **This is the contract that cards 2–4 follow to replace hard-coded colours
> in the kv2 CSS with semantic tokens.** It maps every audited `#hex` / `rgba()`
> literal to the token it should become. Read this together with the layer
> banner in `web/src/styles/kanban-v2.tokens.css`.

The goal of this migration is **not** to change how anything looks in light mode.
It is to route every colour through a token so that a later `[data-theme="dark"]`
block (card 5) can repaint the UI by overriding **layer ②** only. Until card 5
ships, the screen must stay **pixel-identical**.

---

## The three token layers

| Layer | Group | Overridden by dark theme? |
|-------|-------|---------------------------|
| ① **Brand — invariant** | status ×4, agent ×11, runtime brand | **No.** Never override, never remap a literal to a different-value brand token. |
| ② **Semantic — theme-variable** | surface / text / border / neutral ramp / interactive / shadow / status-soft / inverse | **Yes.** This is the only band card 5 touches. |
| ③ **Structural — theme-agnostic** | typography, scale, spacing, radius, geometry, transitions | N/A (no colour). |

Cards 2–4 only **reference** tokens; they do not add `[data-theme]` blocks.

---

## Cardinal rules

### Rule A — value-exact substitution
Replace a literal with a token **only if the token's light value equals that
literal.** Never map a literal onto a token of a different value — that would
regress light mode. If a literal has no value-exact home:

1. Pick the layer-② group it belongs to (surface / text / border / status-soft / …).
2. Add a token there with the **exact** light value, named per the group's convention.
3. Append a row to the relevant table below, in the same commit.

This is what "매핑표에 없는 값을 만나면 토큰/표를 보완한다" means in practice.

### Rule B — role over value
The same literal plays different roles and therefore maps to **different tokens**,
because those roles diverge in dark mode even though they share a light value.
`#ffffff` is the clearest case:

| `#ffffff` used as… | token |
|--------------------|-------|
| card / dialog / panel background | `--kv2-surface` |
| card fill specifically | `--kv2-card-bg` |
| form control background | `--kv2-input-bg` |
| text/icon on an accent or dark fill | `--kv2-text-inverse` |
| count badge / chip background | `--kv2-surface` |

Always pick by **role**, not by the raw value.

### Rule C — alpha colours → `color-mix`
`rgba(r, g, b, a)` is exactly `color-mix(in srgb, rgb(r,g,b) (a×100)%, transparent)`.
So every translucent literal becomes:

```css
color-mix(in srgb, var(--kv2-BASE) N%, transparent)
```

where `--kv2-BASE`'s light value is `rgb(r,g,b)` and `N = a×100`. This is
value-exact **and** gives dark mode a single knob (the base token) per family.

Three recurring alphas get a **dedicated token** instead (they are structural and
appear everywhere):

| literal | token |
|---------|-------|
| `rgba(31, 34, 51, 0.85)` | `--kv2-shadow-color` (already composed into `--kv2-shadow-sm/md/lg`) |
| `rgba(17, 24, 39, 0.18)` | `--kv2-shadow-color-ambient` |
| `rgba(0, 0, 0, 0.5)` (dialog backdrop) | `--kv2-scrim` |

Everything else translucent uses the `color-mix` form.

### Rule D — leave layer ① and the allowlist alone
Status, agent, runtime-brand, data-viz and syntax colours are **not** part of the
theme surface. Do not tokenise them into semantic tokens (see Allowlist).

---

## Universal neutrals

### Inks / dark structural
| literal | role → token |
|---------|--------------|
| `#1A1A2E` | text → `--kv2-text-primary`; frame/app ink → `--kv2-frame` (both `#1A1A2E`) |
| `#1f2233` | border/stroke or heavy glyph → `--kv2-border-strong`; button stroke → `--kv2-btn-stroke-color`; drop-shadow ink → `--kv2-shadow-color` (via Rule C) |
| `#000000` / `#000` | card stroke → `--kv2-card-border-color`; pill stroke → `--kv2-pill-stroke-color` |
| `#090a0c` | ink inside inverse chrome → `--kv2-ink-black` |

### Whites / warm off-whites
| literal | role → token |
|---------|--------------|
| `#ffffff` `#fff` `#FFFFFF` | by role — see Rule B table |
| `#FFF8E7` | app background → `--kv2-app-bg` (alias `--kv2-bg`) |
| `#fffdf5` `#fffdf7` `#fffdfa` `#fff6e1` `#fffbeb` | near-white surface → `--kv2-surface`. Keep the warm tint only if it is load-bearing; then add `--kv2-surface-warm` per Rule A. |

### Neutral (slate) ramp — layer ②
Value-exact homes for the ad-hoc cool-grey scale. Dark mode remaps the ramp wholesale.

| literal | token |
|---------|-------|
| `#0f172a` | `--kv2-neutral-900` |
| `#334155` | `--kv2-neutral-700` |
| `#475569` | `--kv2-neutral-600` |
| `#64748b` | `--kv2-neutral-500` |
| `#94a3b8` | `--kv2-neutral-400` |
| `#cbd5e1` | `--kv2-border-muted` |
| `#e2e8f0` | `--kv2-border-subtle` |
| `#f1f5f9` | code fill → `--kv2-code-bg`; recessed surface → `--kv2-surface-sunken` |
| `#f8fafc` | `--kv2-surface-sunken` |
| `#f3f4f6` | `--kv2-surface-hover` |
| `#f9fafb` | light surface → `--kv2-surface-sunken`; text on inverse → `--kv2-text-on-inverse` |

Bespoke neutrals already tokenised: `#536074 → --kv2-text-secondary`,
`#8190a8 → --kv2-text-muted`, `#D7DCE6 → --kv2-border`,
`#46505e → --kv2-card-date-color` (alias `--kv2-card-id-color`),
`#bcc6d7 → --kv2-divider-color`.

Warm/Tailwind greys not on the ramp (`#6b7280` `#9ca3af` `#4b5563` `#374151`
`#1f2937` `#d1d5db` `#e5e7eb` `#5a5f72` `#8a8fa3` `#2e3a47` `#293241` `#3b5066`)
→ map to the nearest ramp step **only if value-exact**; otherwise add the exact
step (`--kv2-neutral-*`) per Rule A. Note `#9ca3af` = `--kv2-text-on-inverse-muted`.

---

## Interactive / surfaces / overlay

| literal | token |
|---------|-------|
| `#e0e7ff` | selected/pressed subtle fill → `--kv2-surface-active` |
| `rgba(0, 0, 0, 0.5)` | dialog backdrop → `--kv2-scrim` |
| `#2563eb` | focus outline → `--kv2-focus-ring`; link/hover text → `--kv2-text-link`; info accent → `--kv2-info-accent` (all `#2563eb`, pick by role) |

---

## Status-soft families (layer ②)

Each family: `surface` (pale fill) · `surface-strong` (deeper fill) · `border`
(pastel stroke) · `text` (readable ink) · `accent` (saturated). Map by the tint's
**shade**, value-exact. Deeper text shades not listed get their own `-text-strong`
token per Rule A.

### Info (blue)
| literal | token |
|---------|-------|
| `#eff6ff` | `--kv2-info-surface` |
| `#dbeafe` | `--kv2-info-surface-strong` |
| `#93c5fd` | `--kv2-info-border` |
| `#1d4ed8` | `--kv2-info-text` |
| `#2563eb` | `--kv2-info-accent` |
| `#3b82f6` | status accent → `--kv2-status-todo-accent` (brand, value-exact) |
| `#1668e8` | prompt accent → `--kv2-prompt-accent-color`; primary CTA fill → `--kv2-btn-primary-bg` |
| `#0d5fd9` | `--kv2-btn-start-bg` |
| `#bfdbfe` `#c7d2fe` `#e0e7ff` `#eef2ff` `#1e3a8a` `#1e40af` `#1d4ed8` | add `--kv2-info-*` step per Rule A where not above |

### Cyan / sky
| `#0ea5e9` → `--kv2-cyan-accent` · `#e0f2fe` → `--kv2-cyan-surface` · `#bae6fd` → `--kv2-cyan-border` · `#0369a1` → `--kv2-cyan-text` |
| deeper/paler (`#0c4a6e` `#0e7490` `#f0f9ff` `#f0fdff` `#bae6fd`) → `--kv2-cyan-*` step per Rule A |

### Success (green)
| literal | token |
|---------|-------|
| `#f0fdf4` | `--kv2-success-surface` |
| `#dcfce7` | `--kv2-success-surface-strong` |
| `#86efac` | `--kv2-success-border` |
| `#166534` | `--kv2-success-text` |
| `#16a34a` | `--kv2-success-accent` |
| `#22c55e` | done status → `--kv2-status-done-accent` (brand) |
| `#15803d` `#14532d` `#06280f` `#bbf7d0` `#f0fff4` | `--kv2-success-*` step per Rule A |

### Warn (amber)
| literal | token |
|---------|-------|
| `#fef3c7` | `--kv2-warn-surface` |
| `#fde68a` | `--kv2-warn-surface-strong` |
| `#fcd34d` | `--kv2-warn-border` |
| `#b45309` | `--kv2-warn-text` |
| `#d97706` | `--kv2-warn-accent` |
| `#facc15` | in-progress status → `--kv2-status-in-progress-accent` (brand) |
| `#f0b800` | queue button → `--kv2-btn-queue-bg` |
| `#92400e` `#9a3412` `#b45309` `#fbbf24` `#fdba74` `#fff7ed` `#ffedd5` `#fffbeb` | `--kv2-warn-*` step per Rule A |

### Danger (red)
| literal | token |
|---------|-------|
| `#fef2f2` | `--kv2-danger-surface` |
| `#fee2e2` | `--kv2-danger-surface-strong` |
| `#fca5a5` | `--kv2-danger-border` |
| `#b91c1c` | `--kv2-danger-text` |
| `#dc2626` | `--kv2-danger-accent` |
| `#ff4d6d` | danger text/icon → `--kv2-text-danger`; delete button fg → `--kv2-btn-delete-fg` |
| `#ff3b6b` | complete status → `--kv2-status-complete-accent` (brand) |
| `#991b1b` `#7f1d1d` `#e11d48` `#ef4444` `#fca5a5` | `--kv2-danger-*` step per Rule A |

Pink accents (`#be185d` `#9d174d` `#f9c2d6` `#fdf2f8` `#fbcfe8` `#fff0f3`
`#fff4f6` `#ffe4e6` `#fff1f2` `#fff0f0` `#cc1a47`) → add `--kv2-danger-*` /
`--kv2-pink-*` steps per Rule A.

### Purple
| literal | token |
|---------|-------|
| `#f5f3ff` | `--kv2-purple-surface` |
| `#f3e8ff` | `--kv2-purple-surface-strong` |
| `#c4b5fd` | `--kv2-purple-border` |
| `#4c1d95` | `--kv2-purple-text` |
| `#7c3aed` | `--kv2-purple-accent` |
| `#9b59b6` | librarian agent → `--kv2-agent-librarian` (brand) |
| `#6366f1` | explore agent → `--kv2-agent-explore` (brand) |
| `#ddd6fe` `#d8b4fe` `#7d459e` | `--kv2-purple-*` step per Rule A |

---

## Inverse chrome (intentionally dark in light mode)

The filter popover, log console and opencode panel are dark by design. Their
tokens live in layer ② so card 5 can re-tune contrast, but their light values
are already dark.

| literal | token |
|---------|-------|
| `#22272b` | `--kv2-surface-inverse` |
| `#1a1d21` | `--kv2-surface-inverse-sunken` |
| `#384148` | `--kv2-surface-inverse-border` |
| `#f9fafb` (on dark) | `--kv2-text-on-inverse` |
| `#9ca3af` (on dark) | `--kv2-text-on-inverse-muted` |
| `#1e1e1e` | log console fill → `--kv2-console-bg` |
| `#262c31` `#2c3338` `#1f2428` `#d1d5db` `#4b5563` `#3f2f00` | add `--kv2-surface-inverse-*` / on-inverse step per Rule A |

---

## Shadows

| literal | token |
|---------|-------|
| `rgba(31, 34, 51, 0.85)` | `--kv2-shadow-color` (use `--kv2-shadow-sm/md/lg` where the whole shadow matches) |
| `rgba(17, 24, 39, 0.18)` | `--kv2-shadow-color-ambient` |
| `rgba(17, 24, 39, α)` other α | `color-mix(in srgb, var(--kv2-shadow-color-ambient) K%, transparent)` — or add `--kv2-shadow-color-ambient-*` per Rule A. |
| `rgba(0, 0, 0, α)` | pre-existing pure-black shadow; normalise to `--kv2-shadow-color` in **card 5**. Cards 2–4 leave as-is (light no-regression). |

---

## Resolved in card 2 (primitives.css / board.css / conversation.css / App.css)

Card 2 was the first real application of this map. Every literal in those four
files now resolves to a token; the tables above used "add `--kv2-*` step per
Rule A" placeholders for several of them — here is what they actually became,
so cards 3–4 reuse rather than re-derive:

| literal | token | value |
|---------|-------|-------|
| `#000000` (generic neo stroke on buttons/badges/pills, not the card/pill-specific tokens) | `--kv2-ink-pure` | `#000000` |
| `#111827` (opaque base for `rgba(17, 24, 39, α)` family) | `--kv2-ink-ambient` | `#111827` |
| `#fbfcfe` (list-row gradient stop) | `--kv2-surface-tint` | `#fbfcfe` |
| `#f5f8fc` (list-row hover gradient stop) | `--kv2-surface-tint-hover` | `#f5f8fc` |
| `#fafbff` (session timeline strip bg) | `--kv2-surface-tint-cool` | `#fafbff` |
| `#fffdfa` (create-column button bg) | `--kv2-surface-warm` | `#fffdfa` |
| `#2c3338` / `#262c31` (dark filter-card gradient) | `--kv2-surface-inverse-card-from` / `-to` | as listed |
| `#1f2428` (dark filter-empty bg) | `--kv2-surface-inverse-deep` | `#1f2428` |
| `#4b5563` (dashed border / scrollbar-thumb on inverse) | `--kv2-border-inverse` | `#4b5563` |
| `#f3f4f6` (input text on inverse bg) | `--kv2-text-on-inverse-soft` | `#f3f4f6` |
| `#d1d5db` (filter-option text on inverse) | `--kv2-text-on-inverse-secondary` | `#d1d5db` |
| `#d3d9e4` (`.kv2-empty` border) | `--kv2-border-soft` | `#d3d9e4` |
| `#1f2937` (session-card-id text) | `--kv2-neutral-800` | `#1f2937` |
| `#2e3a47` (card body copy ink) | `--kv2-neutral-ink-soft` | `#2e3a47` |
| `#293241` (directory/session-command name ink) | `--kv2-neutral-ink-strong` | `#293241` |
| `#999` (dialog-footer-session text) | `--kv2-neutral-450` | `#999999` |
| `#bfdbfe` (codex badge gradient mid-stop) | `--kv2-info-border-soft` | `#bfdbfe` |
| `#1e3a8a` (codex badge text) | `--kv2-info-text-strong` | `#1e3a8a` |
| `#f0fdff` (session "result" row bg) | `--kv2-cyan-surface-soft` | `#f0fdff` |
| `#14532d` (session "result" row text) | `--kv2-success-text-strong` | `#14532d` |
| `#d9f99d` (board-session-toggle active bg) | `--kv2-success-surface-vivid` | `#d9f99d` |
| `#fff8f0` (session "prompt" row bg) | `--kv2-warn-surface-soft` | `#fff8f0` |
| `#f8f1d4` (filter-trigger open-state bg) | `--kv2-warn-surface-tint` | `#f8f1d4` |
| `#3f2f00` (text on selected/yellow filter option) | `--kv2-warn-text-strong` | `#3f2f00` |
| `#92400e` (wip--warning text) | `--kv2-warn-text-deep` | `#92400e` |
| `#991b1b` (wip--over text) | `--kv2-danger-text-strong` | `#991b1b` |
| `#7f1d1d` (alert title / dismiss text) | `--kv2-danger-text-deep` | `#7f1d1d` |
| `#3f1d27` (alert message text) | `--kv2-danger-text-deepest` | `#3f1d27` |
| `#e11d48` (subtle-danger button text) | `--kv2-danger-accent-strong` | `#e11d48` |
| `#ff0000` (card-icon-action--danger) | `--kv2-danger-accent-vivid` | `#ff0000` |
| `#fff4f6` / `#ffe4e6` (ErrorAlert gradient) | `--kv2-pink-surface` / `--kv2-pink-surface-strong` | as listed |
| `#f9c2d6` (session-unread badge bg) | `--kv2-pink-surface-deep` | `#f9c2d6` |
| `#be185d` (session-unread badge border/shadow) | `--kv2-pink-accent` | `#be185d` |
| `#9d174d` (session-unread badge text) | `--kv2-pink-text` | `#9d174d` |
| `#ffedd5` / `#fdba74` (session tone-c chip) | `--kv2-orange-surface` / `--kv2-orange-border` | as listed |
| `#d8b4fe` (card-queue-target bg) | `--kv2-purple-surface-vivid` | `#d8b4fe` |
| `#fffdf7` (primary button text) | `--kv2-btn-primary-fg` | `#fffdf7` |
| `#6b5342` (favorite star, idle) | `--kv2-favorite-icon-idle` | `#6b5342` |
| `#f59e0b` (favorite star, active) | `--kv2-favorite-icon-active` | `#f59e0b` |
| `#f59e0b` (has-question card border — kept distinct from the star token per Rule B, same value today) | `--kv2-question-indicator` | `#f59e0b` |
| `#121212` / `#5b5b5b` (OpenCode logo icon detail) | `--kv2-runtime-opencode-icon-a` / `-b` (layer ①, brand) | as listed |
| `rgba(251, 113, 133, 0.92)` / `rgba(250, 204, 21, 0.88)` (decorative list-row accent bar, one-off gradient not decomposed via color-mix) | `--kv2-list-row-accent-from` / `-to` | kept as full rgba literals |

Session-item tone chips (`--tone-a/b/d/e`) turned out to be **exact reuses** of
existing families — no new tokens needed: tone-a/b/d/e = info/success/purple/warn
`surface-strong`/`border` pairs. Only tone-c (orange) needed a new family.

Dead `var(--token, #fallback)` defaults were dropped (not replaced) in
`conversation.css`: the fallback literals (`#5a5f72`, `#8a8fa3`, and the
`rgba(17, 24, 39, …)` forms of `--kv2-border`) never actually rendered because
the referenced tokens are always defined at `:root` — removing the dead
fallback is value-neutral, not a Rule A/B substitution.

---

## Allowlist — do NOT tokenise into semantic tokens

These are not part of the theme surface. Leave them hard-coded (or move to a
dedicated brand/data token), and do **not** override them in dark mode:

- **Status brand:** `#1e66f5` `#facc15` `#ff3b6b` `#22c55e` and their `fg`/`accent` → `--kv2-status-*`.
- **Agent brand (11):** `#0066FF` `#FF6B35` `#FF3366` `#00CC66` `#6366F1` `#9B59B6` `#1A1A2E` `#2563EB` `#F59E0B` `#CC2244` `#6B7280` → `--kv2-agent-*`.
- **Runtime brand:** `#d97757` (Claude → `--kv2-runtime-claude`), `#111111`/`#121212` (opencode → `--kv2-runtime-opencode`), the codex blue gradient (`--kv2-runtime-codex-accent`). Fixed like a logo.
- **Log-level / syntax (Wiki console):** `#569cd6` `#6a9955` `#d7ba7d` `#c586c0` `#d4d4d4` — VS Code palette; keep, or introduce `--kv2-log-*` in card 4 if needed.
- **Data-viz categorical (WikiGraph):** `#3498db` `#e74c3c` `#f1c40f` `#16a085` `#e67e22` `#95a5a6` `#34495e` — categorical series colours; governed by the dataviz palette rules, not the theme.

---

## Workflow for cards 2–4

1. Grep one file (`board.css`, `card-detail.css`, `panels.css`, `Capabilities.css`,
   `Wiki.css`, …) for `#` / `rgba(`.
2. For each literal, find its row above and substitute by **role** (Rule B).
3. Alpha → `color-mix` (Rule C).
4. Literal not in a table → add a value-exact token + a table row (Rule A), same commit.
5. Never touch layer ① or the allowlist (Rule D).
6. `bunx tsc --noEmit` and `e2e/v2-visual-audit.e2e.ts` must stay green — the diff
   is a pure token indirection, so the visual snapshot must not move.

Suggested card split follows the audit distribution: board.css (~205) ·
card-detail.css (~175) · panels.css (~165) · Capabilities.css + Wiki.css +
Settings/Scheduler/Scripts/App (~230).

---

## Card 5 pointer (do not build here)

The dark palette and the toggle are **out of scope** for this card. Card 5 adds a
`[data-theme="dark"]` override for layer ② plus a `useTheme` hook. Model that hook
on the existing **`web/src/hooks/useFontScale.ts`** — it already owns the pattern
of writing a `:root` custom property (`--kv2-font-scale`) from React state and
persisting the choice. `useTheme` should set `data-theme` on `<html>` the same way.
