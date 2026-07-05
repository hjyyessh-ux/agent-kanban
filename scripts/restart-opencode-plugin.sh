#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

resolve_data_dir() {
  if [ -n "${KANBAN_DATA_DIR:-}" ]; then
    printf '%s' "$KANBAN_DATA_DIR"
  elif [ -d "$HOME/.agent-kanban" ]; then
    printf '%s' "$HOME/.agent-kanban"
  else
    printf '%s' "$HOME/.agent-kanban"
  fi
}

DATA_DIR="$(resolve_data_dir)"
PEERS_DIR="$DATA_DIR/peers"
LOCK_PATH="$DATA_DIR/.singleton-runtime.lock"
LOG_FILE="$DATA_DIR/restart-opencode-plugin.log"
WAIT_SECONDS=20
DRY_RUN=0
FORCE_KILL=0
ASSUME_YES=0
ALL_OPENCODE=0
NO_START=0
START_COMMAND=""
START_CWD=""

usage() {
  cat <<EOF
Usage: bash scripts/restart-opencode-plugin.sh [options]

Stop running agent-kanban plugin processes and start opencode again.

Options:
  --yes                 Do not prompt before stopping processes
  --dry-run             Print target pids and start command without changing anything
  --force               Send SIGKILL after timeout if SIGTERM does not stop a process
  --all-opencode        Also target generic opencode processes not found in kanban peer metadata
  --no-start            Stop target processes without starting a replacement
  --start-command CMD   Command used for the replacement process (default: detected command or opencode)
  --cwd PATH            Working directory for the replacement process (default: detected cwd or repo root)
  --data-dir PATH       Override kanban data dir (default: $DATA_DIR)
  --wait-seconds N      Seconds to wait after SIGTERM before optional SIGKILL (default: $WAIT_SECONDS)
  --log-file PATH       Log file for the restarted process (default: $LOG_FILE)
  --help                Show this help message
EOF
}

trim_whitespace() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

is_alive() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

current_pid() {
  printf '%s' "$$"
}

read_json_pids() {
  bun -e '
    import { existsSync, readdirSync, readFileSync } from "node:fs";
    import { join } from "node:path";

    const peersDir = process.argv[1];
    const lockPath = process.argv[2];
    const seen = new Set();

    function emit(pid, source, cwd = "") {
      if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) return;
      seen.add(pid);
      console.log([pid, source, cwd].join("\t"));
    }

    if (lockPath && existsSync(lockPath)) {
      try {
        const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
        emit(parsed.pid, "runtime-lock");
      } catch {
        // Ignore unreadable lock files.
      }
    }

    if (peersDir && existsSync(peersDir)) {
      for (const entry of readdirSync(peersDir)) {
        if (!entry.endsWith(".json")) continue;
        try {
          const parsed = JSON.parse(readFileSync(join(peersDir, entry), "utf8"));
          emit(parsed.pid, `peer:${parsed.instanceId ?? entry}`, parsed.cwd ?? "");
        } catch {
          // Ignore stale or partial peer records.
        }
      }
    }
  ' "$PEERS_DIR" "$LOCK_PATH"
}

read_ps_candidates() {
  local include_all_opencode="$1"
  ps -axo pid=,command= 2>/dev/null | awk -v include_all="$include_all_opencode" '
    /restart-opencode-plugin\.sh/ { next }
    /src\/plugin\/index\.ts/ { print $1 "\tps:dev-plugin\t"; next }
    /bun run dev:plugin/ { print $1 "\tps:dev-plugin\t"; next }
    /\.config\/opencode\/plugins\/agent-kanban\/index\.js/ { print $1 "\tps:installed-plugin\t"; next }
    /agent-kanban/ && /opencode/ { print $1 "\tps:agent-kanban-opencode\t"; next }
    include_all == "1" && /(^|[[:space:]\/])opencode([[:space:]]|$)/ { print $1 "\tps:opencode\t"; next }
  '
}

resolve_process_command() {
  local pid="$1"
  ps -p "$pid" -o command= 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' || true
}

resolve_process_cwd() {
  local pid="$1"
  local fallback="$2"

  if [ -n "$fallback" ]; then
    printf '%s' "$fallback"
    return 0
  fi

  if command -v lsof >/dev/null 2>&1; then
    local cwd
    cwd="$(lsof -a -d cwd -p "$pid" -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1 || true)"
    cwd="$(trim_whitespace "$cwd")"
    if [ -n "$cwd" ]; then
      printf '%s' "$cwd"
      return 0
    fi
  fi

  printf '%s' "$REPO_ROOT"
}

collect_targets() {
  {
    read_json_pids
    read_ps_candidates "$ALL_OPENCODE"
  } | awk -F '\t' '!seen[$1]++ { print $0 }'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE_KILL=1
      shift
      ;;
    --all-opencode)
      ALL_OPENCODE=1
      shift
      ;;
    --no-start)
      NO_START=1
      shift
      ;;
    --start-command)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --start-command" >&2
        exit 1
      fi
      START_COMMAND="$2"
      shift 2
      ;;
    --cwd)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --cwd" >&2
        exit 1
      fi
      START_CWD="$2"
      shift 2
      ;;
    --data-dir)
      if [ "$#" -lt 2 ]; then
        echo "Missing value for --data-dir" >&2
        exit 1
      fi
      DATA_DIR="$2"
      PEERS_DIR="$DATA_DIR/peers"
      LOCK_PATH="$DATA_DIR/.singleton-runtime.lock"
      LOG_FILE="$DATA_DIR/restart-opencode-plugin.log"
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
  echo "bun is required to parse kanban runtime metadata." >&2
  exit 1
fi

TARGET_ROWS=()
while IFS= read -r row; do
  TARGET_ROWS+=("$row")
done < <(collect_targets)
TARGET_PIDS=()
PRIMARY_PID=""
PRIMARY_CWD_HINT=""

for row in "${TARGET_ROWS[@]}"; do
  IFS=$'\t' read -r pid source cwd_hint <<<"$row"
  if ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    continue
  fi
  if [ "$pid" = "$(current_pid)" ] || ! is_alive "$pid"; then
    continue
  fi
  TARGET_PIDS+=("$pid")
  if [ -z "$PRIMARY_PID" ]; then
    PRIMARY_PID="$pid"
    PRIMARY_CWD_HINT="${cwd_hint:-}"
  fi
done

if [ -z "$START_COMMAND" ]; then
  if [ -n "$PRIMARY_PID" ]; then
    START_COMMAND="$(resolve_process_command "$PRIMARY_PID")"
  fi
  START_COMMAND="${START_COMMAND:-opencode}"
fi

if [ -z "$START_CWD" ]; then
  if [ -n "$PRIMARY_PID" ]; then
    START_CWD="$(resolve_process_cwd "$PRIMARY_PID" "$PRIMARY_CWD_HINT")"
  else
    START_CWD="$REPO_ROOT"
  fi
fi

echo "Data dir: $DATA_DIR"
echo "Log file: $LOG_FILE"
echo "Start cwd: $START_CWD"
echo "Start command: $START_COMMAND"

if [ "${#TARGET_PIDS[@]}" -eq 0 ]; then
  echo "No running agent-kanban plugin process found."
else
  echo "Target PIDs: ${TARGET_PIDS[*]}"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Proceed with restart? [y/N] '
  read -r answer
  case "$answer" in
    y|Y|yes|YES)
      ;;
    *)
      echo "Aborted."
      exit 1
      ;;
  esac
fi

for pid in "${TARGET_PIDS[@]}"; do
  if ! is_alive "$pid"; then
    continue
  fi
  echo "Sending SIGTERM to PID $pid"
  kill -TERM "$pid" 2>/dev/null || true
done

remaining="$WAIT_SECONDS"
while [ "$remaining" -gt 0 ]; do
  still_alive=0
  for pid in "${TARGET_PIDS[@]}"; do
    if is_alive "$pid"; then
      still_alive=1
      break
    fi
  done
  [ "$still_alive" -eq 0 ] && break
  sleep 1
  remaining=$((remaining - 1))
done

for pid in "${TARGET_PIDS[@]}"; do
  if ! is_alive "$pid"; then
    continue
  fi

  if [ "$FORCE_KILL" -eq 1 ]; then
    echo "SIGTERM timed out for PID $pid; sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  else
    echo "PID $pid is still running after ${WAIT_SECONDS}s. Use --force to SIGKILL it." >&2
    exit 1
  fi
done

if [ "$NO_START" -eq 1 ]; then
  echo "Stopped target processes. Replacement start skipped by --no-start."
  exit 0
fi

mkdir -p "$(dirname "$LOG_FILE")"
echo "Starting replacement process..."
(
  cd "$START_CWD"
  started_pid="$(/bin/zsh -lc "nohup $START_COMMAND >> '$LOG_FILE' 2>&1 < /dev/null & echo \$!; disown")"
  echo "Started PID $started_pid"
)
echo "Logs: $LOG_FILE"
