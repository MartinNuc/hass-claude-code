#!/usr/bin/with-contenv bashio
# shellcheck shell=bash
set -euo pipefail

# Deploy the custom integration into the user's HA config directory.
#
# The integration and the prompt API are two halves of one contract, so
# shipping them together removes any chance of version skew. It also spares the
# user a HACS install, and lets us hand the config flow a discovery file
# containing this add-on's Supervisor hostname — which the integration running
# inside HA Core cannot otherwise guess.

SRC="/app/custom_components/claude_code_conversation"
DEST_DIR="/homeassistant/custom_components"
DEST="${DEST_DIR}/claude_code_conversation"

# DEST is about to be rm -rf'd. It is built from two hardcoded literals above,
# so it cannot legitimately come out empty or equal to DEST_DIR itself — but
# this guards against exactly that class of mistake (a future edit, a typo)
# before it can turn into deleting the user's whole custom_components tree.
if [[ -z "${DEST}" || "${DEST}" == "${DEST_DIR}" || "${DEST}" != "${DEST_DIR}/"* ]]; then
  bashio::log.error "Refusing to deploy: unexpected destination path (${DEST})."
  exit 1
fi

TOKEN_FILE="/data/prompt-api-token"
if [[ ! -f "${TOKEN_FILE}" ]]; then
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
  bashio::log.info "Generated a prompt API token."
fi
TOKEN="$(cat "${TOKEN_FILE}")"

SRC_VERSION="$(jq -r '.version' "${SRC}/manifest.json")"
DEST_VERSION="$(jq -r '.version' "${DEST}/manifest.json" 2>/dev/null || echo "none")"

if [[ "${SRC_VERSION}" != "${DEST_VERSION}" ]]; then
  bashio::log.info "Deploying claude_code_conversation ${DEST_VERSION} -> ${SRC_VERSION}"
  mkdir -p "${DEST_DIR}"
  rm -rf "${DEST}"
  cp -r "${SRC}" "${DEST}"
  bashio::log.warning "════════════════════════════════════════════════════"
  bashio::log.warning "Restart Home Assistant to load the Claude Assist"
  bashio::log.warning "integration, then add it under Settings → Devices."
  bashio::log.warning "════════════════════════════════════════════════════"
else
  bashio::log.info "claude_code_conversation ${SRC_VERSION} already deployed."
fi

# Always refresh discovery: the hostname is stable but the token may have just
# been generated, and the config flow reads this file to pre-fill its form.
jq -n \
  --arg url "http://$(hostname):8098" \
  --arg token "${TOKEN}" \
  '{base_url: $url, token: $token}' \
  > "${DEST}/.addon.json"
chmod 600 "${DEST}/.addon.json"
