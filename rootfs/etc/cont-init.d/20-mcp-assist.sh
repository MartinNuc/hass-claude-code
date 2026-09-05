#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# MCP config for the Assist conversation agent ONLY.
#
# Deliberately separate from /data/.claude/mcp.json: the Assist agent gets
# Home Assistant's own intent tools, scoped to entities exposed to Assist,
# while the interactive Remote Control session keeps the full vibecode-agent
# surface. Neither inherits the other's tools.

mkdir -p /data/assist-workspace

MCP_URL="http://homeassistant:8123/api/mcp/assist"
MCP_TOKEN="${SUPERVISOR_TOKEN}"

if bashio::config.has_value 'ha_mcp_token'; then
  MCP_TOKEN="$(bashio::config 'ha_mcp_token')"
  bashio::log.info "Using the configured long-lived token for the HA MCP server."
else
  bashio::log.info "Using the Supervisor token for the HA MCP server."
fi

# Create the file at its final restrictive mode before any content lands in
# it: `install -m 600` sets the mode at creation time, so there is no window
# where the token sits behind default (umask-derived, typically world-
# readable) permissions. `>` on an already-existing file preserves its mode
# rather than reapplying the umask, so the jq write below never widens it.
install -m 600 /dev/null /data/.claude/mcp-assist.json
jq -n \
  --arg url "${MCP_URL}" \
  --arg auth "Bearer ${MCP_TOKEN}" \
  '{mcpServers: {"ha-assist": {type: "http", url: $url, headers: {Authorization: $auth}}}}' \
  > /data/.claude/mcp-assist.json

bashio::log.info "Assist MCP config written (${MCP_URL})."
