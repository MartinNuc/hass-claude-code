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
PROXY_URL="http://supervisor/core/api/mcp/assist"
MCP_URL="${PROXY_URL}"
MCP_TOKEN="${SUPERVISOR_TOKEN}"
USING_OVERRIDE="false"

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
  USING_OVERRIDE="true"
  bashio::log.info "Using the configured long-lived token against Core directly."
else
  bashio::log.info "Using the Supervisor token via the Core API proxy."
fi

# Write the MCP config for one (url, token) pair.
#
# `install -m 600` creates the file at its final restrictive mode before any
# content lands in it, so the token never sits behind a default (umask-derived,
# typically world-readable) mode even for an instant. `>` on an already-
# existing file preserves that mode rather than reapplying the umask, so a
# rewrite below never widens it.
write_mcp_config() {
  install -m 600 /dev/null /data/.claude/mcp-assist.json
  jq -n \
    --arg url "$1" \
    --arg auth "Bearer $2" \
    '{mcpServers: {"ha-assist": {type: "http", url: $url, headers: {Authorization: $auth}}}}' \
    > /data/.claude/mcp-assist.json
}

# One MCP `initialize` handshake. Echoes the HTTP status, or 000 when curl
# could not connect at all — the `||` keeps a failed curl or a non-2xx from
# tripping `set -euo pipefail`, and --max-time stops a hung endpoint from
# stalling container start.
MCP_PROBE_BODY='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"claude-code-agent-init","version":"1"}}}'

probe_mcp() {
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' \
    --max-time 10 \
    -X POST \
    -H "Authorization: Bearer $2" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "${MCP_PROBE_BODY}" \
    "$1" 2>/dev/null)" || status="000"
  printf '%s' "${status}"
}

write_mcp_config "${MCP_URL}" "${MCP_TOKEN}"
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
# Deliberately NOT fatal: the add-on must still come up so the user can read
# this log and fix it.
probe_status="$(probe_mcp "${MCP_URL}" "${MCP_TOKEN}")"

# A broken override must not cost the user a working default. ha_url and
# ha_mcp_token are easy to get wrong together — both this add-on's Vibecode
# Agent URL and this one end in "URL", and pointing ha_url at the Vibecode
# add-on (port 8099) produces a confident 404 from an add-on that was never
# meant to serve /api/mcp/assist. So when an override fails and the default
# proxy works, use the proxy and say loudly that the override was ignored.
# Silently honouring configuration that demonstrably does not work leaves the
# agent toolless; silently discarding it without saying so would be worse.
if [[ "${probe_status}" != 2* && "${USING_OVERRIDE}" == "true" ]]; then
  bashio::log.warning "Configured MCP endpoint failed (HTTP ${probe_status}); trying the Supervisor proxy..."
  proxy_status="$(probe_mcp "${PROXY_URL}" "${SUPERVISOR_TOKEN}")"
  if [[ "${proxy_status}" == 2* ]]; then
    write_mcp_config "${PROXY_URL}" "${SUPERVISOR_TOKEN}"
    bashio::log.warning "════════════════════════════════════════════════════"
    bashio::log.warning "IGNORING your ha_mcp_token / ha_url settings."
    bashio::log.warning "They point at ${MCP_URL}"
    bashio::log.warning "which answered HTTP ${probe_status}, but the default"
    bashio::log.warning "Supervisor proxy works — so the Assist agent is using"
    bashio::log.warning "that instead and HAS its tools."
    bashio::log.warning "Clear both options in the add-on configuration to"
    bashio::log.warning "silence this. A common mix-up: ha_url is for Home"
    bashio::log.warning "Assistant itself, NOT the HA Vibecode Agent add-on"
    bashio::log.warning "(port 8099) — that one belongs in ha_agent_url."
    bashio::log.warning "════════════════════════════════════════════════════"
    MCP_URL="${PROXY_URL}"
    probe_status="${proxy_status}"
  fi
fi

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
  if [[ "${USING_OVERRIDE}" == "true" ]]; then
    bashio::log.error "You have ha_mcp_token set, so the add-on is talking to"
    bashio::log.error "Home Assistant directly instead of using its default."
    bashio::log.error "CLEAR ha_mcp_token AND ha_url in the add-on"
    bashio::log.error "configuration — the default path needs no setup and"
    bashio::log.error "works on most installs. Note ha_url means Home"
    bashio::log.error "Assistant itself, not the HA Vibecode Agent add-on."
  else
    bashio::log.error "The likely cause: the 'Model Context Protocol Server'"
    bashio::log.error "integration is not installed in Home Assistant. Add it"
    bashio::log.error "under Settings -> Devices & Services, keeping the"
    bashio::log.error "default Assist API."
  fi
  bashio::log.error "The add-on is starting anyway so you can fix this."
  bashio::log.error "════════════════════════════════════════════════════"
fi
