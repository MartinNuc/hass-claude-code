#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

export PATH="/opt/bun/bin:/root/.local/bin:${PATH}"

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
bashio::log.info "  Remote Control: enabled — connect at claude.ai/code or Claude mobile app"
bashio::log.info "  Session name: Home Assistant"
bashio::log.info "  Permission mode: auto"

# Run claude via node-pty so it sees a TTY and enters interactive mode.
exec 2>&1
exec node /app/claude-daemon.js
