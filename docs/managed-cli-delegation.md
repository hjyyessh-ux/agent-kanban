# Managed Claude and Codex delegation

The standalone Kanban daemon can record an explicitly requested review from
one dispatched CLI as a child of that CLI's active Card and runtime run:

| Parent | Child |
| --- | --- |
| Claude | Codex |
| Codex | Claude |

The feature is **off by default** (setting `agent.external_delegation.enabled`).
It does not infer parentage for a command started directly in a shell. The
managed runner authenticates to the daemon's real loopback listener through its
existing local peer credential. It does not follow redirects. LAN and
unauthenticated requests cannot use the delegation API. Use read-only model
permissions for children; a child cannot open another delegation.

A request is bound to its active parent Card/run and an idempotency key. The
child run and Card IDs are saved before spawn. The adapter links only a session
reported by that child runtime. A retry with the same input retrieves the
existing run. A different deliberate review requires a new request ID.
On parent success, admission closes and active child runs are allowed to drain.
Interrupted child runs are reconciled without re-launching, and their saved
output stays available. Native same-runtime subagents are a separate path.

Verification on account-backed CLIs depends on their local authentication
and their policy for localhost access; a sandbox refusing the runner must
not be bypassed. OpenCode-hosted plugin delegation is not enabled here.
This change does not modify Board History or change its credentials,
transport, or backing store.

Tests use synthetic local CLIs. Disable the setting and drain children before
rolling back to a build without managed delegation.
