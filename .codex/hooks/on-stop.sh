#!/bin/bash
# Codex Hook: Stop
# Updates the kanban card with the final Codex response.

set -euo pipefail

KANBAN_API="${KANBAN_API_URL:-http://localhost:24680}"

resolve_data_dir() {
  if [ -n "${KANBAN_DATA_DIR:-}" ]; then
    printf '%s' "$KANBAN_DATA_DIR"
  elif [ -f "$HOME/.agent-kanban/active.json" ]; then
    printf '%s' "$HOME/.agent-kanban"
  else
    printf '%s' "$HOME/.agent-kanban"
  fi
}

json_get() {
  local filter="$1"
  echo "$HOOK_INPUT" | jq -r "$filter // empty" 2>/dev/null || true
}

KANBAN_DATA_DIR_RESOLVED="$(resolve_data_dir)"

# Local auth: send the .peer-token (written by the plugin/daemon at boot) as a
# Bearer header. Read fresh each run so a rotated token is picked up; stays empty
# (request fails closed with 401) if the server has not booted yet.
KANBAN_AUTH=()
if [ -f "${KANBAN_DATA_DIR_RESOLVED}/.peer-token" ]; then
  KANBAN_TOKEN="$(tr -d '[:space:]' < "${KANBAN_DATA_DIR_RESOLVED}/.peer-token" 2>/dev/null)"
  [ -n "$KANBAN_TOKEN" ] && KANBAN_AUTH=(-H "Authorization: Bearer ${KANBAN_TOKEN}")
fi
KANBAN_CURL_ARGS=(-sf)
if [ "${#KANBAN_AUTH[@]}" -gt 0 ]; then
  KANBAN_CURL_ARGS+=("${KANBAN_AUTH[@]}")
fi

HOOK_INPUT=$(cat)

# Runtime dispatches are owned by the adapter. Hooks only handle organic CLI use.
if [ -n "${AGENT_KANBAN_DISPATCH_CARD_ID:-}" ]; then
  exit 0
fi

SESSION_ID=$(json_get '.session_id // .sessionID // .sessionId // .id')
RESULT=$(json_get '.last_assistant_message // .lastAssistantMessage // .result // .message // .text')

if [ -z "$SESSION_ID" ]; then
  exit 0
fi

TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.codex-hooks"
TRACKING_FILE="${TRACKING_DIR}/${SESSION_ID}.card-id"

if [ ! -f "$TRACKING_FILE" ]; then
  exit 0
fi

CARD_ID=$(cat "$TRACKING_FILE")

if [ -z "$CARD_ID" ]; then
  exit 0
fi

curl "${KANBAN_CURL_ARGS[@]}" -X PATCH "${KANBAN_API}/api/cards/${CARD_ID}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg result "$RESULT" \
    '{
      status: "complete",
      result: $result
    }'
  )" >/dev/null 2>&1 || true

rm -f "$TRACKING_FILE"

exit 0
