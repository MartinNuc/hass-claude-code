#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

bashio::log.info "Claude Code Agent — running init..."

# ── Directory structure ──────────────────────────────────────────────────────
mkdir -p \
  /data/.claude/channels/telegram \
  /data/.claude/sessions

# ── OAuth credentials ────────────────────────────────────────────────────────
if [[ ! -f "/data/.claude/.credentials.json" ]]; then
  bashio::log.warning "No Claude credentials found."
  bashio::log.warning "Starting 'claude login' — open the URL printed below in a browser."
  bashio::log.warning "Waiting for auth to complete before starting the daemon..."
  # claude login prints a URL and polls for completion (device-code / URL flow)
  HOME=/root CLAUDE_CONFIG_DIR=/data/.claude claude login
  bashio::log.info "Login complete."
fi

# ── HA MCP config ────────────────────────────────────────────────────────────
# Use Supervisor-provided token by default; let user override via add-on options
HA_TOKEN="${SUPERVISOR_TOKEN:-}"
if bashio::config.has_value 'ha_token'; then
  HA_TOKEN="$(bashio::config 'ha_token')"
fi

HA_URL="http://supervisor/core"
if bashio::config.has_value 'ha_url'; then
  HA_URL="$(bashio::config 'ha_url')"
fi

if [[ -z "${HA_TOKEN}" ]]; then
  bashio::log.error "No HA token available. Set ha_token in add-on options or ensure homeassistant_api is enabled in config.yaml."
  exit 1
fi

bashio::log.info "Writing HA MCP config (URL: ${HA_URL})"

cat > /data/.claude/mcp.json << EOF
{
  "mcpServers": {
    "home-assistant": {
      "command": "uvx",
      "args": ["hass-mcp"],
      "env": {
        "HA_TOKEN": "${HA_TOKEN}",
        "HA_URL": "${HA_URL}"
      }
    }
  }
}
EOF
# Permissions: only owner can read (contains HA token)
chmod 600 /data/.claude/mcp.json

# ── Telegram bot token ───────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN="$(bashio::config 'telegram_bot_token')"
if [[ -z "${TELEGRAM_BOT_TOKEN}" ]]; then
  bashio::log.warning "telegram_bot_token is empty. Telegram channel will not connect."
else
  # Claude Code Telegram plugin reads token from this env file
  echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}" > /data/.claude/channels/telegram/.env
  chmod 600 /data/.claude/channels/telegram/.env
  bashio::log.info "Telegram bot token configured."
fi

bashio::log.info "Init complete."
