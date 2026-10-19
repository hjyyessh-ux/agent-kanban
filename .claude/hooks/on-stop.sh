#!/bin/bash
# Claude Code Hook: Stop
# Updates the kanban card with the full assistant text of the finished turn
# (all text blocks, not just the last message — see collect_turn_text).
# Hook input is received via stdin as JSON.

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

SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
LAST_MESSAGE=$(echo "$HOOK_INPUT" | jq -r '.last_assistant_message // empty')
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // empty')

# collect_turn_text <transcript.jsonl>: every assistant text block of the CURRENT turn, in order,
# joined by blank lines. The card result is a lossless task artifact, and `last_assistant_message`
# is only the LAST assistant text — a turn that answers, runs more tools, then answers again
# ("text → tool_use → text") would lose its first answer if we trusted that field alone.
#
# The current turn starts at the last real user prompt: a non-sidechain `user` entry whose content
# is a plain string, or a block array that has a `text` block and no `tool_result` block
# (tool results also arrive as `user` entries, but they do not start a turn). Sidechain (subagent)
# entries are skipped. Prints nothing on any parse problem so the caller falls back.
#
# Harness-injected `user` entries are NOT prompts and must not start a turn. The Claude Code
# harness records teammate / background-agent traffic as ordinary user entries:
#   "Another Claude session sent a message:\n<teammate-message …>"   (string content)
#   "<task-notification>…", "<agent-message …>", "<teammate-message …>" (string or text block)
# on-prompt.sh already refuses to mint a card for these; this filter is the SAME definition of
# "real prompt" on the Stop side. Without it a parent that received N teammate reports would
# collect only the text after the LAST report — the final synthesis would be cut down to its
# closing fragment (the 306-byte-result bug).
collect_turn_text() {
  local path="$1"
  [ -n "$path" ] && [ -f "$path" ] || return 0
  jq -n -r '
    def is_injected_text:
      type == "string"
      and (
        startswith("Another Claude session sent a message")
        or startswith("<task-notification>")
        or startswith("<agent-message")
        or startswith("<teammate-message")
      );
    def is_prompt:
      .type == "user"
      and ((.isSidechain // false) | not)
      and (
        (
          (.message.content | type) == "string"
          and ((.message.content | is_injected_text) | not)
        )
        or (
          (.message.content | type) == "array"
          and any(.message.content[]; .type == "text")
          and (any(.message.content[]; .type == "tool_result") | not)
          and (any(.message.content[]; .type == "text" and (.text | is_injected_text)) | not)
        )
      );
    [ inputs | select(.type == "user" or .type == "assistant") ] as $m
    | ([ $m | to_entries[] | select(.value | is_prompt) | .key ] | last // -1) as $start
    | [ $m[($start + 1):][]
        | select(.type == "assistant" and ((.isSidechain // false) | not))
        | .message.content[]?
        | select(.type == "text")
        | .text
        | select(type == "string" and length > 0)
      ]
    | join("\n\n")
  ' "$path" 2>/dev/null || true
}

RESULT=$(collect_turn_text "$TRANSCRIPT_PATH")
# Fall back to the harness field when the transcript yielded nothing (missing/unflushed file,
# unknown format) or does not even contain the harness's own final message — never regress
# below what `last_assistant_message` already provided.
if [ -z "$RESULT" ] || { [ -n "$LAST_MESSAGE" ] && [[ "$RESULT" != *"$LAST_MESSAGE"* ]]; }; then
  RESULT="$LAST_MESSAGE"
fi

TRACKING_DIR="${KANBAN_DATA_DIR_RESOLVED}/.claude-hooks"
TRACKING_FILE="${TRACKING_DIR}/${SESSION_ID}.card-id"

# complete_card <card-id> <result>: idempotently mark a card complete.
complete_card() {
  local cid="$1" result="$2"
  [ -z "$cid" ] && return 0
  curl "${KANBAN_CURL_ARGS[@]}" -X PATCH "${KANBAN_API}/api/cards/${cid}" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg result "$result" '{ status: "complete", result: $result }')" \
    >/dev/null 2>&1 || true
}

# card_has_live_children <parent-card-id>: succeeds (0) when at least one in_progress card
# is a DIRECT child of <parent-card-id>. This is the authoritative "work this card is still
# waiting on" signal: on-subagent-start.sh creates exactly one child card per spawned Task
# and the subagent hooks complete it when the agent rests, so an in_progress child means a
# background spawn of THIS card is genuinely still running.
#
# Fails CLOSED: an unreachable server or unparseable response returns success (→ treat as
# "has live children" → defer), so an unverifiable state never completes a card whose
# children might still be live.
card_has_live_children() {
  local parent="$1" body count
  [ -z "$parent" ] && return 0
  body=$(curl "${KANBAN_CURL_ARGS[@]}" "${KANBAN_API}/api/cards?status=in_progress" 2>/dev/null) || return 0
  count=$(printf '%s' "$body" | jq --arg p "$parent" '[.[] | select(.parentCardId == $p)] | length' 2>/dev/null) || return 0
  [ "${count:-0}" -gt 0 ] 2>/dev/null
}

# card_spawned_subagents <card-id>: succeeds (0) when this card created at least one subagent
# (on-subagent-start.sh drops a `<card-id>.has-subagents` marker at spawn). Used for the NAMED
# TEAMMATE case: a teammate rests after every turn, which flips its child card to `complete` with
# no hook to flip it back to in_progress on resume — so card_has_live_children goes false while
# the teammate is still alive. The marker tells the completion step below to PRESERVE the tracking
# file so later Stops re-complete the parent with the latest text (last-writer-wins). It is NOT a
# defer signal (see the guard below). Childless cards never get a marker, so plain prompts /
# scheduled wakeups are unaffected.
card_spawned_subagents() {
  local cid="$1"
  [ -z "$cid" ] && return 1
  [ -f "${TRACKING_DIR}/${cid}.has-subagents" ]
}

# The id of the card created for THIS turn (by on-prompt.sh), if any.
CURRENT_CARD_ID=""
if [ -f "$TRACKING_FILE" ]; then
  CURRENT_CARD_ID=$(cat "$TRACKING_FILE" 2>/dev/null || true)
fi

# Drain parents deferred by EARLIER background Stops for this session — and do it BEFORE
# the current turn's background check. A pending file is only ever written for a turn that
# has ALREADY ended (a later prompt has since overwritten the tracking file), so the
# parent's result was final at its own turn end and any background children track their
# own completion via the subagent hooks. Completing it now is therefore safe.
#
# Ordering matters: this drain must run unconditionally, not after the background-tasks
# early-exit below. A single long-lived background task (e.g. an idle named teammate that
# never self-terminates) keeps every subsequent Stop on the deferral path; if the drain
# sat after that early-exit it would never run, and deferred cards would leak in_progress
# forever (claude cards are not covered by the opencode-only stale sweep). That was the bug.
#
# The current turn's card is skipped here: it is only in the tracking file at this point,
# not yet stashed, and the explicit skip also guards a repeated Stop for the same card
# (which would otherwise complete it while its own background work is still live).
#
# A FORKED session (Claude Code `/fork`: the transcript is copied under a new session id, see
# on-prompt.sh) also drains the pending stash of the session it was forked from. The pending files
# are keyed by the ORIGINAL session id, so without this the fork's Stops could never close a parent
# the original deferred — and the original may never produce another Stop of its own.
DRAIN_SESSIONS=("$SESSION_ID")
FORKED_FROM_FILE="${TRACKING_DIR}/${SESSION_ID}.forked-from"
if [ -f "$FORKED_FROM_FILE" ]; then
  FORKED_FROM=$(tr -d '[:space:]' < "$FORKED_FROM_FILE" 2>/dev/null || true)
  [ -n "$FORKED_FROM" ] && [ "$FORKED_FROM" != "$SESSION_ID" ] && DRAIN_SESSIONS+=("$FORKED_FROM")
fi
for ds in "${DRAIN_SESSIONS[@]}"; do
  for pf in "${TRACKING_DIR}/${ds}.pending-"*; do
    [ -f "$pf" ] || continue
    PCID="${pf##*.pending-}"
    if [ -n "$CURRENT_CARD_ID" ] && [ "$PCID" = "$CURRENT_CARD_ID" ]; then
      continue
    fi
    PRESULT=$(cat "$pf" 2>/dev/null || true)
    complete_card "$PCID" "$PRESULT"
    rm -f "$pf"
  done
done

# Background-subagent guard for THIS turn's card: foreground Task calls are awaited, so by
# the time Stop fires every foreground child has already completed — the parent is safe to
# close. Background Task calls (run_in_background) are NOT awaited and surface in the Stop
# input's `background_tasks` field.
#
# CRUCIAL: `background_tasks` is SESSION-GLOBAL — it includes tasks that have nothing to do
# with this card, e.g. an idle/zombie named-teammate slot left over from a much earlier turn
# that the harness never reaped. Deferring on that count alone stranded cards that spawned
# NOTHING: a childless card (a plain prompt, a scheduled wakeup) would defer forever on the
# strength of someone else's lingering task and, being the current card, the drain loop above
# always skips it — leaving it stuck in_progress with no path to completion.
#
# So defer ONLY when this card has a live (in_progress) child of its OWN. `card_has_live_children`
# queries the store for direct children — the authoritative signal for background work THIS card
# is still awaiting — instead of trusting the noisy session-global count.
#
# When deferring we STASH the card id + final message in a pending file keyed by card id (a name
# on-prompt.sh never touches), because the per-session tracking file is overwritten by the NEXT
# prompt before any later Stop can close this card. The drain loop above (on a subsequent Stop)
# completes it. (Tail case: if the session never produces another Stop after this one, the pending
# file remains — acceptable, far better than a card stuck in_progress with no record of why.)
#
# Defer ONLY on an in_progress direct child. The has-subagents marker is deliberately NOT a defer
# signal on its own any more: a NAMED teammate stays in `background_tasks` as an idle process after
# its final report, so "marker + background_tasks>0" held for the rest of the session and the parent
# could only ever be closed by a later prompt replacing the tracking file — a parent whose teammates
# had all reported stayed in_progress indefinitely (the stuck-card bug). The marker still matters:
# it keeps the tracking file alive below, so when every teammate has rested at least once the parent
# completes NOW with this turn's text and every later Stop re-completes it (last-writer-wins) —
# an intermediate message is overwritten by the wrap-up instead of freezing the card. The trade-off
# (card flips to complete a turn or two early while teammates still chat) is accepted over a card
# that never completes at all.
BACKGROUND_TASKS=$(echo "$HOOK_INPUT" | jq -r '.background_tasks // [] | length' 2>/dev/null || echo 0)
if [ "${BACKGROUND_TASKS:-0}" -gt 0 ] 2>/dev/null \
   && [ -n "$CURRENT_CARD_ID" ] \
   && card_has_live_children "$CURRENT_CARD_ID"; then
  printf '%s' "$RESULT" > "${TRACKING_DIR}/${SESSION_ID}.pending-${CURRENT_CARD_ID}" 2>/dev/null || true
  exit 0
fi

# Background-free Stop: close this turn's card and clear any stale pending stash for it.
if [ -n "$CURRENT_CARD_ID" ]; then
  complete_card "$CURRENT_CARD_ID" "$RESULT"
  rm -f "${TRACKING_DIR}/${SESSION_ID}.pending-${CURRENT_CARD_ID}" 2>/dev/null || true

  # Re-convergence (last-writer-wins): a card that spawned subagents keeps receiving Stops as its
  # named teammates rest/resume and as their inter-agent messages drive further main-session turns.
  # PRESERVE its tracking file so each later Stop re-completes the card with the now-latest assistant
  # message — the final turn (e.g. the wrap-up summary) wins, instead of the card freezing on whatever
  # intermediate message first slipped past the defer guard. (Mirrors on-subagent-realstop.sh keeping
  # its mapping and re-completing children on every rest.) The preserved file is overwritten by
  # on-prompt.sh on the next real prompt, or left as harmless residue at session end. A childless card
  # sees no further Stops for itself, so its tracking file is cleared immediately as before.
  if ! card_spawned_subagents "$CURRENT_CARD_ID"; then
    rm -f "$TRACKING_FILE"
  fi
fi

exit 0
