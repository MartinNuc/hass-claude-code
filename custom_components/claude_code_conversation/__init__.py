"""The Claude Code Agent conversation integration."""

from __future__ import annotations

from dataclasses import dataclass

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers.aiohttp_client import async_get_clientsession

from .client import PromptApiAuthError, PromptApiClient, PromptApiError
from .const import CONF_BASE_URL, CONF_TOKEN

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

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


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
