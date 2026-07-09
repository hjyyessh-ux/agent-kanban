# Agent Kanban — kv2 design system

This library is the UI of the Agent Kanban app. Its design system is **kv2**: a
plain-CSS system of design **tokens** (`--kv2-*` custom properties) plus a small
set of **primitive classes** (`kv2-*`). There is **no CSS-in-JS and no utility
framework** — you style with the token variables and the primitive classes
below, never by inventing new class names.

## Setup

- **No provider/wrapper is required.** All styling ships as global CSS reachable
  from `styles.css` (it `@import`s `_ds_bundle.css`, which carries the `:root`
  tokens, the `kv2-*` primitives, and every component's own CSS). Import that and
  components are styled.
- **Fonts load at runtime from Google Fonts** — `Work Sans` (sans / body),
  `Source Sans 3` (headings), `Source Code Pro` (mono). They are *not* bundled;
  the host page is expected to load them (the app does so with a
  `<link href="https://fonts.googleapis.com/css2?family=Source+Code+Pro…&family=Work+Sans…&family=Source+Sans+3…">`).
  Without that link they fall back to `system-ui`. Add the same link in any host
  that must be pixel-on-brand.

## The styling idiom

**Tokens** — style with `var(--kv2-*)`, never hard-coded hex. Real families:

| Group | Examples |
|---|---|
| Surface | `--kv2-app-bg`, `--kv2-frame` |
| Text | `--kv2-text-primary`, `--kv2-text-secondary` |
| Type | `--kv2-font-sans`, `--kv2-font-heading`, `--kv2-font-mono` |
| Text scale | `--kv2-text-3xs` … `--kv2-text-lg` |
| Status color | `--kv2-status-todo-accent`, `--kv2-status-done-bg`, `--kv2-status-in-progress-*` |
| Agent color | `--kv2-agent-sisyphus`, … (one per agent) |

**Primitive classes** — compose these; do not redefine them locally:

| Class | Use | Variants (append) |
|---|---|---|
| `kv2-btn` | every button | `--primary`, `--success`, `--danger`, `--ghost`, `--outline`, `--small`, `--full` |
| `kv2-input` / `kv2-select` / `kv2-textarea` | form controls | — |
| `kv2-label`, `kv2-form-group` | field label / group | — |
| `kv2-badge` | status / count badge | `--accent`, `--queue`, `--saved`, `--session` |
| `kv2-panel-heading` | panel title | — |

**Modals** — never build overlays by hand. Compose the `DialogSkeleton`
component; it owns the `kv2-dialog-overlay` / `kv2-dialog-backdrop` /
`kv2-dialog-header` / `kv2-dialog-footer` structure. **Errors** — use the
`ErrorAlert` component (`.error-banner`), not an ad-hoc red box.

## Where the truth lives

Read `styles.css` and its `@import` closure (`_ds_bundle.css`) for the full
token and class vocabulary, and each component's `<Name>.d.ts` + `<Name>.prompt.md`
for its props and usage. Components are grouped by app area: `board`, `card`,
`capabilities`, `scheduler`, `wiki`, `settings`, `scripts`, `question`,
`shared`, `general`.

## Idiomatic snippet

```jsx
// A kv2 form row + primary action. Library component for the control,
// kv2 tokens/classes for your own layout glue.
<div className="kv2-form-group">
  <label className="kv2-label">Session name</label>
  <input className="kv2-input" placeholder="e.g. fix-login-bug" />
  <div style={{ display: 'flex', gap: 'var(--kv2-text-2xs)', marginTop: 8 }}>
    <button className="kv2-btn kv2-btn--primary">Dispatch</button>
    <button className="kv2-btn kv2-btn--ghost">Cancel</button>
  </div>
</div>
```
