# design-sync notes — agent-kanban

## What this repo is
- This is an **application**, not a component library. It was synced under the
  user's explicit "force anyway" decision (the design-sync fit is weak: there is
  no built dist that exports UI components, and components are app-state /
  hook / fetch coupled).
- Scope chosen: **floor cards everywhere** (no authored previews). All 67
  components ship the importable bundle + `.d.ts` + `.prompt.md` + the floor
  card. Previews can be authored incrementally on any later re-sync.

## Build mechanics (important — non-obvious)
- **Synth-entry mode is forced via a nonexistent `--entry`.** The repo's real
  `package.json` `main` points at `dist/daemon/index.js` (the **backend
  daemon**) — if the converter resolved that as the dist entry it would bundle
  the daemon as the "design system." To avoid it, we pass a **nonexistent**
  entry under the repo so `resolveDistEntry` returns null (soft) → synth from
  `web/src`, while the package.json walk-up still sets `PKG_DIR` = repo root
  (keeps `cssEntry` / `srcDir` in-bounds). The build command:
  ```
  node .ds-sync/package-build.mjs --config .design-sync/config.json \
    --node-modules ./node_modules --entry ./web/src/__ds_synth_entry__.mjs \
    --out ./ds-bundle
  ```
  The `__ds_synth_entry__.mjs` file must **not** exist. `[NO_DIST]` lines in the
  log are expected, not errors.
- `cfg.srcDir` = `web/src`; `cfg.tsconfig` = root `tsconfig.json` (for the
  `@/* → ./src/*` alias). 67 PascalCase exports discovered, ~51 src-matched.

## CSS / tokens
- `cfg.cssEntry` points at the **compiled** `web/dist/assets/index-*.css` — the
  only single self-contained stylesheet that carries the `:root --kv2-*` tokens
  **and** the `kv2-*` primitive classes (the source is split across a
  `@import` barrel that ships nothing when appended). The source barrel
  (`kanban-v2.components.css`) does NOT work as `cssEntry`.
- `tokens/` in the bundle is empty (tokens are inside `_ds_bundle.css` via the
  compiled cssEntry, which is what actually styles designs). The DS-pane token
  section is cosmetic and not populated.

## Fonts
- The app loads **Google Fonts at runtime** (Work Sans, Source Sans 3, Source
  Code Pro) via a `<link>` in `web/index.html`. Declared as host-provided with
  `cfg.runtimeFontPrefixes` → `[FONT_MISSING]` suppressed. The bundle does NOT
  ship woff2s; designs render in `system-ui` fallback unless the host loads
  Google Fonts.

## Known render warns
- `[RENDER_SKIPPED]` — the headless render check was **skipped** at the user's
  choice (no chromium installed, ~200MB install declined). Previews were never
  machine-verified. This is expected on every run until a browser is installed.

## Re-sync risks (watch-list)
- **`cfg.cssEntry` has a content hash** (`index-D3fnE_EO.css`). It changes on
  every `bun run build:web`. Before a re-sync, rebuild the web app and re-point
  `cfg.cssEntry` at the new `web/dist/assets/index-*.css`, or styling silently
  reverts to the incomplete bundle-scraped CSS. A stable fix would be to point
  cssEntry at a committed, complete stylesheet.
- Synth-entry over app code: adding node-only imports to a `web/src` component
  could break the esbuild bundle. If a rebuild fails to bundle, suspect a new
  backend/runtime import pulled in through the component graph.
- Render check never ran — a component that renders blank would not have been
  caught. Install playwright+chromium to gain the mechanical gate.
- Floor-card set is the standing offer for incremental preview authoring.
