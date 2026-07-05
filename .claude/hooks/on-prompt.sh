#!/bin/bash
# Claude Code Hook: UserPromptSubmit
# Creates a kanban card when user submits a prompt.
# Hook input is received via stdin as JSON with { session_id, cwd, prompt, ... }

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

SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null) || true
CWD=$(echo "$HOOK_INPUT" | jq -r '.cwd // empty' 2>/dev/null) || true
PROMPT=$(echo "$HOOK_INPUT" | jq -r '.prompt // empty' 2>/dev/null) || true

# Guard: opencode sessions use ses_* ids and already create cards through the
# plugin chat.message hook. Skip Claude-side card creation to avoid duplicates.
if [[ "$SESSION_ID" == ses_* ]]; then
  exit 0
fi

# Guard (Claude-specific): the Claude Code harness re-fires UserPromptSubmit with
# synthetic, machine-injected prompts that are NOT real user turns:
#   <task-notification>  — a background subagent came to rest
#   <agent-message ...>  — a message from another agent/teammate
#   <teammate-message …> — teammate status (e.g. idle_notification) / coordination
# Treating any of these as a prompt spawns a junk parent card AND overwrites this
# session's parent tracking file, so a subagent spawned afterward links to the junk
# card instead of the real prompt — splitting a fan-out across parents and leaving the
# real parent stuck in_progress. These marker tags are Claude harness conventions;
# other runtimes (e.g. codex) inject differently, which is why this filter lives only
# in the Claude adapter hook.
case "$PROMPT" in
  '<task-notification>'*|'<agent-message'*|'<teammate-message'*) exit 0 ;;
esac

# Model: global settings → project settings → current session JSONL → recent session JSONL
MODEL=$(jq -r '.model // empty' "$HOME/.claude/settings.json" 2>/dev/null) || true
if [ -z "$MODEL" ] && [ -n "$CWD" ]; then
  MODEL=$(jq -r '.model // empty' "${CWD}/.claude/settings.json" 2>/dev/null) || true
fi
if [ -z "$MODEL" ] && [ -n "$SESSION_ID" ] && [ -n "$CWD" ]; then
  ENCODED_CWD=$(echo "$CWD" | tr '/' '-')
  SESSIONS_DIR="$HOME/.claude/projects/${ENCODED_CWD}"
  # Try current session first (works from 2nd prompt onward)
  SESSION_JSONL="${SESSIONS_DIR}/${SESSION_ID}.jsonl"
  if [ -f "$SESSION_JSONL" ]; then
    MODEL=$(grep -o '"model":"[^"]*"' "$SESSION_JSONL" 2>/dev/null | head -1 | cut -d'"' -f4) || true
  fi
  # Fall back to most recent other session in same project
  if [ -z "$MODEL" ] && [ -d "$SESSIONS_DIR" ]; then
    MODEL=$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | xargs -I{} grep -l '"model"' "{}" 2>/dev/null | head -1 | xargs grep -o '"model":"[^"]*"' 2>/dev/null | head -1 | cut -d'"' -f4) || true
  fi
fi

# Fallback title if prompt is empty
if [ -z "$PROMPT" ]; then
  PROMPT="Claude Code session"
fi

# Truncate title to 120 chars
TITLE=$(echo "$PROMPT" | head -c 120 | tr '\n' ' ')

# Create card via kanban API
RESPONSE=$(curl -sf "${KANBAN_AUTH[@]}" -X POST "${KANBAN_API}/api/cards" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg title "$TITLE" \
    --arg description "$PROMPT" \
    --arg sessionId "$SESSION_ID" \
    --arg projectDir "$CWD" \
    --arg sourceContext "claude-code" \
    --arg model "$MODEL" \
    '{
      title: $title,
      description: $description,
      sessionId: $sessionId,
      projectDir: $projectDir,
      sourceContext: $sourceContext,
      agentRuntime: "claude",
      model: (if $model != "" then $model else null end)
    }'
  )" 2>/dev/null) || exit 0

# Save card ID for the Stop hook to pick up
CARD_ID=$(echo "$RESPONSE" | jq -r '.id // empty' 2>/dev/null) || true
if [ -n "$CARD_ID" ] && [ -n "$SESSION_ID" ]; then
  TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.claude-hooks"
  mkdir -p "$TRACKING_DIR"
  echo "$CARD_ID" > "${TRACKING_DIR}/${SESSION_ID}.card-id"
fi

# Immediately mark as in_progress
if [ -n "$CARD_ID" ]; then
  curl -sf "${KANBAN_AUTH[@]}" -X PATCH "${KANBAN_API}/api/cards/${CARD_ID}" \
    -H "Content-Type: application/json" \
    -d '{"status":"in_progress"}' >/dev/null 2>&1 || true
fi

exit 0
