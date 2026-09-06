"""The Claude Code Agent conversation integration."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.loader import async_get_integration

from .client import PromptApiAuthError, PromptApiClient, PromptApiError
from .const import CONF_BASE_URL, CONF_TOKEN, DOMAIN

RESTART_REQUIRED_ISSUE = "restart_required"

PLATFORMS = [Platform.CONVERSATION]


@dataclass(slots=True)
class ClaudeCodeData:
    """Runtime data shared by every agent on this connection."""

    client: PromptApiClient
    claude_version: str


type ClaudeCodeConfigEntry = ConfigEntry[ClaudeCodeData]


async def async_setup_entry(
    hass: HomeAssistant, entry: ClaudeCodeConfigEntry
) -> bool:
    """Set up the add-on connection."""
    client = PromptApiClient(
        entry.data[CONF_BASE_URL],
        entry.data[CONF_TOKEN],
        async_get_clientsession(hass),
    )

    try:
        health = await client.async_health()
    except PromptApiAuthError as err:
        raise ConfigEntryAuthFailed(str(err)) from err
    except PromptApiError as err:
        raise ConfigEntryNotReady(str(err)) from err

    entry.runtime_data = ClaudeCodeData(
        client=client, claude_version=health.get("claude_version", "unknown")
    )

    await _async_check_restart_required(hass, health)

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def _async_check_restart_required(
    hass: HomeAssistant, health: dict[str, Any]
) -> None:
    """Warn when the add-on has deployed a newer integration than Core is running.

    The add-on copies its integration into the config directory at container
    start, but Home Assistant only loads custom integrations at Core startup.
    Between those two events the files on disk and the code in memory differ,
    and nothing in Home Assistant says so: the user updates the add-on, sees no
    new options, and has no way to tell that a restart is what is missing. The
    add-on does log it, but nobody reads an add-on log after clicking Update.

    Comparing what the add-on shipped against what we actually are is the only
    signal available from inside Home Assistant, so surface it as a repair.
    """
    deployed = health.get("integration_version")
    if not deployed or deployed == "unknown":
        # An older add-on does not report this. Absence is not a mismatch.
        return

    integration = await async_get_integration(hass, DOMAIN)
    running = str(integration.version) if integration.version else None
    if running is None or running == deployed:
        ir.async_delete_issue(hass, DOMAIN, RESTART_REQUIRED_ISSUE)
        return

    ir.async_create_issue(
        hass,
        DOMAIN,
        RESTART_REQUIRED_ISSUE,
        is_fixable=False,
        severity=ir.IssueSeverity.WARNING,
        translation_key=RESTART_REQUIRED_ISSUE,
        translation_placeholders={"running": running, "deployed": deployed},
    )


async def _async_update_listener(
    hass: HomeAssistant, entry: ClaudeCodeConfigEntry
) -> None:
    """Reload when the user edits the entry or a subentry."""
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(
    hass: HomeAssistant, entry: ClaudeCodeConfigEntry
) -> bool:
    """Unload the connection."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
