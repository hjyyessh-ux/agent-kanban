#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

resolve_data_dir() {
  if [ -n "${KANBAN_DATA_DIR:-}" ]; then
    printf '%s' "$KANBAN_DATA_DIR"
  elif [ -f "$HOME/.agent-kanban/active.json" ]; then
    printf '%s' "$HOME/.agent-kanban"
  else
    printf '%s' "$HOME/.agent-kanban"
  fi
}

DATA_DIR="$(resolve_data_dir)"
LOCK_PATH="$DATA_DIR/.singleton-runtime.lock"
PEERS_DIR="$DATA_DIR/peers"
WAIT_SECONDS=20
HANDOFF_DELAY_SECONDS=1
LOG_FILE="$DATA_DIR/restart-main-session.log"
DRY_RUN=0
FORCE_KILL=0
# Cold-start fallback: used whenever there is no live runtime owner to hand off
# from (missing lock, stale/dead PID). The goal of this script is to ALWAYS end
# up with a fresh session running, so these defaults must be runnable on their own.
COLD_START_COMMAND="${KANBAN_RESTART_COMMAND:-opencode}"
COLD_START_CWD="${KANBAN_RESTART_CWD:-$REPO_ROOT}"

usage() {
  cat <<EOF
Usage: bash scripts/restart-main-session.sh [options]

Gracefully restart the current agent-kanban runtime owner process.

Options:
  --dry-run              Print the target pid/cwd/command without restarting
  --force                Send SIGKILL after timeout if TERM does not stop the process
  --data-dir PATH        Override kanban data dir (default: $DATA_DIR)
  --wait-seconds N       Seconds to wait after TERM before KILL (default: $WAIT_SECONDS)
  --log-file PATH        Detached helper log file (default: $LOG_FILE)
  --command CMD          Cold-start command when no live owner exists (default: $COLD_START_COMMAND)
  --cwd PATH             Cold-start working directory (default: $COLD_START_CWD)
  --help                 Show this help message

When a live runtime owner is found, this script gracefully restarts it in place.
When no live owner exists (missing lock or dead PID), it cold-starts a fresh
session using --command in --cwd. A new session is launched either way.
EOF
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

read_lock_pid() {
  bun -e '
    import { existsSync, readFileSync } from "node:fs";

    const path = process.argv[1];
    if (!path || !existsSync(path)) process.exit(0);

    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
        console.log(String(parsed.pid));
      }
    } catch {
      process.exit(0);
    }
  ' "$LOCK_PATH"
}

read_peer_cwd() {
  local target_pid="$1"
  bun -e '
    import { existsSync, readdirSync, readFileSync } from "node:fs";
    import { join } from "node:path";

    const peersDir = process.argv[1];
    const targetPid = Number(process.argv[2]);

    if (!peersDir || !existsSync(peersDir) || !Number.isFinite(targetPid)) {
      process.exit(0);
    }

    for (const entry of readdirSync(peersDir)) {
      if (!entry.endsWith(".json")) continue;

      try {
        const parsed = JSON.parse(readFileSync(join(peersDir, entry), "utf8"));
        if (parsed?.pid === targetPid && typeof parsed.cwd === "string" && parsed.cwd.length > 0) {
          console.log(parsed.cwd);
          break;
        }
      } catch {
        // Ignore unreadable peer records.
      }
    }
  ' "$PEERS_DIR" "$target_pid"
}

resolve_process_cwd() {
  local target_pid="$1"
  local peer_cwd=""
  peer_cwd="$(trim_whitespace "$(read_peer_cwd "$target_pid")")"
  if [ -n "$peer_cwd" ]; then
    printf '%s' "$peer_cwd"
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    local lsof_cwd=""
    lsof_cwd="$(lsof -a -d cwd -p "$target_pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
    lsof_cwd="$(trim_whitespace "$lsof_cwd")"
    if [ -n "$lsof_cwd" ]; then
      printf '%s' "$lsof_cwd"
      return 0
    fi
  fi

  printf '%s' "$REPO_ROOT"
}

resolve_process_command() {
  local target_pid="$1"
  local command_line=""
  command_line="$(ps -p "$target_pid" -o command= 2>/dev/null || true)"
  trim_whitespace "$command_line"
}

validate_restart_command() {
  local command_line="$1"

  case "$command_line" in
    opencode*|*"/opencode "*|*src/plugin/index.ts*|*src/daemon/index.ts*|*"bun run dev:plugin"*)
      return 0
      ;;
    *)
      echo "Unsupported restart command: $command_line" >&2
      echo "Supported patterns: opencode / src/plugin/index.ts / src/daemon/index.ts / bun run dev:plugin" >&2
      return 1
      ;;
  esac
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE_KILL=1
      shift
      ;;
    --data-dir)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --data-dir" >&2
        exit 1
      fi
      DATA_DIR="$2"
      LOCK_PATH="$DATA_DIR/.singleton-runtime.lock"
      PEERS_DIR="$DATA_DIR/peers"
      LOG_FILE="$DATA_DIR/restart-main-session.log"
      shift 2
      ;;
    --wait-seconds)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --wait-seconds" >&2
        exit 1
      fi
      WAIT_SECONDS="$2"
      shift 2
      ;;
    --log-file)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --log-file" >&2
        exit 1
      fi
      LOG_FILE="$2"
      shift 2
      ;;
    --command)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --command" >&2
        exit 1
      fi
      COLD_START_COMMAND="$2"
      shift 2
      ;;
    --cwd)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --cwd" >&2
        exit 1
      fi
      COLD_START_CWD="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! [[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "--wait-seconds must be a non-negative integer" >&2
  exit 1
fi

if ! command -v bun >/dev/null 2>&1; then
  echo "bun is required to parse runtime metadata." >&2
  exit 1
fi

# Resolve the restart plan. A live, supported runtime owner is restarted in
# place; anything else (missing lock, dead PID) falls back to a cold start so a
# fresh session is always launched.
COLD_START=0
TARGET_PID="$(trim_whitespace "$(read_lock_pid)")"

if [ -z "$TARGET_PID" ]; then
  echo "No runtime owner lock found at $LOCK_PATH; cold-starting a fresh session." >&2
  COLD_START=1
elif ! kill -0 "$TARGET_PID" 2>/dev/null; then
  echo "Runtime owner PID $TARGET_PID is not alive; cold-starting a fresh session." >&2
  COLD_START=1
  TARGET_PID=""
fi

if [ "$COLD_START" -eq 1 ]; then
  TARGET_COMMAND="$COLD_START_COMMAND"
  TARGET_CWD="$COLD_START_CWD"
else
  TARGET_COMMAND="$(resolve_process_command "$TARGET_PID")"
  if [ -z "$TARGET_COMMAND" ]; then
    echo "Failed to read command line for PID $TARGET_PID" >&2
    exit 1
  fi

  validate_restart_command "$TARGET_COMMAND"

  TARGET_CWD="$(resolve_process_cwd "$TARGET_PID")"
  if [ -z "$TARGET_CWD" ]; then
    echo "Failed to resolve working directory for PID $TARGET_PID" >&2
    exit 1
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  cat <<EOF
cold_start=$COLD_START
main_pid=${TARGET_PID:-<none>}
main_cwd=$TARGET_CWD
main_command=$TARGET_COMMAND
log_file=$LOG_FILE
wait_seconds=$WAIT_SECONDS
force_kill=$FORCE_KILL
EOF
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"

nohup /bin/zsh -lc '
  target_pid="$1"
  target_cwd="$2"
  target_command="$3"
  wait_seconds="$4"
  handoff_delay="$5"
  log_file="$6"
  force_kill="$7"

  timestamp() {
    date "+%Y-%m-%d %H:%M:%S"
  }

  log_line() {
    printf "[%s] %s\n" "$(timestamp)" "$1" >> "$log_file"
  }

  sleep "$handoff_delay"

  if [ -z "$target_pid" ]; then
    log_line "Cold start: no existing runtime owner to stop"
  else
    if kill -0 "$target_pid" 2>/dev/null; then
      log_line "Sending TERM to PID $target_pid"
      kill -TERM "$target_pid" 2>/dev/null || true
    else
      log_line "PID $target_pid was already stopped before TERM"
    fi

    remaining="$wait_seconds"
    while [ "$remaining" -gt 0 ] && kill -0 "$target_pid" 2>/dev/null; do
      sleep 1
      remaining=$((remaining - 1))
    done

    if kill -0 "$target_pid" 2>/dev/null; then
      if [ "$force_kill" = "1" ]; then
        log_line "TERM timed out after ${wait_seconds}s; sending KILL to PID $target_pid"
        kill -KILL "$target_pid" 2>/dev/null || true
        while kill -0 "$target_pid" 2>/dev/null; do
          sleep 1
        done
      else
        log_line "TERM timed out after ${wait_seconds}s; aborting restart because --force was not set"
        exit 1
      fi
    fi
  fi

  log_line "Restarting in $target_cwd: $target_command"
  cd "$target_cwd" || {
    log_line "Failed to cd into $target_cwd"
    exit 1
  }

  nohup /bin/zsh -lc "$target_command" >> "$log_file" 2>&1 < /dev/null &
  new_pid=$!
  log_line "Restarted with PID $new_pid"
 ' _ "$TARGET_PID" "$TARGET_CWD" "$TARGET_COMMAND" "$WAIT_SECONDS" "$HANDOFF_DELAY_SECONDS" "$LOG_FILE" "$FORCE_KILL" >/dev/null 2>&1 < /dev/null &

if [ "$COLD_START" -eq 1 ]; then
  echo "Queued cold start (no live runtime owner)"
else
  echo "Queued restart for PID $TARGET_PID"
fi
echo "cwd: $TARGET_CWD"
echo "command: $TARGET_COMMAND"
echo "log: $LOG_FILE"
