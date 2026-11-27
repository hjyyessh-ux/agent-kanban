#!/usr/bin/env bash
set -euo pipefail

# Keep maintenance requests from already-running daemon builds working during the rename.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec bash "$SCRIPT_DIR/restart-agent-kanban.sh" "$@"
