#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# Belt-and-suspenders: re-export Bun path in case s6 resets the image ENV.
# Bun is required for Claude Code Channels plugins (e.g. Telegram).
export PATH="/opt/bun/bin:/root/.local/bin:${PATH}"

# CLAUDE_CONFIG_DIR is set via Dockerfile ENV — Claude reads all config from /data/.claude

# ── Credential check ─────────────────────────────────────────────────────────
if [[ ! -f "/data/.claude/.credentials.json" ]]; then
  bashio::log.warning "════════════════════════════════════════════════════"
  bashio::log.warning "Claude is not authenticated yet."
  bashio::log.warning ""
  bashio::log.warning "Open the Web UI tab of this add-on to get a terminal,"
  bashio::log.warning "then run:  claude auth login"
  bashio::log.warning ""
  bashio::log.warning "Complete the browser flow. The daemon will start"
  bashio::log.warning "automatically on the next retry (60 s)."
  bashio::log.warning "════════════════════════════════════════════════════"
  sleep 60
  exit 1
fi

bashio::log.info "Starting Claude Code daemon..."
bashio::log.info "  Remote Control: enabled (--remote-control)"
bashio::log.info "  Channels: telegram"
bashio::log.info "  Permissions: --permission-mode auto"
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

# Merge stderr into stdout so all output reaches the add-on log via s6
exec 2>&1
exec claude \
  --permission-mode auto \
  --remote-control \
  --channels "plugin:telegram@claude-plugins-official" \
  --mcp-config /data/.claude/mcp.json
