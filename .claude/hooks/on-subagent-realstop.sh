#!/bin/bash
# Claude Code Hook: SubagentStop
# Completes the CHILD card with the subagent's REAL final output when an async /
# background subagent actually finishes.
#
# Why this exists: in this runtime the Task/Agent tool launches subagents
# asynchronously and returns an {status:"async_launched", agentId} ack immediately,
# so PostToolUse(Task) cannot see the real result. on-subagent-stop.sh therefore
# records an agentId->cardId mapping and leaves the card in_progress; this hook
# closes the loop when the background agent comes to rest.
#
# Hook input (stdin JSON):
#   { session_id, agent_id, agent_type, hook_event_name:"SubagentStop",
#     last_assistant_message, stop_hook_active, ... }
#
# IMPORTANT: SubagentStop fires for EVERY session on this machine and fires once per
# agent REST (named teammates rest multiple times — after each turn). We match strictly
# by agent_id against a mapping file we wrote at launch — events for other sessions /
# non-deferred spawns have no mapping and are no-ops. The mapping is KEPT so every rest
# re-completes and re-captures the now-fuller transcript; completion + capture both
# replace (idempotent, not additive), converging on the final thread.
#
# Mirrors on-subagent-stop.sh conventions (no `set -e`; defensive `|| true`).

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

AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // empty' 2>/dev/null) || true
if [ -z "$AGENT_ID" ]; then
  exit 0
fi

# Match against the launch-time mapping written by on-subagent-stop.sh. Two key schemes
# (because SubagentStop reports a DIFFERENT id than the spawn ack):
#   anonymous async → agent_id is the same hex as the spawn `agentId` (e.g.
#                     "a089e4266e230100f"); look up subagent-agent-<id>.
#   named teammate  → agent_id is "a<Name>-<hex>" (e.g. "aNumThree-0b521c2ae9a07522")
#                     while the spawn keyed by NAME; derive the name and look up
#                     subagent-name-<Name>.
# No mapping (other session / non-tracked spawn) → no-op.
TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.claude-hooks"
MAP_FILE="${TRACKING_DIR}/subagent-agent-${AGENT_ID}.card-id"
if [ ! -f "$MAP_FILE" ]; then
  case "$AGENT_ID" in
    a*-*)
      _stripped="${AGENT_ID#a}"        # NumThree-0b521c2ae9a07522
      TEAMMATE_NAME="${_stripped%-*}"  # NumThree (strip trailing -<hex>)
      [ -n "$TEAMMATE_NAME" ] && MAP_FILE="${TRACKING_DIR}/subagent-name-${TEAMMATE_NAME}.card-id"
      ;;
  esac
fi
if [ ! -f "$MAP_FILE" ]; then
  exit 0
fi
CHILD_CARD_ID=$(cat "$MAP_FILE" 2>/dev/null) || true
if [ -z "$CHILD_CARD_ID" ]; then
  rm -f "$MAP_FILE"
  exit 0
fi

# The subagent's real final output.
RESULT=$(echo "$HOOK_INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null) || RESULT=""

curl -sf "${KANBAN_AUTH[@]}" -X PATCH "${KANBAN_API}/api/cards/${CHILD_CARD_ID}" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg result "$RESULT" '{ status: "complete", result: $result }')" >/dev/null 2>&1 || true

# Capture the inter-agent message thread from the subagent's OWN transcript:
# SubagentStop provides `agent_transcript_path` (the child's JSONL, distinct from
# the main `transcript_path`). Stream the raw file to the server, which parses the
# sent SendMessages + received coordinator messages into card.agentMessages. The
# server re-parses the whole file each time, so this is idempotent across repeat
# firings. Best-effort — never block child completion on it.
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.agent_transcript_path // empty' 2>/dev/null) || TRANSCRIPT_PATH=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  curl -sf "${KANBAN_AUTH[@]}" -X POST "${KANBAN_API}/api/cards/${CHILD_CARD_ID}/agent-thread" \
    -H "Content-Type: text/plain" \
    --data-binary "@${TRANSCRIPT_PATH}" >/dev/null 2>&1 || true
fi

# KEEP the mapping. Named teammates rest once PER TURN (e.g. after reporting their
# number, then again after the peer-verification exchange), firing SubagentStop each
# time — so every rest must re-complete the card and re-capture the now-fuller
# transcript. Both the completion PATCH and the agent-thread POST replace prior values,
# so repeat firings converge on the final thread (idempotent, not additive). The tiny
# mapping file is left behind intentionally, mirroring on-stop.sh's pending-* residue.
exit 0
