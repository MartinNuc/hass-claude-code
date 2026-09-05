#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

bashio::log.info "Claude Code Agent — running init..."

# ── Directory structure ──────────────────────────────────────────────────────
mkdir -p /data/.claude/sessions
chmod 700 /data/.claude /data/.claude/sessions

# ── Default settings ─────────────────────────────────────────────────────────
if [[ ! -f "/data/.claude/settings.json" ]]; then
  bashio::log.info "Creating default Claude settings..."
  jq -n '{
    theme: "dark",
    colorTheme: "dark",
    preferredTheme: "dark",
    trustedDirectories: ["/root", "/"]
  }' > /data/.claude/settings.json
fi

# ── Skip the first-run wizards ───────────────────────────────────────────────
# Onboarding state lives in .claude.json, NOT settings.json. Without this the
# daemon starts, claude renders its theme picker, and it waits for a keypress
# that never comes — and because claude-daemon.js suppresses PTY output, the
# add-on log shows a perfectly healthy startup while nothing works.
#
# The file accumulates real state across restarts (userID, machineID,
# numStartups), so merge into it rather than overwriting.
export PATH="/root/.local/bin:${PATH}"
CLAUDE_JSON="/data/.claude/.claude.json"
CLAUDE_VERSION="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1 || true)"

SEED_FILE="$(mktemp)"
jq -n --arg ver "${CLAUDE_VERSION}" '
  {
    hasCompletedOnboarding: true,
    projects: { "/root": { hasTrustDialogAccepted: true, allowedTools: [] } }
  }
  + (if $ver == "" then {} else { lastOnboardingVersion: $ver } end)
' > "${SEED_FILE}"

if [[ -f "${CLAUDE_JSON}" ]] && jq -e . "${CLAUDE_JSON}" >/dev/null 2>&1; then
  MERGED="$(mktemp)"
  # `*` merges recursively with the right side winning, so other projects and
  # unrelated top-level keys survive untouched.
  jq -s '.[0] * .[1]' "${CLAUDE_JSON}" "${SEED_FILE}" > "${MERGED}"
  mv "${MERGED}" "${CLAUDE_JSON}"
  bashio::log.info "Onboarding state merged into .claude.json."
else
  if [[ -f "${CLAUDE_JSON}" ]]; then
    bashio::log.warning ".claude.json was unreadable; replacing it."
  fi
  cp "${SEED_FILE}" "${CLAUDE_JSON}"
  bashio::log.info "Onboarding state seeded (claude ${CLAUDE_VERSION:-unknown})."
fi
rm -f "${SEED_FILE}"

# ── HA MCP config (@coolver/home-assistant-mcp via npx) ─────────────────────
HA_AGENT_URL="http://homeassistant:8099"
if bashio::config.has_value 'ha_agent_url'; then
  HA_AGENT_URL="$(bashio::config 'ha_agent_url')"
fi

HA_AGENT_KEY="$(bashio::config 'ha_agent_key')"

# `install -m 600` creates the file at its final restrictive mode *before* any
# content lands in it, so the agent key never sits behind a umask-derived
# (typically world-readable) mode even for an instant. `>` on an existing file
# preserves its mode rather than reapplying the umask, so the jq writes below
# never widen it.
install -m 600 /dev/null /data/.claude/mcp.json

if [[ -z "${HA_AGENT_KEY}" ]]; then
  # Not fatal. A failing cont-init script halts the whole container under
  # s6-overlay, which would take 20-mcp-assist.sh and 30-deploy-integration.sh
  # with it — so a user who only wants the Assist conversation agent, and never
  # installs the separate Vibecode Agent add-on, could not get that feature at
  # all. Write a valid empty config instead: claude-daemon.js passes
  # --mcp-config /data/.claude/mcp.json unconditionally and must not be pointed
  # at a file that does not exist.
  bashio::log.warning "════════════════════════════════════════════════════"
  bashio::log.warning "ha_agent_key is not set, so the Vibecode Agent MCP"
  bashio::log.warning "server is unavailable. The Remote Control session"
  bashio::log.warning "will start WITHOUT it. Set ha_agent_key from the HA"
  bashio::log.warning "Vibecode Agent add-on Web UI to enable it."
  bashio::log.warning "(The Assist conversation agent does not need this"
  bashio::log.warning "key — it uses its own MCP config.)"
  bashio::log.warning "════════════════════════════════════════════════════"
  jq -n '{mcpServers: {}}' > /data/.claude/mcp.json
else
  bashio::log.info "Writing HA MCP config (agent URL: ${HA_AGENT_URL})"

  jq -n \
    --arg url "${HA_AGENT_URL}" \
    --arg key "${HA_AGENT_KEY}" \
    '{mcpServers: {"home-assistant": {command: "npx", args: ["-y", "@coolver/home-assistant-mcp@latest"], env: {HA_AGENT_URL: $url, HA_AGENT_KEY: $key}}}}' \
    > /data/.claude/mcp.json
fi

bashio::log.info "Init complete."
