#!/bin/bash
# Claude Code Hook: PreToolUse (matcher: Task)
# Creates a CHILD kanban card when the main agent spawns a subagent via the Task tool,
# linked to the parent card (created by on-prompt.sh) through parentCardId.
#
# Hook input (stdin JSON):
#   { session_id, cwd, tool_name:"Task", tool_use_id,
#     agent_id?,                       # present ONLY inside a subagent (nested Task)
#     tool_input: { prompt, subagent_type, description, model } }
#
# Mirrors on-prompt.sh conventions (no `set -e`; defensive `|| true`).

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

KANBAN_DATA_DIR_RESOLVED="$(resolve_data_dir)"

# Local auth: send the .peer-token (written by the plugin/daemon at boot) as a Bearer
# header. Read fresh each run so a rotated token is picked up; stays empty (request
# fails closed with 401) if the server has not booted yet.
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

# Defensive: the matcher already restricts to the subagent-spawn tool, but double-check.
# Claude Code renamed this tool "Task" -> "Agent" (~2.1.x); accept both for cross-version
# compatibility.
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
if [ "$TOOL_NAME" != "Task" ] && [ "$TOOL_NAME" != "Agent" ]; then
  exit 0
fi

# Nested Task (Task spawned from inside a subagent): agent_id is present only inside a
# subagent context. v1 policy = skip nested spawns (flatten). The parentCardId schema
# already models an arbitrary-depth tree, so this can be upgraded to true nesting later
# (agent_id → card mapping) without any data migration.
AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || true
if [ -n "$AGENT_ID" ]; then
  exit 0
fi

SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true
TOOL_USE_ID=$(echo "$HOOK_INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null) || true
CWD=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null) || true

# opencode sessions (ses_*) already create cards through the plugin chat.message hook.
if [[ "$SESSION_ID" == ses_* ]]; then
  exit 0
fi

# Without a tool_use_id we cannot match the PostToolUse completion later — skip.
if [ -z "$TOOL_USE_ID" ]; then
  exit 0
fi

# Resolve the parent card created by on-prompt.sh for this session. No parent card →
# skip (never create orphan child cards).
TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.claude-hooks"
PARENT_FILE="${TRACKING_DIR}/${SESSION_ID}.card-id"
if [ ! -f "$PARENT_FILE" ]; then
  exit 0
fi
PARENT_CARD_ID=$(cat "$PARENT_FILE" 2>/dev/null) || true
if [ -z "$PARENT_CARD_ID" ]; then
  exit 0
fi

PROMPT=$(echo "$HOOK_INPUT" | jq -r '.tool_input.prompt // empty' 2>/dev/null) || true
SUBAGENT_TYPE=$(echo "$HOOK_INPUT" | jq -r '.tool_input.subagent_type // empty' 2>/dev/null) || true
DESCRIPTION=$(echo "$HOOK_INPUT" | jq -r '.tool_input.description // empty' 2>/dev/null) || true
MODEL=$(echo "$HOOK_INPUT" | jq -r '.tool_input.model // empty' 2>/dev/null) || true

# Title: prefer the short description, fall back to the prompt.
TITLE="$DESCRIPTION"
if [ -z "$TITLE" ]; then TITLE="$PROMPT"; fi
if [ -z "$TITLE" ]; then TITLE="subagent task"; fi
TITLE=$(echo "$TITLE" | head -c 120 | tr '\n' ' ')

# Body (description is required by POST /api/cards): full spawn prompt.
BODY="$PROMPT"
if [ -z "$BODY" ]; then BODY="$TITLE"; fi

# Create the child card via the kanban API.
RESPONSE=$(curl -sf "${KANBAN_AUTH[@]}" -X POST "${KANBAN_API}/api/cards" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg title "$TITLE" \
    --arg description "$BODY" \
    --arg sessionId "$SESSION_ID" \
    --arg projectDir "$CWD" \
    --arg parentCardId "$PARENT_CARD_ID" \
    --arg agentType "$SUBAGENT_TYPE" \
    --arg model "$MODEL" \
    '{
      title: $title,
      description: $description,
      sessionId: $sessionId,
      projectDir: $projectDir,
      parentCardId: $parentCardId,
      sourceContext: "claude-code",
      agentRuntime: "claude",
      agentType: (if $agentType != "" then $agentType else null end),
      model: (if $model != "" then $model else null end)
    }'
  )" 2>/dev/null) || exit 0

CHILD_CARD_ID=$(echo "$RESPONSE" | jq -r '.id // empty' 2>/dev/null) || true
if [ -n "$CHILD_CARD_ID" ]; then
  mkdir -p "$TRACKING_DIR"
  # Key the tracking file by tool_use_id — the same id arrives in PostToolUse, so the
  # completion matches even when the parent fans out multiple subagents in parallel.
  echo "$CHILD_CARD_ID" > "${TRACKING_DIR}/subagent-${TOOL_USE_ID}.card-id"

  # Marker (keyed by PARENT card id): "this card spawned at least one subagent". on-stop.sh
  # reads it to keep the parent alive while a NAMED TEAMMATE is merely resting. A resting
  # teammate's child card flips to `complete` (on-subagent-realstop fires on every rest and
  # nothing flips it back to in_progress on resume), so the parent's in_progress-child query
  # goes false and the parent would otherwise complete prematurely on an intermediate message.
  # The marker also tells on-stop.sh to preserve the parent's tracking file so later Stops keep
  # re-completing it (last-writer-wins → the final turn's message wins). Childless cards never
  # get this marker, so plain prompts / scheduled wakeups are unaffected.
  touch "${TRACKING_DIR}/${PARENT_CARD_ID}.has-subagents" 2>/dev/null || true

  # Immediately mark as in_progress (createCard defaults new cards to todo).
  curl -sf "${KANBAN_AUTH[@]}" -X PATCH "${KANBAN_API}/api/cards/${CHILD_CARD_ID}" \
    -H "Content-Type: application/json" \
    -d '{"status":"in_progress"}' >/dev/null 2>&1 || true
fi

exit 0
