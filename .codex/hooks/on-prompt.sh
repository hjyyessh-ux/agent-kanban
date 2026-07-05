#!/bin/bash
# Codex Hook: UserPromptSubmit
# Creates a kanban card when the user submits a Codex prompt.
# Hook input is received via stdin as JSON.

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

codex_config_model() {
  awk -F '"' '/^model[[:space:]]*=/{ print $2; exit }' "$HOME/.codex/config.toml" 2>/dev/null || true
}

codex_thread_model() {
  local session_id="$1"
  local db="$HOME/.codex/state_5.sqlite"
  if [ -z "$session_id" ] || [ ! -f "$db" ] || ! command -v sqlite3 >/dev/null 2>&1; then
    return 0
  fi
  local escaped_session_id="${session_id//\'/\'\'}"
  sqlite3 "$db" "select coalesce(model, '') from threads where id = '$escaped_session_id' limit 1;" 2>/dev/null || true
}

json_get() {
  local filter="$1"
  echo "$HOOK_INPUT" | jq -r "$filter // empty" 2>/dev/null || true
}

KANBAN_DATA_DIR_RESOLVED="$(resolve_data_dir)"

# Local auth: the plugin/daemon writes a token to .peer-token at boot. Mutating
# endpoints require it as an Authorization: Bearer header. Read it fresh each run
# so a rotated token is picked up automatically; the array stays empty (requests
# fail closed with 401) if the server has not booted yet.
KANBAN_AUTH=()
if [ -f "${KANBAN_DATA_DIR_RESOLVED}/.peer-token" ]; then
  KANBAN_TOKEN="$(tr -d '[:space:]' < "${KANBAN_DATA_DIR_RESOLVED}/.peer-token" 2>/dev/null)"
  [ -n "$KANBAN_TOKEN" ] && KANBAN_AUTH=(-H "Authorization: Bearer ${KANBAN_TOKEN}")
fi

HOOK_INPUT=$(cat)

# Runtime dispatches are owned by the adapter. Hooks only handle organic CLI use.
if [ -n "${AGENT_KANBAN_DISPATCH_CARD_ID:-}" ]; then
  exit 0
fi

# Internal wiki worker one-shots set this. Never turn them into board cards.
if [ -n "${AGENT_KANBAN_WIKI_INTERNAL:-}" ]; then
  exit 0
fi

SESSION_ID=$(json_get '.session_id // .sessionID // .sessionId // .id')
CWD=$(json_get '.cwd // .directory // .workspace // .projectDir')
PROMPT=$(json_get '.prompt // .input // .message // .text')
MODEL=$(json_get '.model // .model_id // .modelID')

if [ -z "$MODEL" ]; then
  MODEL=$(codex_thread_model "$SESSION_ID")
fi
if [ -z "$MODEL" ]; then
  MODEL=$(codex_config_model)
fi

if [ -z "$PROMPT" ]; then
  PROMPT="Codex session"
fi

TITLE=$(echo "$PROMPT" | head -c 120 | tr '\n' ' ')

RESPONSE=$(curl -sf "${KANBAN_AUTH[@]}" -X POST "${KANBAN_API}/api/cards" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg title "$TITLE" \
    --arg description "$PROMPT" \
    --arg sessionId "$SESSION_ID" \
    --arg projectDir "$CWD" \
    --arg sourceContext "codex" \
    --arg model "$MODEL" \
    '{
      title: $title,
      description: $description,
      sessionId: (if $sessionId != "" then $sessionId else null end),
      projectDir: (if $projectDir != "" then $projectDir else null end),
      sourceContext: $sourceContext,
      agentRuntime: "codex",
      model: (if $model != "" then $model else null end)
    }'
  )" 2>/dev/null) || exit 0

CARD_ID=$(echo "$RESPONSE" | jq -r '.id // empty' 2>/dev/null) || true
if [ -n "$CARD_ID" ] && [ -n "$SESSION_ID" ]; then
  TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.codex-hooks"
  mkdir -p "$TRACKING_DIR"
  echo "$CARD_ID" > "${TRACKING_DIR}/${SESSION_ID}.card-id"
fi

if [ -n "$CARD_ID" ]; then
  curl -sf "${KANBAN_AUTH[@]}" -X PATCH "${KANBAN_API}/api/cards/${CARD_ID}" \
    -H "Content-Type: application/json" \
    -d '{"status":"in_progress"}' >/dev/null 2>&1 || true
fi

exit 0
