# Managed Claude and Codex delegation

A trusted local operator can deliberately ask the standalone Kanban daemon
to launch an opposite-runtime review under a currently running Card:

| Parent | Child |
| --- | --- |
| Claude | Codex |
| Codex | Claude |

The feature is **off by default**. It requires
`agent.external_delegation.enabled` plus a dedicated high-entropy operator
credential supplied to the standalone daemon and the local operator runner as
`KANBAN_DELEGATION_OPERATOR_TOKEN`. No placeholder is provided or enabled.
The daemon retains the credential in process, removes it from its environment
before creating runtimes, and only its current runtime owner can accept the
request. The runner takes explicit `--parent-card`, `--parent-run`, and
`--request-id`. The board-wide peer token, browser Origin, forwarded requests,
remote or unknown socket addresses, and credentials supplied by a child are
not supported as operator authority. Do not add credentials to prompts, model
settings, logs or command arguments. The local runner does not follow redirects.

The latest active parent Card/run must have a real session. The child run and
Card are reserved before spawn and link only to a session reported by that
child runtime. The same request ID and input retrieves the existing run; a
different deliberate review requires a new key. Managed children use
read-only review permissions and cannot delegate again. A successful parent
closes admission and waits up to 60 seconds for already accepted children;
timeouts do not mark the parent successful or erase child work. Recovery
does not re-launch interrupted children. Same-runtime native child handling
remains separate.

There is no transparent provider-to-provider launch via inherited IDs, no
guessing for independently launched shell commands, and no managed route on
the OpenCode-hosted plugin. Actual account-backed CLI validation still
requires operator credentials, normal permissions, and a dedicated local
test. Do not bypass a sandbox which cannot use this route. Board History
and its credential are independent. Disable delegation and drain children
before rolling back to a release which does not support managed delegation.
