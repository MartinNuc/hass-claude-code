#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# Belt-and-suspenders: re-export tool paths in case s6 resets the image ENV.
# Bun and uv must be on PATH for channel plugins and hass-mcp at runtime
export PATH="/opt/bun/bin:/opt/uv/bin:/root/.local/bin:${PATH}"

# CLAUDE_CONFIG_DIR is set via Dockerfile ENV — Claude reads all config from /data/.claude

bashio::log.info "Starting Claude Code daemon..."
bashio::log.info "  Remote Control: enabled (--remote-control)"
bashio::log.info "  Channels: telegram"
bashio::log.info "  Permissions: --dangerously-skip-permissions"
bashio::log.info ""
bashio::log.info "FIRST TIME SETUP — if Telegram channel is not working:"
bashio::log.info "  1. Connect via Remote Control at claude.ai/code"
bashio::log.info "  2. Run: /plugin install telegram@claude-plugins-official"
bashio::log.info "  3. Run: /reload-plugins"
bashio::log.info "  4. Restart this add-on"
bashio::log.info "  5. Message your Telegram bot to get a pairing code"
bashio::log.info "  6. In Remote Control: /telegram:access pair <code>"
bashio::log.info "  7. In Remote Control: /telegram:access policy allowlist"

# If the Telegram plugin is not yet installed, Claude starts normally but logs
# that the channel could not register. Install it via Remote Control (steps above)
# and restart the add-on — it persists in /data/.claude/plugins/.

# autonomy_mode=auto (always): --dangerously-skip-permissions is unconditional by design.
# Safety is provided by: container isolation, scoped HA token, git-backed HA config.

# Merge stderr into stdout so all output reaches the add-on log via s6
exec 2>&1
exec claude \
  --dangerously-skip-permissions \
  --remote-control \
  --channels "plugin:telegram@claude-plugins-official"
