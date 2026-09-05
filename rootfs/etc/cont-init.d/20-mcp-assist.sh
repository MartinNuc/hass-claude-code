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
# 10-setup.sh happens to create /data/.claude first today, but relying on the
# ordering of a *different* script under `set -euo pipefail` means a future
# renumber turns into a container-halting failure. Make it explicit.
mkdir -p /data/.claude
chmod 700 /data/.claude

# Reaching Core directly at homeassistant:8123 does not work on a real HAOS
# install: the name resolves to the Supervisor network gateway and the
# connection is refused outright (curl exit 7, in 0 ms). The Supervisor's Core
# API proxy is the documented path for an add-on with homeassistant_api: true,
# it answers on this endpoint, and it needs no user configuration — so it is
# the default.
MCP_URL="http://supervisor/core/api/mcp/assist"
MCP_TOKEN="${SUPERVISOR_TOKEN}"

if bashio::config.has_value 'ha_mcp_token'; then
  # A long-lived token is minted by Core, not the Supervisor, so the proxy
  # will not honour it — that token only works against Core directly. Keep
  # this path as the escape hatch for an install where the proxy is refused.
  # 8123 is only the default port. A user serving Core on 80 (or anything
  # else) needs ha_url, or this silently cannot connect.
  HA_URL="http://homeassistant:8123"
  if bashio::config.has_value 'ha_url'; then
    HA_URL="$(bashio::config 'ha_url')"
  fi
  MCP_URL="${HA_URL%/}/api/mcp/assist"
  MCP_TOKEN="$(bashio::config 'ha_mcp_token')"
  bashio::log.info "Using the configured long-lived token against Core directly."
else
  bashio::log.info "Using the Supervisor token via the Core API proxy."
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

# ── Probe the MCP endpoint ───────────────────────────────────────────────────
#
# Without this, the single most likely real-world failure is silent: if the
# user never installs Home Assistant's "Model Context Protocol Server"
# integration, /api/mcp/assist 404s, `claude` starts with zero tools, and the
# Assist agent answers conversationally ("I don't have access to...") with
# is_error false. Nothing anywhere reports it. /health only knows the Claude
# version. So probe once at start and say so loudly in the log.
#
# This also gives the never-verified "HA accepts SUPERVISOR_TOKEN on this
# endpoint" assumption a self-reporting failure mode instead of a silent one.
#
# Deliberately NOT fatal: the add-on must still come up so the user can read
# this log and fix it. --max-time bounds a hung endpoint so it cannot stall
# container start, and the `|| probe_status=...` keeps a curl failure or a
# non-2xx from tripping `set -euo pipefail`.
MCP_PROBE_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"claude-code-agent-init","version":"1"}}}'

probe_status="$(curl -s -o /dev/null -w '%{http_code}' \
  --max-time 10 \
  -X POST \
  -H "Authorization: Bearer ${MCP_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d "${MCP_PROBE_BODY}" \
  "${MCP_URL}" 2>/dev/null)" || probe_status="000"

if [[ "${probe_status}" == 2* ]]; then
  bashio::log.info "HA MCP server reachable (HTTP ${probe_status}) — the Assist agent has tools."
else
  bashio::log.error "════════════════════════════════════════════════════"
  if [[ "${probe_status}" == "000" ]]; then
    bashio::log.error "Could not reach the HA MCP server at ${MCP_URL}"
    bashio::log.error "(connection failed or timed out)."
  else
    bashio::log.error "HA MCP server returned HTTP ${probe_status} for"
    bashio::log.error "${MCP_URL}"
  fi
  bashio::log.error "The Assist conversation agent will start with NO tools:"
  bashio::log.error "it will chat, but it will not control anything."
  bashio::log.error "The two likely causes:"
  bashio::log.error "  1. The 'Model Context Protocol Server' integration is"
  bashio::log.error "     not installed in Home Assistant. Add it under"
  bashio::log.error "     Settings -> Devices & Services, keeping the default"
  bashio::log.error "     Assist API."
  bashio::log.error "  2. The token was rejected. By default the add-on uses"
  bashio::log.error "     the Supervisor token against the Core API proxy. If"
  bashio::log.error "     that is refused, create a long-lived access token"
  bashio::log.error "     (Profile -> Security), set it as the add-on's"
  bashio::log.error "     'ha_mcp_token' option and restart — that switches"
  bashio::log.error "     this to talking to Core directly. Note the reverse"
  bashio::log.error "     too: a long-lived token set here while Core is only"
  bashio::log.error "     reachable via the proxy will fail, so clear the"
  bashio::log.error "     option to go back to the default path."
  bashio::log.error "The add-on is starting anyway so you can fix this."
  bashio::log.error "════════════════════════════════════════════════════"
fi
