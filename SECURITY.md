# Security Policy

`agent-kanban` is a **local developer tool**: a Bun server plus a web UI that
dispatches and tracks agent (opencode / Codex / Claude) sessions on your own
machine. The security model is built around that assumption.

## Threat model

The server runs on your machine and, by default, binds to `127.0.0.1` only. The
realistic threats are:

1. **Drive-by / CSRF from the browser** — a malicious web page you visit while
   the board is running tries to call `http://localhost:24680/api/...` to read
   your data or trigger actions (the script runner can execute shell commands).
2. **LAN exposure** — when you opt into `network_exposed` (binding `0.0.0.0`),
   other devices on your network can reach the server.

It does **not** try to defend against other local processes running as your
user — they can already read your files (including the data directory) and bind
sockets. That is the trust boundary of a local dev tool.

## Controls

- **Same-origin only.** The API emits no `Access-Control-Allow-Origin` header,
  and any browser request whose `Origin` does not match the server `Host` is
  rejected with `403`. This blocks drive-by/CSRF from other web pages.
- **Local auth token.** Mutating endpoints, the settings API, and the script
  API require an `Authorization: Bearer <token>` header. The token is generated
  per install and stored under the data directory. The web UI fetches it from
  `GET /api/auth/token`, which is served to **loopback clients only** — so under
  `network_exposed`, remote devices get a read-only view of non-sensitive
  endpoints and cannot mutate state, read secrets, or run scripts.
- **Secrets are not returned in bulk.** `GET /api/settings` redacts masked
  values; the plaintext is only returned by an explicit, token-protected
  single-entry request (used by the UI "reveal" action).

## Data storage & secrets ⚠️

Settings you store through the UI (e.g. `TELEGRAM_BOT_TOKEN`) are written as
**plaintext JSON** under `~/.agent-kanban/`. The
UI "mask" toggle is **display-only — it is not encryption**. Anyone with read
access to your home directory can read these values. Treat the data directory
as sensitive and do not commit it.

## Recommendations

- Keep the default `127.0.0.1` bind. Only enable `network_exposed` on networks
  you trust, and understand that remote access is read-only by design.
- The script runner executes arbitrary shell/Python. Only add scripts you wrote
  or trust.
- Do not place the data directory in a shared/synced location.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Use GitHub's **"Report a vulnerability"** (Security advisories) on
`github.com/hjyyessh-ux/agent-kanban`, or open a minimal private channel with the
maintainer. We will acknowledge the report and work on a fix before any public
disclosure.
