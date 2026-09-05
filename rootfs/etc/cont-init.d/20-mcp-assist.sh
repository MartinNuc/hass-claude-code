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

# The Supervisor's Core API proxy is the documented path for an add-on with
# homeassistant_api: true, and it is the only one offered.
#
# Reaching Core directly was tried and removed. It does not work on a real HAOS
# install — `homeassistant` resolves to the Supervisor network gateway and 8123
# is refused outright — and the port is not 8123 everywhere anyway. Exposing
# that as configuration produced exactly one outcome in practice: a user pointed
# it at the Vibecode Agent add-on (port 8099), got a confident 404 from a
# service that never served this path, and lost the Assist agent's tools while
# the working default sat unused. The proxy needs no configuration and no
# long-lived token to keep alive, so there is nothing left for an override to
# buy. If some install ever genuinely cannot use the proxy, add the option back
# deliberately — do not reintroduce it as a just-in-case escape hatch.
MCP_URL="http://supervisor/core/api/mcp/assist"
MCP_TOKEN="${SUPERVISOR_TOKEN}"

# `install -m 600` creates the file at its final restrictive mode before any
# content lands in it, so the token never sits behind a default (umask-derived,
# typically world-readable) mode even for an instant. `>` on an already-
# existing file preserves that mode rather than reapplying the umask.
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
# Deliberately NOT fatal: the add-on must still come up so the user can read
# this log and fix it. --max-time bounds a hung endpoint so it cannot stall
# container start, and `|| probe_status=...` keeps a curl failure or a non-2xx
# from tripping `set -euo pipefail`.
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
  bashio::log.error "The likely cause: the 'Model Context Protocol Server'"
  bashio::log.error "integration is not installed in Home Assistant. Add it"
  bashio::log.error "under Settings -> Devices & Services, keeping the"
  bashio::log.error "default Assist API."
  bashio::log.error "The add-on is starting anyway so you can fix this."
  bashio::log.error "════════════════════════════════════════════════════"
fi
