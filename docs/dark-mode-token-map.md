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

## Resolved in card 3 (card-detail.css / panels.css)

Card 3 applied the map to the detail/create dialog and its sidebar panels.
Every literal in those two files now resolves to a token. The tables above
used "add `--kv2-*` step per Rule A" placeholders for several of them — here
is what they actually became, so card 4 reuses rather than re-derives:

| literal | token | value |
|---------|-------|-------|
| `#555555` (card-id-meta copy button ink) | `--kv2-text-meta` | `#555555` |
| `#666666` (card-id-meta hover) | `--kv2-text-meta-hover` | `#666666` |
| `#27ae60` (card-id-meta "copied" confirmation ink) | `--kv2-success-accent-vivid` | `#27ae60` |
| `#fffdf5` (directory/runtime/meta-dropdown popover bg — distinct shade from `--kv2-surface-warm`) | `--kv2-surface-warm-soft` | `#fffdf5` |
| `#fff6e1` (queue summary card bg) | `--kv2-surface-warm-cream` | `#fff6e1` |
| `#f9fafb` (dropzone / screenshot-grid empty-state bg — distinct shade from `--kv2-surface-sunken`) | `--kv2-surface-sunken-soft` | `#f9fafb` |
| `#bbf7d0` (directory-action bg / command-option hover / progress-step--command border) | `--kv2-success-surface-deep` | `#bbf7d0` |
| `#9a3412` (create-helper--warning text) | `--kv2-warn-text-deepest` | `#9a3412` |
| `#fbbf24` (queue-mode-header bg) | `--kv2-warn-surface-vivid` | `#fbbf24` |
| `#fffbeb` (progress-step--mcp bg) | `--kv2-warn-surface-pale` | `#fffbeb` |
| `#e88764` (claude runtime chip hover fill — brand-adjacent, layer ①) | `--kv2-runtime-claude-hover` | `#e88764` |
| `#fff7ed` (claude icon chip pale bg) | `--kv2-orange-surface-soft` | `#fff7ed` |
| `#e5e7eb` (opencode chip bg, agent selector) | `--kv2-neutral-300` | `#e5e7eb` |
| `#6b7280` (detail-agent-selector-label text — value-coincident with `--kv2-agent-default`, but a different, theme-variable role) | `--kv2-neutral-510` | `#6b7280` |
| `#4b5563` (queue-mode-help text — value-coincident with `--kv2-border-inverse`, but a different, theme-variable role) | `--kv2-neutral-575` | `#4b5563` |
| `#8a8fa3` (session "done" accent — `rgba(138,143,163,…)` base) | `--kv2-neutral-480` | `#8a8fa3` |
| `#eef2ff` (meta-dropdown-option hover bg) | `--kv2-info-surface-pale` | `#eef2ff` |
| `#c7d2fe` (meta-dropdown-option hover border) | `--kv2-info-border-pale` | `#c7d2fe` |
| `#f0f9ff` (progress-step--agent bg) | `--kv2-cyan-surface-pale` | `#f0f9ff` |
| `#ddd6fe` (progress-step--skill border) | `--kv2-purple-border-soft` | `#ddd6fe` |
| `#fbcfe8` (progress-step--memory border) | `--kv2-pink-border` | `#fbcfe8` |
| `#fdf2f8` (progress-step--memory bg) | `--kv2-pink-surface-pale` | `#fdf2f8` |
| `#14b8a6` (phase--meta accent — new Teal family) | `--kv2-teal-accent` | `#14b8a6` |

Role notes:
- `#1f2233` was used uniformly for borders, hard box-shadow ink, *and* text/icon
  colour throughout both files (no `.kv2-btn` primitive in this scope) — all
  resolved to `--kv2-border-strong`, matching the precedent already set in
  `primitives.css`/`board.css` (a text-colour use of the same exact literal
  also resolves to `--kv2-border-strong` there).
- `#ffffff`/`#fff`: `background`/`background-color` uses → `--kv2-surface`;
  `color`/`border`/`border-color` uses → `--kv2-text-inverse` (text/icon/stroke
  on an accent or dark fill), matching Rule B.
- `#2563eb`: `color:` (link/hover text) → `--kv2-text-link`; `border-color:`
  and `accent-color:` (codex icon chrome, checkbox tint) → `--kv2-info-accent`.
  The codex runtime chip/icon reuses the **info** family end-to-end (not
  `--kv2-runtime-codex-accent`), matching the precedent already set by
  `.kv2-runtime-badge--codex` in `board.css`.
- `#111111` (create-agent-chip--runtime-claude border, and the opencode icon
  chip bg/border) all resolve to `--kv2-runtime-opencode` — value-exact reuse
  of the existing brand token rather than a new one-off.
- Dead `var(--token, #fallback)` defaults were dropped (not replaced), same
  as the `conversation.css` precedent from card 2: `--kv2-text-secondary`,
  `--kv2-text-muted`, `--kv2-bg`, `--kv2-status-done-accent` are always
  defined at `:root`, so their raw-hex fallbacks (which don't even match the
  tokens' real values) were dead code. `--session-accent-wash`/`-soft` are
  genuinely conditional (only set by the `--complete`/`--done` dialog
  variants), so their fallbacks are live and were tokenised instead of
  dropped.
- `rgba(0, 0, 0, 0.85)` (screenshot lightbox scrim) was left untouched per
  the pure-black-shadow rule above — normalise in card 5.

**Bugfix carried into card 4:** `--kv2-orange-surface-soft`, `--kv2-purple-border-soft`,
`--kv2-pink-surface-pale` and `--kv2-pink-border` were referenced by
`card-detail.css`/`panels.css` (per the table above) but never actually
declared in `kanban-v2.tokens.css` — a light-mode regression (the `var()`
resolved to nothing). Card 4 added the missing declarations with the values
already documented above; no CSS files changed, only `tokens.css`.

---

## Resolved in card 4 (Capabilities.css / Wiki.css / Settings·Scheduler·Scripts·Question.css / TSX inline / agents.ts)

| literal | token | value |
|---------|-------|-------|
| `#fffdf7` (active segmented-control/tab text, dark fill) | `--kv2-tab-active-fg` | `#fffdf7` |
| `#9b59b6` (skill chip / scope-chip--local / cap-badge--skill — distinct role from `--kv2-agent-librarian`) | `--kv2-purple-accent-deep` | `#9b59b6` |
| `#7d459e` (border paired with the above) | `--kv2-purple-border-deep` | `#7d459e` |
| `#0c4a6e` (cyan family deep text) | `--kv2-cyan-text-deep` | `#0c4a6e` |
| `#06280f` (success family deepest text — cap-badge--success / scope-chip--project) | `--kv2-success-text-deepest` | `#06280f` |
| `#15803d` | `--kv2-success-text-deep` | `#15803d` |
| `#f0fff4` | `--kv2-success-surface-pale` | `#f0fff4` |
| `#ecfdf5` (CardDetailDialog agent-row bg, atlas) | `--kv2-success-surface-faint` | `#ecfdf5` |
| `#059669` (CardDetailDialog agent-row border, atlas) | `--kv2-success-accent-deep` | `#059669` |
| `#536074` used as border/background/accent (cold-storage & freeze-action chrome — distinct role from `--kv2-text-secondary`, which keeps the plain-text mapping) | `--kv2-slate-accent` | `#536074` |
| `#3b5066` (hover/deeper variant + mcp kind-badge) | `--kv2-slate-accent-hover` | `#3b5066` |
| `#f0f4f8` (cold-drawer hint bg) | `--kv2-slate-surface` | `#f0f4f8` |
| `#374151` | `--kv2-neutral-650` | `#374151` |
| `#888888` (wiki-log-empty text) | `--kv2-neutral-465` | `#888888` |
| `#b35f42` (claude badge border, brand-adjacent) | `--kv2-runtime-claude-border` | `#b35f42` |
| `#1e40af` (info family, codex badge border) | `--kv2-info-border-strong` | `#1e40af` |
| `#ff3366` (cap-badge--error bg) | `--kv2-danger-accent-bright` | `#ff3366` |
| `#cc1a47` (cap-badge--error border) | `--kv2-danger-accent-deep` | `#cc1a47` |
| `#fff0f3` | `--kv2-danger-surface-soft` | `#fff0f3` |
| `#fff1f2` | `--kv2-danger-surface-pale` | `#fff1f2` |
| `#fff0f0` (diff-line--removed bg) | `--kv2-danger-surface-faint` | `#fff0f0` |
| `#fafafa` (diff-preview-code bg) | `--kv2-surface-faint` | `#fafafa` |
| `#faf5ff` (CardDetailDialog agent-row bg, librarian) | `--kv2-purple-surface-faint` | `#faf5ff` |
| `#0d9488` (CardDetailDialog agent-row border, plan) | `--kv2-teal-accent-deep` | `#0d9488` |
| `#f0fdfa` (CardDetailDialog agent-row bg, plan / multimodal-looker) | `--kv2-teal-surface` | `#f0fdfa` |
| `#0f766e` (CardDetailDialog agent-row border, multimodal-looker) | `--kv2-teal-text-deep` | `#0f766e` |
| `#ea580c` (CardDetailDialog agent-row border, hephaestus) | `--kv2-orange-accent` | `#ea580c` |
| `#db2777` (CardDetailDialog agent-row border, prometheus) | `--kv2-pink-accent-bright` | `#db2777` |
| `#0066ff` (wiki hero accent bar / options-trigger bg / wiki-stat--archive — same literal as WikiGraph.tsx's `projectColor`) | `--kv2-dataviz-project` | `#0066ff` |
| `#2aabee` (Telegram logo brand) | `--kv2-runtime-telegram` | `#2aabee` |

Role notes:
- `#fff`/`#ffffff` continued to follow Rule B from card 3: `background` uses →
  `--kv2-surface`; `color`/text-on-fill uses → `--kv2-text-inverse`. The bulk
  regex pass in Capabilities/Settings/Scheduler/Scripts initially mapped every
  bare `#fff` to one token per file and was hand-corrected afterward for the
  handful of `color:` (text) cases in `Wiki.css` (col-header, list badge,
  state badges, reprocess tooltip) that a blind regex would have mis-mapped
  to `--kv2-surface`.
- `#1e66f5` (scope-chip--user) and `#22c55e` (scope-chip--project) are
  value-exact reuses of the existing **status brand** tokens
  (`--kv2-status-todo-bg`, `--kv2-status-done-accent`) rather than new
  semantic tokens — scope-chip identity colours are themselves brand-like
  (invariant category badges), so they borrow layer ① directly instead of
  forking a layer ② duplicate.
- **Wiki data-viz categorical family** (`--kv2-dataviz-*`): `Wiki.css` reuses
  the exact same 7 hex values as `WikiGraph.tsx`'s `typeColors`/`projectColor`
  config for column headers, type badges and the detail-dialog accent
  (`troubleshooting` `howto` `decision` `concept` `reference` `pending`
  `skipped` `unprocessed`). These are now real layer-① tokens
  (`--kv2-dataviz-troubleshooting` … `--kv2-dataviz-unprocessed`) so
  `Wiki.css` has no hard-coded hex left. **`WikiGraph.tsx`'s own canvas
  config keeps its literal hex values, unchanged** — it's excluded from this
  card by design (canvas drawing code, not CSS; theming it is card 5's job).
  If a future card wires the canvas up to the tokens, these are the values
  to read from.
- Two wiki "state" badges reuse plain neutral-ramp steps instead of the
  dataviz family because their literals don't match it exactly:
  `#94a3b8`/`#64748b` (wiki-state-badge skipped/unprocessed) →
  `--kv2-neutral-400`/`--kv2-neutral-500`.
- **Agent brand set grew from 11 to 13**: `--kv2-agent-plan` (`#14B8A6`) and
  `--kv2-agent-multimodal-looker` (`#0F766E`) were missing from tokens.css
  even though `web/src/constants/agents.ts` already carried those two agents.
  Card 4 added them so the brand map is complete, and added
  `--kv2-agent-text-on-fill` (`#ffffff`) / `--kv2-agent-text-on-fill-dark`
  (`#1a1a2e`, metis only) as the invariant text-on-brand-fill pair. See
  `docs/design-system.md` § Agent 브랜드 색 for the single-source rule:
  `agents.ts` now holds `var(--kv2-agent-*)` strings, never literal hex —
  tokens.css is the only place the values live.
- `web/src/components/Card/CardDetailDialog.tsx`'s `AGENT_ROW_COLORS` (queue
  child-row border/bg per agent) is a **separate, deliberately pastel**
  palette from the agent brand map — most of its literals don't match the
  brand hex (e.g. oracle row border `#7C3AED` vs. brand `--kv2-agent-oracle`
  `#1A1A2E`), so each was mapped to its own value-exact token above rather
  than reused from `--kv2-agent-*`. Where a literal *did* happen to be
  brand-exact (explore, sisyphus/-junior, librarian, metis, momus), the
  existing agent/status-soft token was reused.
- SVG `fill`/`stroke` attributes in JSX (`CardMetaPanel.tsx`,
  `DirectoryPicker.tsx`, `BoardCardSections.tsx`) now hold `var(--kv2-…)`
  strings — modern browsers resolve CSS custom properties in SVG
  presentation attributes the same as in `style`, so this is value-exact
  and needs no `style` prop wrapper.

---

## Allowlist — do NOT tokenise into semantic tokens

These are not part of the theme surface. Leave them hard-coded (or move to a
dedicated brand/data token), and do **not** override them in dark mode:

- **Status brand:** `#1e66f5` `#facc15` `#ff3b6b` `#22c55e` and their `fg`/`accent` → `--kv2-status-*`.
- **Agent brand (13):** `#0066FF` `#FF6B35` `#FF3366` `#00CC66` `#6366F1` `#9B59B6` `#1A1A2E` `#2563EB` `#F59E0B` `#CC2244` `#14B8A6` `#0F766E` `#6B7280` → `--kv2-agent-*`. Plus the invariant text-on-fill pair `--kv2-agent-text-on-fill` (`#ffffff`) / `--kv2-agent-text-on-fill-dark` (`#1a1a2e`). Single source is `kanban-v2.tokens.css`; `web/src/constants/agents.ts` only references these via `var(--kv2-agent-*)` — see `docs/design-system.md`.
- **Runtime brand:** `#d97757` (Claude → `--kv2-runtime-claude`), `#111111`/`#121212` (opencode → `--kv2-runtime-opencode`), the codex blue gradient (`--kv2-runtime-codex-accent`), `#2AABEE` (Telegram → `--kv2-runtime-telegram`). Fixed like a logo.
- **Log-level / syntax (Wiki console):** `#569cd6` `#6a9955` `#d7ba7d` `#c586c0` `#d4d4d4` `#f48771` — VS Code palette; kept hard-coded in `Wiki.css` (never themed, exact fidelity to the VS Code color scheme is the point).
- **Data-viz categorical — canvas only (`WikiGraph.tsx`):** `#FFF8E7` `#1A1A2E` `#8d8da3` `#999` and the `rgba(26,26,46,…)` / `rgba(141,141,163,…)` link-highlight alphas — these live inside the canvas draw config object (not CSS) and are explicitly out of scope for card 4 (see card 5 pointer). The 8 categorical type/state colours from that same config (`troubleshooting` `howto` `decision` `concept` `reference` `pending` `skipped` `unprocessed` / `projectColor`) now also exist as `--kv2-dataviz-*` tokens (added in card 4) because `Wiki.css` needed them; `WikiGraph.tsx` itself keeps its own literal copies unchanged.

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
Settings/Scheduler/Scripts/Question.css + TSX inline + agents.ts (~230, card 4).

Card 4 additionally covered what the earlier suggested split left out:
`WikiGraph.css`'s one non-canvas literal (in scope; only `WikiGraph.tsx`'s
canvas config is excluded), ~50 lines of TSX inline `style`/SVG-attribute
colour across `Card/` and `Board/`, and `constants/agents.ts`'s brand map
(value-preserving — converted to `var(--kv2-agent-*)` references rather than
new literals). As of the end of card 4, `web/src` is **token-complete**:
`grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' web/src --include='*.css'` outside
`kanban-v2.tokens.css` returns only the two documented allowlist exceptions
(Wiki console syntax colours, and the pure-black `rgba(0,0,0,α)` shadows in
`board.css`/`panels.css` explicitly deferred to card 5), and the same grep
over `*.tsx`/`*.ts` returns only `WikiGraph.tsx`.

---

## Card 5 pointer (do not build here)

The dark palette and the toggle are **out of scope** for this card. Card 5 adds a
`[data-theme="dark"]` override for layer ② plus a `useTheme` hook. Model that hook
on the existing **`web/src/hooks/useFontScale.ts`** — it already owns the pattern
of writing a `:root` custom property (`--kv2-font-scale`) from React state and
persisting the choice. `useTheme` should set `data-theme` on `<html>` the same way.

---

## Resolved in card 5 (dark palette + toggle + canvas theming)

Card 5 shipped the actual dark theme on top of the token-complete base. It only
touched layer ②: the new `:root[data-theme="dark"]` block at the end of
`kanban-v2.tokens.css` overrides surfaces, text, borders, the neutral ramp,
interactive/focus, scrim, shadows and the status-soft families. Layers ① and ③
are inherited unchanged.

### New layer-② tokens added (light values value-exact)

Two literals that cards 2–4 deferred as "pure-black, normalise in card 5" were
finally tokenised — value-exact in light, theme-responsive in dark:

| literal | token | light value | why |
|---------|-------|-------------|-----|
| `rgba(0, 0, 0, α)` neo hard shadows (`board.css`) | `--kv2-shadow-hard-color` (`#000000`) via `color-mix(in srgb, var(--kv2-shadow-hard-color) (α×100)%, transparent)` | `#000000` | dark flips the base to `#8a8a9c` so the offset block stays visible; `color-mix(black N%, transparent)` == `rgba(0,0,0,α)` exactly, so light is pixel-identical |
| `rgba(0,0,0,0.85)` screenshot lightbox bg (`panels.css`) | `--kv2-scrim-strong` | `rgba(0, 0, 0, 0.85)` | media/lightbox backdrop; dark deepens to `0.9` |

### Dark strategy (layer ② only)

- **Neobrutalist hard shadow → light offset.** On a dark ground a black offset
  block vanishes, so `--kv2-shadow-color` and `--kv2-shadow-hard-color` flip to a
  light translucent/grey; the border tokens (`--kv2-card-border-color`,
  `--kv2-border-strong`, `--kv2-*-stroke-color`, `--kv2-ink-black/-pure`) are
  lightened so borders carry the structure.
- **Neutral ramp lightness-inverted.** `--kv2-neutral-900` (darkest text in light)
  → lightest; `--kv2-neutral-300` (light border in light) → dark. Roles preserved.
- **Status-soft re-anchored on the invariant accent via `color-mix`.** Instead of
  ~90 hand-picked dark hexes, each family's `surface*`/`border*`/`text*` steps are
  `color-mix(in srgb, var(--kv2-<family>-accent) N%, var(--kv2-surface | --kv2-text-primary))`
  (surfaces mix the accent into the dark surface; text into the light
  `text-primary`). The `*-accent` tokens themselves are inherited (saturated marks
  read fine on dark). `var(--kv2-surface)`/`var(--kv2-text-primary)` resolve to the
  dark values redefined in the same block.
- **`color-scheme`** is `light` on `:root`, `dark` in the dark block, so native
  scrollbars/checkboxes/form controls follow.

### Canvas (`WikiGraph.tsx`) — the deferred allowlist item

The canvas draw config's theme-variable colours (`background` `#FFF8E7` →
`--kv2-app-bg`; `borderColor` `#1A1A2E` → `--kv2-text-primary`) are now read live
via `getComputedStyle` at draw time (`readThemeColors`), re-read on the
`kanban-theme-change` event, and flow into `paintNode`/`backgroundColor` so
force-graph repaints. Link `rgba()` strings are derived from the same ink (+ the
topic swatch), so **light stays pixel-identical** (`#1A1A2E`→`26,26,46`,
`#8d8da3`→`141,141,163`) while dark follows. The categorical
`typeColors`/`projectColor`/`topicColor` stay literal in config (layer-① data-viz,
theme-invariant, still user-tunable). The two now-redundant gear-panel colour
pickers ("배경", "테두리/글자") were removed. The remaining canvas-only allowlist
literals (`#8d8da3`, `#999`) are theme-invariant neutrals and stay as-is.

---

## Card 6 (final verification, migration closed)

Card 6 re-audited the whole migration with fresh eyes instead of inheriting
card 5's assumptions, and closed the loop with regression guards:

- Re-ran `grep -rnE '#[0-9a-fA-F]{3,8}\b|rgba?\(' web/src --include='*.css'`
  outside `kanban-v2.tokens.css`: still only the two documented allowlist
  exceptions (Wiki console syntax colours; `WikiGraph.tsx` is `.tsx`, not
  `.css`, and out of this grep's scope). No new literals to map.
- Added `web/src/styles/no-hardcoded-colors.test.ts` (`bun test`) as a
  permanent guard so a future PR can't reintroduce a hex/rgba literal into
  `*.css` without either using a token or extending the allowlist here.
- Added `e2e/theme.e2e.ts` (toggle → `data-theme`, localStorage persistence
  across reload, `prefers-color-scheme` → `system` resolution) and a `-dark`
  screenshot variant next to every existing light capture in
  `e2e/v2-visual-audit.e2e.ts`.
- Spot-checked all 5 tabs (board/wiki/capabilities/scheduler/settings) plus
  the create-modal agent/runtime chips in dark — contrast held up on status
  colours, agent brand colours, hard-shadow borders and the segmented theme
  toggle; no further correction was needed.
- The migration (cards 2–6) is considered closed: light mode is pixel-
  identical to the pre-migration baseline, dark mode is fully themed, and the
  guard test + e2e specs prevent silent regressions on either side.
