# Cold Board storage cutover

This is an offline storage change for the **same** Agent Kanban daemon and
OpenCode plugin. No extra service, proxy, port or watcher is required.

1. Take and verify an offline backup of the whole data directory (including
   Board, Work, archives, attachments and the History directory). Keep the
   original directory in place: the History observer's saved fence uses its
   source file identities. Drain in-flight work; stop the current app and
   **all** daemon, plugin and maintenance writers. Pause the usual launch
   mechanisms (including hooks), not just the visible UI. Verify that no old
   build will start using this directory.
2. Against the canonical absolute data directory, use the new checkout:
   ```sh
   bun scripts/sqlite-board-cutover.ts --check --data-dir /absolute/board
   bun scripts/sqlite-board-cutover.ts --activate --data-dir /absolute/board --all-writers-stopped
   ```
   Check validates a temporary import and does not publish. Activation creates
   `board.sqlite` and publishes `.board-storage` last. The CLI does not change
   JSON, attachments, History, permissions or process registrations. It
   checks known locks and live registered peers but cannot detect arbitrary
   writers or prevent old code from starting. The flag is an operator
   assertion, not a substitute for stopping and excluding those writers.
3. Start the existing app normally from the new checkout with the same data
   dir, existing History subscriber and normal port. Verify saved cards,
   Work, archive and an outstanding History delivery; then perform a small
   card write and verify that the old JSON did not change and that History
   continues. Do not start the old build again against the active directory.

Repeated activation validates an existing selected database without
reimporting or overwriting it. If interrupted after the database was published
but before its marker, re-run while still cold. It will publish the marker
only when the unactivated database matches a fresh frozen import (including
source identities). Any mismatch, invalid marker, missing linked DB, unknown
peer, or unexpected lock is a stop condition. Inspect backups and shutdown;
do not blindly delete the marker, SQL files or lock. Once SQLite writes start,
using the old JSON would drop those writes. Recovery that retains newer work
must retain the SQLite database; this tool does not roll back live writes.

## Search tools and hooks

Custom local skills and scripts must not read `active.json`, `works.json` or
`archive/*.json` after activation; those are frozen originals. Existing app
hooks continue using the same HTTP API. Update personal search skills to use
the current app port. For example, a known session is available with its
active and archived cards:

```sh
curl --fail-with-body --get 'http://127.0.0.1:24680/api/cards' \
  --data-urlencode 'include_archived=true' \
  --data-urlencode "session_id=$SESSION_ID"
```

For broad search, query `/api/cards?include_archived=true` and filter the JSON
locally. Work metadata remains at `/api/works`. Do not fall back to the frozen
files when the app is unavailable; this would return plausible stale results.
