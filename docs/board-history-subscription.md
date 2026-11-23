# Dedicated board-history subscription (Card/Work metadata sidecar)

One local consumer follows Card/Work **metadata** changes. It is a sidecar:
`active.json` / `works.json` stay the only primary store, the board UI and
existing routes are unchanged, and it never uses the SPA peer token, the full
board read, or any write path.

## Published fields

`kind` (`card`/`work`), entity ID, operation (`create`, `update`, `archive`,
`restore`, `delete`), status enum, times, journal sequence. Titles,
descriptions, prompts, results, logs, paths, attachments and raw errors are
never read into the sidecar (`src/core/board-history.ts`).

| Observed on save | Operation | Time basis |
|---|---|---|
| new ID | `create` | `updatedAt` |
| status changed | `update` | `updatedAt` if it advanced, else append time |
| same status, `updatedAt` strictly newer | `update` | `updatedAt` |
| same status, equal or older `updatedAt` (no-op / replay) | nothing | — |
| soft delete / restore | `delete` / `restore` | as above |
| card left `active.json` without soft delete | `archive` | append time |
| unarchived card back on board | `restore` | as above |
| Work removed from `works.json` | `delete` | append time |
| purge of an already-deleted card, invalid ID/status | nothing | — |

## Capture and completeness

Writers: only `KanbanStore.save()` and `WorkStore.save()` write these files
(the `.claude`/`.codex` hooks go through HTTP). Both run under the store's
in-process mutex plus cross-process `FileLock`.

Per save, under that lock:
1. `prepare` — durable intent row; compares the file's identity (inode,
   size, mtime) with the fence left by the last successful capture.
2. JSON tmp write + rename (unchanged).
3. `commit` — diff vs last captured state → journal append (deterministic
   event IDs) → state, fence and intent cleared in one transaction.

Recovery: on boot and before every consumer read, each store reconciles
under its lock (read-only). What cannot be vouched for is declared in
`coverage`, never hidden:

| Situation | Result |
|---|---|
| crash/failure between rename and commit | `pendingSince` until recovered, then `gaps[].reason = interrupted_capture` |
| writer without the observer (older build, direct edit) | `gaps[].reason = unobserved_writer` |
| part of the 7-day window before install | `preCaptureGap` (no events exist there; none are synthesized) |
| journal capacity reached | `pendingSince` stays set; board write still succeeds |

Inside a gap the final state is published but intermediate transitions may be
collapsed. `continuousSinceWindowStart` is true only with no pre-capture gap,
no gaps and nothing pending. A sidecar fault never fails a board write; it is
logged as `boardHistory.capture.failed` with a fixed code.

## Window and replay

The 7-day window is fixed at registration (install time − 7 days). Journal
events already appended before install are replayed only if inside that
window. After the window, delivery is incremental from the ACKed checkpoint.

## Consumer API

Loopback peers only (an unknown peer address is refused), `Authorization:
Bearer <consumer token>`. The peer token is refused here, and the consumer
token is refused everywhere else.

| Route | Notes |
|---|---|
| `GET /api/board-history/status` | checkpoint, cutoff, `coverage` |
| `GET /api/board-history/events?limit=1..100` | the only accepted parameter |
| `POST /api/board-history/ack` `{"deliveryId": "..."}` | exactly one field; ≤ 1024 bytes, refused by `Content-Length` before reading |

A page is re-served unchanged until ACKed, also across restarts; ACK replay
returns the same checkpoint. Errors are fixed codes: `401 Unauthorized`,
`403 board_history_local_only`, `400 unsupported_parameter` /
`invalid_board_page_size` / `invalid_json`, `404 board_history_not_installed`,
`409 invalid_board_delivery`, `410 board_cursor_expired`, `413
payload_too_large`, `503 board_journal_capacity_reached` /
`board_history_unavailable`. Capacity limits in
`managed-board-journal-capacity.md` apply.

## Install (one time)

Requirements: the running daemon and any opencode plugin process are on a
build that contains this change. A process on an older build still works but
its writes show up as `unobserved_writer` gaps.

```bash
# macOS/Linux shell. The token comes from the consumer's own credential storage
# (32–256 chars of [A-Za-z0-9_-]); only its SHA-256 is written, to
# <dataDir>/board-history/consumer.json (0600, dir 0700).
<print-token-from-credential-store> | bun run board-history:install dot
```

Baselines are read under each store's file lock; install writes no board
files. A second install fails with `board_history_already_installed`. A
running daemon on this build picks it up without restart.

## Rollback

| Goal | Action | Effect |
|---|---|---|
| stop serving and capturing | move `board-history/consumer.json` out of the data dir | routes return 404, saves skip capture; JSON untouched |
| resume | move it back | next read/save reconciles; the paused interval becomes an `unobserved_writer` gap |
| remove entirely | delete `board-history/` | no other file references it |
| revert code | revert the commit | older builds ignore `board-history/` |

No rollback step touches `active.json`, `works.json`, archives or attachments.
