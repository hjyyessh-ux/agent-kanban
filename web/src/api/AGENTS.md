<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-01 | Updated: 2026-07-01 -->

# api/

## Purpose
Bootstraps browser-side auth for the same-origin `/api/*` backend. This is the one place that patches `window.fetch` globally; everything else (domain hooks) calls plain `fetch()` and rides on top of this wrapper transparently.

## Key Files
| File | Description |
|------|-------------|
| `authFetch.ts` | Fetches the per-install bearer token from `GET /api/auth/token` once at startup, then monkey-patches `window.fetch` so every same-origin `/api/*` request carries `Authorization: Bearer <token>`. No-ops when the server has no token configured (unit/e2e servers). |

## For AI Agents
### Working In This Directory
- `bootstrapAuth()` is called exactly once, from `main.tsx`, before `App` renders. Do not call it again elsewhere.
- The wrapper only attaches the header for same-origin requests whose path starts with `/api` (`isSameOriginApi()`); cross-origin or non-API requests pass through untouched via `rawFetch`.
- If a caller already sets an `Authorization` header, the wrapper does not override it.
- This module holds module-level mutable state (`token`, `installed`); it is intentionally a singleton, not something to instantiate or import multiple copies of.

### Testing Requirements
- No dedicated test file exists for this module today. If you change token-fetch or header-injection behavior, add coverage exercising both the "token present" and "no token endpoint / network error" fallback paths.

### Common Patterns
- Failures during bootstrap (missing endpoint, network error) are swallowed and treated as "no auth needed" — never throw out of `bootstrapAuth()`.
- Keep `window.fetch.preconnect` preserved when wrapping, so the patched function still satisfies `typeof fetch`.

## Dependencies
### Internal
- None (this module does not import from `src/core` or other web modules).

### External
- Browser `fetch`/`Headers`/`URL` globals only — no third-party HTTP libraries.

<!-- MANUAL: -->
