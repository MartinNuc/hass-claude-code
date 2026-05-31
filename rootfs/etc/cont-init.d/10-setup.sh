#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

bashio::log.info "Claude Code Agent — running init..."

# ── Directory structure ──────────────────────────────────────────────────────
mkdir -p /data/.claude/sessions
chmod 700 /data/.claude /data/.claude/sessions

# ── Default settings (skip first-run wizards) ────────────────────────────────
if [[ ! -f "/data/.claude/settings.json" ]]; then
  bashio::log.info "Creating default Claude settings..."
  jq -n '{
    theme: "dark",
    colorTheme: "dark",
    preferredTheme: "dark",
    trustedDirectories: ["/root", "/"],
    hasCompletedOnboarding: true
  }' > /data/.claude/settings.json
fi

# ── HA MCP config (@coolver/home-assistant-mcp via npx) ─────────────────────
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
chmod 600 /data/.claude/mcp.json

bashio::log.info "Init complete."
