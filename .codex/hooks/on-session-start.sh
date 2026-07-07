#!/bin/bash
# Codex Hook: SessionStart
# Ensures the kanban daemon is running. Starts it in the background if needed.

export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

KANBAN_API="${KANBAN_API_URL:-http://localhost:24680}"

DAEMON_PATH_FILE="$HOME/.agent-kanban/daemon-project-path"
if [ ! -f "$DAEMON_PATH_FILE" ]; then
  exit 0
fi
PROJECT_DIR=$(cat "$DAEMON_PATH_FILE")
if [ ! -d "$PROJECT_DIR" ]; then
  exit 0
fi

resolve_data_dir() {
  if [ -n "${KANBAN_DATA_DIR:-}" ]; then
    printf '%s' "$KANBAN_DATA_DIR"
  elif [ -f "$HOME/.agent-kanban/active.json" ]; then
    printf '%s' "$HOME/.agent-kanban"
  else
    printf '%s' "$HOME/.agent-kanban"
  fi
}

KANBAN_DATA_DIR_RESOLVED="$(resolve_data_dir)"
TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.codex-hooks"
mkdir -p "$TRACKING_DIR"

if curl -sf --max-time 2 "${KANBAN_API}/api/board" >/dev/null 2>&1; then
  exit 0
fi

STARTER_PID_FILE="${TRACKING_DIR}/daemon-starter.pid"
LOG_FILE="${KANBAN_DATA_DIR_RESOLVED}/daemon.log"

if [ -f "$STARTER_PID_FILE" ]; then
  STARTER_PID=$(cat "$STARTER_PID_FILE" 2>/dev/null || true)
  FILE_AGE=$(( $(date +%s) - $(stat -f %m "$STARTER_PID_FILE" 2>/dev/null || echo 0) ))
  if [ -n "$STARTER_PID" ] && [ "$FILE_AGE" -lt 30 ] && kill -0 "$STARTER_PID" 2>/dev/null; then
    exit 0
  fi
fi

echo "$$" > "$STARTER_PID_FILE"

BUN_BIN="$(command -v bun 2>/dev/null || true)"
if [ -z "$BUN_BIN" ]; then
  for cand in "$HOME/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun; do
    if [ -x "$cand" ]; then BUN_BIN="$cand"; break; fi
  done
fi
if [ -z "$BUN_BIN" ]; then
  echo "[agent-kanban] bun not found; cannot start daemon. Install: curl -fsSL https://bun.sh/install | bash" >> "$LOG_FILE"
  rm -f "$STARTER_PID_FILE"
  exit 0
fi

nohup "$BUN_BIN" run "${PROJECT_DIR}/src/daemon/index.ts" \
  >> "$LOG_FILE" 2>&1 &
disown

for i in $(seq 1 10); do
  sleep 0.5
  if curl -sf --max-time 1 "${KANBAN_API}/api/board" >/dev/null 2>&1; then
    break
  fi
done

rm -f "$STARTER_PID_FILE"

exit 0
