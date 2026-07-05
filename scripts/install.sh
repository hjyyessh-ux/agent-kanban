#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PLUGIN_DIR="$HOME/.config/opencode/plugins/agent-kanban"
GLOBAL_OPENCODE_CONFIG="$HOME/.config/opencode/opencode.json"
GLOBAL_CLAUDE_SETTINGS="$HOME/.claude/settings.json"
GLOBAL_CODEX_HOOKS="$HOME/.codex/hooks.json"
HOOKS_INSTALL_DIR="$HOME/.agent-kanban/hooks"
CODEX_HOOKS_INSTALL_DIR="$HOME/.agent-kanban/codex-hooks"
DAEMON_PATH_FILE="$HOME/.agent-kanban/daemon-project-path"

# ── Uninstall ──────────────────────────────────────────────────────────────────
if [ "${1:-}" = "--uninstall" ]; then
  echo "Uninstalling Claude Code and Codex hooks..."

  if [ -f "$GLOBAL_CLAUDE_SETTINGS" ] && command -v jq &>/dev/null; then
    tmp=$(mktemp)
    jq '
      if .hooks then
        .hooks |= with_entries(
          .value = [.value[]? | select(
            (.hooks[]?.command // "") | test("agent-kanban") | not
          )]
        )
      else . end
    ' "$GLOBAL_CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$GLOBAL_CLAUDE_SETTINGS"
    echo "Removed kanban hooks from $GLOBAL_CLAUDE_SETTINGS"
  fi

  if [ -f "$GLOBAL_CODEX_HOOKS" ] && command -v jq &>/dev/null; then
    tmp=$(mktemp)
    jq '
      def as_array:
        if type == "array" then . else [.] end;
      def command_matches($pattern):
        if type == "string" then test($pattern)
        elif type == "object" then ((.command // "") | test($pattern))
        else false end;
      def remove_matching_hooks($pattern):
        .hooks = (.hooks // {}) |
        .hooks |= with_entries(
          .value = [
            (.value | as_array | .[]?)
            | if type == "object" and has("hooks") then
                .hooks = [
                  .hooks[]?
                  | select((((.command // "") | test($pattern)) | not))
                ]
                | select((.hooks | length) > 0)
              else
                select((command_matches($pattern)) | not)
              end
          ]
        );
      if .hooks then
        remove_matching_hooks("agent-kanban")
      else . end
    ' "$GLOBAL_CODEX_HOOKS" > "$tmp" && mv "$tmp" "$GLOBAL_CODEX_HOOKS"
    echo "Removed kanban hooks from $GLOBAL_CODEX_HOOKS"
  fi

  rm -rf "$HOOKS_INSTALL_DIR"
  rm -rf "$CODEX_HOOKS_INSTALL_DIR"
  rm -f "$DAEMON_PATH_FILE"
  echo "✅ Claude Code and Codex hooks uninstalled."
  echo "   Restart Claude Code and Codex to apply changes."
  exit 0
fi

# ── Build ──────────────────────────────────────────────────────────────────────
echo "Building agent-kanban plugin..."
bun run build

# ── opencode plugin install ────────────────────────────────────────────────────
echo "Installing opencode plugin to $PLUGIN_DIR..."
mkdir -p "$PLUGIN_DIR"
cp -r dist/plugin/index.js "$PLUGIN_DIR/"
cp -r web/dist "$PLUGIN_DIR/web"

echo "Updating global opencode config..."
PLUGIN_ENTRY="$PLUGIN_DIR/index.js"
if [ -f "$GLOBAL_OPENCODE_CONFIG" ]; then
  if command -v jq &>/dev/null; then
    tmp=$(mktemp)
    jq --arg p "$PLUGIN_ENTRY" '
      .plugin = ((.plugin // [])
        | map(select(. != $p))
        | . + [$p])
    ' "$GLOBAL_OPENCODE_CONFIG" > "$tmp" && mv "$tmp" "$GLOBAL_OPENCODE_CONFIG"
  else
    if grep -q "$PLUGIN_ENTRY" "$GLOBAL_OPENCODE_CONFIG" 2>/dev/null; then
      echo "Plugin already registered in $GLOBAL_OPENCODE_CONFIG"
    else
      if grep -q '"plugin"' "$GLOBAL_OPENCODE_CONFIG" 2>/dev/null; then
        sed -i.bak 's|\("plugin"[[:space:]]*:[[:space:]]*\[.*\)\]|\1, "'"$PLUGIN_ENTRY"'"]|' "$GLOBAL_OPENCODE_CONFIG"
        rm -f "${GLOBAL_OPENCODE_CONFIG}.bak"
      else
        sed -i.bak 's|^{|{"plugin": ["'"$PLUGIN_ENTRY"'"],|' "$GLOBAL_OPENCODE_CONFIG"
        rm -f "${GLOBAL_OPENCODE_CONFIG}.bak"
      fi
    fi
  fi
  echo "Plugin registered in $GLOBAL_OPENCODE_CONFIG"
else
  mkdir -p "$(dirname "$GLOBAL_OPENCODE_CONFIG")"
  echo '{"plugin": ["'"$PLUGIN_ENTRY"'"]}' > "$GLOBAL_OPENCODE_CONFIG"
  echo "Created $GLOBAL_OPENCODE_CONFIG with plugin entry"
fi

# ── Claude Code hooks install ──────────────────────────────────────────────────
echo "Installing Claude Code hooks..."

mkdir -p "$HOOKS_INSTALL_DIR"
cp "${PROJECT_DIR}/.claude/hooks/on-session-start.sh" "$HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.claude/hooks/on-prompt.sh" "$HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.claude/hooks/on-stop.sh" "$HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.claude/hooks/on-subagent-start.sh" "$HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.claude/hooks/on-subagent-stop.sh" "$HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.claude/hooks/on-subagent-realstop.sh" "$HOOKS_INSTALL_DIR/"
chmod +x "$HOOKS_INSTALL_DIR/"*.sh
echo "Hook scripts installed to $HOOKS_INSTALL_DIR"

# ── Codex hooks install ───────────────────────────────────────────────────────
echo "Installing Codex hooks..."

mkdir -p "$CODEX_HOOKS_INSTALL_DIR"
cp "${PROJECT_DIR}/.codex/hooks/on-session-start.sh" "$CODEX_HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.codex/hooks/on-prompt.sh" "$CODEX_HOOKS_INSTALL_DIR/"
cp "${PROJECT_DIR}/.codex/hooks/on-stop.sh" "$CODEX_HOOKS_INSTALL_DIR/"
chmod +x "$CODEX_HOOKS_INSTALL_DIR/"*.sh
echo "Codex hook scripts installed to $CODEX_HOOKS_INSTALL_DIR"

# Record project path so on-session-start.sh can find the daemon
mkdir -p "$(dirname "$DAEMON_PATH_FILE")"
echo "$PROJECT_DIR" > "$DAEMON_PATH_FILE"
echo "Daemon project path recorded: $PROJECT_DIR"

# Register hooks in global Claude Code settings
if ! command -v jq &>/dev/null; then
  echo "⚠️  jq not found — skipping $GLOBAL_CLAUDE_SETTINGS update. Install jq and re-run."
else
  mkdir -p "$(dirname "$GLOBAL_CLAUDE_SETTINGS")"
  [ -f "$GLOBAL_CLAUDE_SETTINGS" ] || echo '{}' > "$GLOBAL_CLAUDE_SETTINGS"

  tmp=$(mktemp)
  jq \
    --arg hook_pattern "agent-kanban/hooks" \
    --arg session_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $HOOKS_INSTALL_DIR/on-session-start.sh" \
    --arg prompt_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $HOOKS_INSTALL_DIR/on-prompt.sh" \
    --arg stop_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $HOOKS_INSTALL_DIR/on-stop.sh" \
    --arg subagent_start_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $HOOKS_INSTALL_DIR/on-subagent-start.sh" \
    --arg subagent_stop_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $HOOKS_INSTALL_DIR/on-subagent-stop.sh" \
    --arg subagent_realstop_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $HOOKS_INSTALL_DIR/on-subagent-realstop.sh" '
    def remove_matching_hooks($pattern):
      .hooks = (.hooks // {}) |
      .hooks |= with_entries(
        .value = [
          .value[]?
          | .hooks = [
              .hooks[]?
              | select(((.command // "") | test($pattern)) | not)
            ]
          | select((.hooks | length) > 0)
        ]
      );
    remove_matching_hooks($hook_pattern) |
    .hooks.SessionStart = ((.hooks.SessionStart // []) + [{"hooks": [{"type": "command", "command": $session_cmd, "timeout": 15}]}]) |
    .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + [{"hooks": [{"type": "command", "command": $prompt_cmd, "timeout": 30}]}]) |
    .hooks.Stop = ((.hooks.Stop // []) + [{"hooks": [{"type": "command", "command": $stop_cmd, "timeout": 30}]}]) |
    .hooks.PreToolUse = ((.hooks.PreToolUse // []) + [{"matcher": "Task|Agent", "hooks": [{"type": "command", "command": $subagent_start_cmd, "timeout": 15}]}]) |
    .hooks.PostToolUse = ((.hooks.PostToolUse // []) + [{"matcher": "Task|Agent", "hooks": [{"type": "command", "command": $subagent_stop_cmd, "timeout": 15}]}]) |
    .hooks.SubagentStop = ((.hooks.SubagentStop // []) + [{"hooks": [{"type": "command", "command": $subagent_realstop_cmd, "timeout": 15}]}])
  ' "$GLOBAL_CLAUDE_SETTINGS" > "$tmp" && mv "$tmp" "$GLOBAL_CLAUDE_SETTINGS"
  echo "Claude Code hooks registered in $GLOBAL_CLAUDE_SETTINGS"
fi

# Register hooks in global Codex hooks config
if ! command -v jq &>/dev/null; then
  echo "⚠️  jq not found — skipping $GLOBAL_CODEX_HOOKS update. Install jq and re-run."
else
  mkdir -p "$(dirname "$GLOBAL_CODEX_HOOKS")"
  [ -f "$GLOBAL_CODEX_HOOKS" ] || echo '{}' > "$GLOBAL_CODEX_HOOKS"

  tmp=$(mktemp)
  jq \
    --arg hook_pattern "agent-kanban/codex-hooks" \
    --arg session_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $CODEX_HOOKS_INSTALL_DIR/on-session-start.sh" \
    --arg prompt_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $CODEX_HOOKS_INSTALL_DIR/on-prompt.sh" \
    --arg stop_cmd "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\"; $CODEX_HOOKS_INSTALL_DIR/on-stop.sh" '
    def as_array:
      if type == "array" then . else [.] end;
    def command_matches($pattern):
      if type == "string" then test($pattern)
      elif type == "object" then ((.command // "") | test($pattern))
      else false end;
    def remove_matching_hooks($pattern):
      .hooks = (.hooks // {}) |
      .hooks |= with_entries(
        .value = [
          (.value | as_array | .[]?)
          | if type == "object" and has("hooks") then
              .hooks = [
                .hooks[]?
                | select(((.command // "") | test($pattern)) | not)
              ]
              | select((.hooks | length) > 0)
            else
              select((command_matches($pattern)) | not)
            end
        ]
      );
    # Codex hook config uses CamelCase event names and command handler groups.
    remove_matching_hooks($hook_pattern) |
    .hooks.SessionStart = ((.hooks.SessionStart // []) + [{"hooks": [{"type": "command", "command": $session_cmd, "timeout": 15}]}]) |
    .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) + [{"hooks": [{"type": "command", "command": $prompt_cmd, "timeout": 30}]}]) |
    .hooks.Stop = ((.hooks.Stop // []) + [{"hooks": [{"type": "command", "command": $stop_cmd, "timeout": 30}]}])
  ' "$GLOBAL_CODEX_HOOKS" > "$tmp" && mv "$tmp" "$GLOBAL_CODEX_HOOKS"
  echo "Codex hooks registered in $GLOBAL_CODEX_HOOKS"
fi

echo ""
echo "✅ agent-kanban installed successfully!"
echo "   • opencode: restart opencode to activate the plugin"
echo "   • Claude Code: restart Claude Code to activate hooks"
echo "   • Codex: restart Codex to activate hooks"
