#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

bashio::log.info "Claude Code Agent — running init..."

# ── Directory structure ──────────────────────────────────────────────────────
mkdir -p \
  /data/.claude/channels/telegram \
  /data/.claude/sessions

chmod 700 \
  /data/.claude \
  /data/.claude/channels \
  /data/.claude/channels/telegram \
  /data/.claude/sessions

# ── OAuth credentials ────────────────────────────────────────────────────────
# Pre-create settings.json so Claude skips the first-run theme wizard
if [[ ! -f "/data/.claude/settings.json" ]]; then
  bashio::log.info "Creating default Claude settings (dark theme)..."
  echo '{"theme":"dark"}' > /data/.claude/settings.json
fi

# ── HA MCP config (@coolver/home-assistant-mcp via npx) ─────────────────────
# HA_AGENT_URL: URL of the HA Vibecode Agent add-on (default: port 8099 on HA host)
# HA_AGENT_KEY: API key from the Vibecode Agent add-on Web UI (required)
HA_AGENT_URL="http://homeassistant:8099"
if bashio::config.has_value 'ha_agent_url'; then
  HA_AGENT_URL="$(bashio::config 'ha_agent_url')"
fi

HA_AGENT_KEY="$(bashio::config 'ha_agent_key')"
if [[ -z "${HA_AGENT_KEY}" ]]; then
  bashio::log.error "ha_agent_key is required. Get it from the HA Vibecode Agent add-on Web UI."
  exit 1
fi

bashio::log.info "Writing HA MCP config (agent URL: ${HA_AGENT_URL})"

jq -n \
  --arg url "${HA_AGENT_URL}" \
  --arg key "${HA_AGENT_KEY}" \
  '{mcpServers: {"home-assistant": {command: "npx", args: ["-y", "@coolver/home-assistant-mcp@latest"], env: {HA_AGENT_URL: $url, HA_AGENT_KEY: $key}}}}' \
  > /data/.claude/mcp.json
# Permissions: only owner can read (contains HA agent key)
chmod 600 /data/.claude/mcp.json

# ── Telegram bot token ───────────────────────────────────────────────────────
TELEGRAM_BOT_TOKEN=""
if bashio::config.has_value 'telegram_bot_token'; then
  TELEGRAM_BOT_TOKEN="$(bashio::config 'telegram_bot_token')"
fi
if [[ -z "${TELEGRAM_BOT_TOKEN}" ]]; then
  bashio::log.warning "telegram_bot_token is empty. Telegram channel will not connect."
else
  # Claude Code Telegram plugin reads token from this env file
  echo "TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}" > /data/.claude/channels/telegram/.env
  chmod 600 /data/.claude/channels/telegram/.env
  bashio::log.info "Telegram bot token configured."
fi

bashio::log.info "Init complete."
