<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-06-25 | Updated: 2026-07-01 -->

# src/server/ — Bun HTTP Server and Routes

## Purpose

Thin Bun server layer. `index.ts` owns `Bun.serve()` and SPA/static serving; `routes.ts` (a hot-path file, 124+ edits) owns all REST endpoints for cards, schedulers, settings, scripts, screenshots, models, pending questions, wiki, and the scope manager (`/api/scope/*`: targets, inventory, cold storage freeze/restore/detail).

## Key Files

| File | Description |
|------|-------------|
| `index.ts` | `createServer()` wraps `Bun.serve()`, port-retry (configured port + 3), SPA static/HTML-fallback serving, API-first routing before static lookup |
| `routes.ts` | All REST endpoints — cards/archive/dispatch, schedulers, settings, scripts, skills, skill-roots, models, questions, wiki proxy, and runtime-aware `/api/scope/*` (targets, MCP inventory/write, cold freeze/restore/detail) |
| `maintenance-runner.ts` | Update/restart maintenance flow backing `/api/maintenance/*` routes |

## For AI Agents

### Working In This Directory

- `createServer()` in `index.ts` takes a long positional-argument list of optional stores/fns (dispatch, scheduler, settings, script, models, question-monitor, aggregate/local-peer session fns, peer-token fn, runtime-catalog fn, wiki-worker, skill store, skill-roots store, placement-targets store, scope-MCP inventory fn) — when adding a new store dependency, extend this list and thread it through `createRouteHandler()` in `routes.ts` rather than reaching for a global.
- `/api/*` routes are handled before any static asset lookup (see `index.ts` `fetchHandler`).
- Parameterized routes use manual regex/string matching (`path.startsWith(...)`, `path.endsWith(...)`) — there is no router library.
- Success responses are JSON; failures always use `{ error: string }`.
- If `staticDir` is missing, the server still works in API-only mode (used by tests).
- `routes.ts` is large (~98KB) and edited frequently — grep for the exact `method === 'X' && path === 'Y'` block before adding a new one nearby, and follow the existing block shape (auth classification, JSON parse, store call, response).

### Testing Requirements

- Route-level behavior is covered by `src/__tests__/server.test.ts`, `plugin-server.test.ts`, `server-monitor.test.ts`, `maintenance-routes.test.ts`, `question-routes.test.ts`, `script-routes.test.ts`, plus the new store-backed suites (`cc-settings-store.test.ts`, `cold-storage-store.test.ts`, `mcp-config-store.test.ts`, `placement-targets-store.test.ts`) that exercise the logic behind `/api/scope/*`.
- Start real servers with port `0` in tests; never hardcode a port.
- When adding a route, add both a positive-path test and an auth-classification check (does it require `requiresLocalAuth`?).

### Common Patterns

- Classify every new route in `requiresLocalAuth(method, path)`: mutating methods plus secret/script/scope reads must require the bearer token; read-only, non-secret routes may skip it.
- Never echo unmasked secret values from list/bulk responses — only single-entry, token-protected reads may return plaintext (see `GET /api/settings/:id`).
- Reuse `plugin/wiki/wiki-worker.ts`, `core/cold-storage-store.ts`, `core/mcp-runtime-adapter.ts`, `core/mcp-config-store.ts`, `core/codex-mcp-config.ts`, and `core/placement-targets-store.ts` for scope/wiki business logic instead of inlining it in `routes.ts`.
- Missing MCP `runtime` in legacy request bodies means `claude`; validate explicit values as `claude | codex`, use runtime + name for inventory identity, and placement identity for exact writes. Preview requests must not mutate files.
- `/api/scope/inventory` keeps the legacy Claude `ContextDiagnostics` counts Claude-only and adds Codex scan/trust diagnostics under `diagnostics.mcpDiscovery`.

## Dependencies

### Internal

- `../core/store`, `../core/scheduler-store`, `../core/settings-store`, `../core/script-store`, `../core/skill-store`, `../core/skill-roots-store`, `../core/placement-targets-store`, `../core/cold-storage-store`, `../core/mcp-config-store`, `../core/cc-settings-store`
- `../plugin/scheduler-engine`, `../plugin/question-monitor`, `../plugin/wiki/wiki-worker`

### External

- `Bun.serve()` (no Express/Hono/Koa)

## SECURITY MODEL

The SPA is served same-origin, so the API grants **no cross-origin access**:

- **No wildcard CORS.** Responses carry no `Access-Control-Allow-Origin`. Do not re-add `*`.
- **Same-origin guard** (`isForbiddenCrossOrigin`): any request whose `Origin` host differs from the `Host` is rejected `403`. This is the primary CSRF / drive-by defense and works for both `127.0.0.1` and `network_exposed` (LAN) binds. Non-browser clients send no `Origin` and pass.
- **Local token auth** (`requiresLocalAuth`): when a token is configured (`peerTokenFn`, wired by the plugin/daemon), all mutating methods plus secret/script/scope reads require `Authorization: Bearer <token>`. When no token is wired (unit/e2e test servers) the gate is a no-op and the same-origin guard remains active. Currently gated path prefixes include `/api/settings`, `/api/scripts`, `/api/skills`, `/api/skill-roots`, and `/api/scope`.
- **Token bootstrap** `GET /api/auth/token`: returns the token to **loopback clients only**, so remote devices under `network_exposed` cannot obtain it (and thus cannot mutate or read secrets). The SPA fetches it on boot (`web/src/api/authFetch.ts`).
- **Secret redaction**: `GET /api/settings` (list) and settings write responses redact masked values (`value: ''`). Plaintext is only returned by the explicit, token-protected single-entry `GET /api/settings/:id`. The scope manager applies the same discipline via `detectPlaintextSecret` (`core/mcp-config-store.ts`) and `secret-detect.ts` before surfacing MCP config values.

When adding routes: classify them in `requiresLocalAuth` (mutations and secret/code/scope reads need auth) and never echo masked secret values in bulk responses.

## ANTI-PATTERNS

- Express/Hono/Koa or middleware chains
- Response shapes that drift from `{ error: string }`
- Re-introducing wildcard CORS, or skipping the same-origin guard / auth classification on new endpoints
- Returning plaintext masked secrets from list or write responses
- Hiding route-side business logic outside `routes.ts` without a clear shared helper

## NOTES

- `index.ts` reads SPA files into `ArrayBuffer` first to avoid Bun header/body race issues on non-loopback interfaces.
- `routes.ts` also records question reply/reject history back onto matching cards.

<!-- MANUAL: -->
