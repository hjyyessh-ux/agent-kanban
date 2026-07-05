#!/bin/bash
# Claude Code Hook: PostToolUse (matcher: Task)
# Marks the CHILD card complete with the subagent's final output when the Task returns.
# This is the only authoritative "subagent completed normally" signal — aborted/ESC'd
# subagents never reach here and are reconciled by the daemon's staleStatus sweep.
#
# Hook input (stdin JSON):
#   { session_id, tool_name:"Task", tool_use_id, agent_id?, duration_ms?, tool_response }
#   tool_response may be a string OR an array of content blocks ({type:"text", text}).
#
# Mirrors on-stop.sh conventions (no `set -e`; defensive `|| true`).

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

# Defensive: matcher already restricts to the subagent-spawn tool.
# Claude Code renamed this tool "Task" -> "Agent" (~2.1.x); accept both.
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty' 2>/dev/null) || true
if [ "$TOOL_NAME" != "Task" ] && [ "$TOOL_NAME" != "Agent" ]; then
  exit 0
fi

# Nested Task completion: no child card was created at spawn (start hook skips nested),
# so there is nothing to update here.
AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || true
if [ -n "$AGENT_ID" ]; then
  exit 0
fi

TOOL_USE_ID=$(echo "$HOOK_INPUT" | jq -r '.tool_use_id // empty' 2>/dev/null) || true
if [ -z "$TOOL_USE_ID" ]; then
  exit 0
fi

TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.claude-hooks"
TRACKING_FILE="${TRACKING_DIR}/subagent-${TOOL_USE_ID}.card-id"
if [ ! -f "$TRACKING_FILE" ]; then
  exit 0
fi
CHILD_CARD_ID=$(cat "$TRACKING_FILE" 2>/dev/null) || true
if [ -z "$CHILD_CARD_ID" ]; then
  rm -f "$TRACKING_FILE"
  exit 0
fi

# Deferred spawn: the Task/Agent tool returns IMMEDIATELY with a spawn
# acknowledgement rather than the real output. Two shapes occur:
#   anonymous background → { isAsync, status:"async_launched",  agentId,  resolvedModel }
#   named teammate        → { status:"teammate_spawned", agent_id, name, model }  (e.g.
#                            agent_id "NumOne@session-8f757aff")
# Completing the card here would stamp a ~0ms duration and the spawn ack as the result
# (and never capture the agent's message thread). Instead, hand off to the SubagentStop
# hook: record an agentId->cardId mapping so it can complete the card with the real last
# assistant message when the agent actually rests, backfill the model, and leave the card
# in_progress. (Synchronous Task calls in organic claude CLI carry the real result here
# and fall through to normal completion below.)
#
# The mapping key MUST match what SubagentStop reports as `agent_id`: anonymous spawns
# echo `agentId`, named teammates echo `agent_id` — try both.
#
# CORRELATION KEY (subtle): SubagentStop reports a DIFFERENT id than the spawn ack.
#   anonymous async  → spawn `agentId` == SubagentStop `agent_id` (same hex, e.g.
#                      "a089e4266e230100f"); key the mapping by that id.
#   named teammate    → spawn `agent_id` is "NumThree@session-8f757aff" but SubagentStop
#                      reports "aNumThree-<hex>" — they share ONLY the name. So key the
#                      mapping by NAME; the realstop hook re-derives the name from its
#                      agent_id ("a<Name>-<hex>") and looks it up.
SPAWN_JSON=$(echo "$HOOK_INPUT" | jq -c '.tool_response | if type=="object" then . elif type=="string" then (try fromjson catch {}) else {} end' 2>/dev/null) || SPAWN_JSON="{}"
SPAWN_STATUS=$(echo "$SPAWN_JSON" | jq -r '.status // ""' 2>/dev/null) || SPAWN_STATUS=""
SPAWN_AGENT_ID=$(echo "$SPAWN_JSON" | jq -r '.agentId // ""' 2>/dev/null) || SPAWN_AGENT_ID=""
SPAWN_NAME=$(echo "$SPAWN_JSON" | jq -r '.name // ""' 2>/dev/null) || SPAWN_NAME=""
MAP_KEY=""
if [ "$SPAWN_STATUS" = "async_launched" ] && [ -n "$SPAWN_AGENT_ID" ]; then
  MAP_KEY="subagent-agent-${SPAWN_AGENT_ID}"
elif [ "$SPAWN_STATUS" = "teammate_spawned" ] && [ -n "$SPAWN_NAME" ]; then
  MAP_KEY="subagent-name-${SPAWN_NAME}"
fi
if [ -n "$MAP_KEY" ]; then
  echo "$CHILD_CARD_ID" > "${TRACKING_DIR}/${MAP_KEY}.card-id"
  # anonymous async reports `resolvedModel`; named teammates report `model`.
  SPAWN_MODEL=$(echo "$SPAWN_JSON" | jq -r '.resolvedModel // .model // ""' 2>/dev/null) || SPAWN_MODEL=""
  if [ -n "$SPAWN_MODEL" ]; then
    curl -sf "${KANBAN_AUTH[@]}" -X PATCH "${KANBAN_API}/api/cards/${CHILD_CARD_ID}" \
      -H "Content-Type: application/json" \
      -d "$(jq -n --arg m "$SPAWN_MODEL" '{model:$m}')" >/dev/null 2>&1 || true
  fi
  rm -f "$TRACKING_FILE"
  exit 0
fi

# Flatten tool_response (string | content-block array | object) into plain text.
RESULT=$(echo "$HOOK_INPUT" | jq -r '
  (.tool_response // "")
  | if type == "string" then .
    elif type == "array" then ([ .[] | if type == "object" then (.text // .content // "") else (. | tostring) end ] | join("\n"))
    elif type == "object" then (.text // .content // (. | tostring))
    else (. | tostring) end
' 2>/dev/null) || RESULT=""

# Truncate to 10KB to avoid oversized payloads.
RESULT=$(printf '%s' "$RESULT" | head -c 10240)

# Build the PATCH payload; include durationMs only when the hook supplied a number.
PATCH_BODY=$(echo "$HOOK_INPUT" | jq \
  --arg result "$RESULT" \
  '{ status: "complete", result: $result }
   + ( if (.duration_ms | type) == "number" then { durationMs: .duration_ms } else {} end )' 2>/dev/null) || true
if [ -z "$PATCH_BODY" ]; then
  PATCH_BODY=$(jq -n --arg result "$RESULT" '{ status: "complete", result: $result }')
fi

curl -sf "${KANBAN_AUTH[@]}" -X PATCH "${KANBAN_API}/api/cards/${CHILD_CARD_ID}" \
  -H "Content-Type: application/json" \
  -d "$PATCH_BODY" >/dev/null 2>&1 || true

# Clean up tracking file.
rm -f "$TRACKING_FILE"

exit 0
