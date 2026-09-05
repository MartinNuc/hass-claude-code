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

# Shown as this host's name in the Remote Control list at claude.ai/code.
# claude-daemon.js applies the same fallback if this is blank.
SESSION_NAME="Home Assistant"
if bashio::config.has_value 'session_name'; then
  SESSION_NAME="$(bashio::config 'session_name')"
fi
export SESSION_NAME

# Off by default. Turn on when a Remote Control session will not appear: the
# daemon otherwise discards the PTY output that would say what it is waiting on.
if bashio::config.true 'debug_daemon_output'; then
  export DEBUG_DAEMON_OUTPUT=1
fi

bashio::log.info "Starting Claude Code daemon..."
bashio::log.info "  Remote Control: enabled — connect at claude.ai/code or Claude mobile app"
bashio::log.info "  Session name: ${SESSION_NAME}"
bashio::log.info "  Permission mode: auto"
if bashio::config.true 'debug_daemon_output'; then
  bashio::log.info "  Daemon output logging: ON (debug_daemon_output)"
fi

# Run claude via node-pty so it sees a TTY and enters interactive mode.
exec 2>&1
exec node /app/claude-daemon.js
