"""Tests for setting up the claude_code_conversation config entry."""

from aioresponses import aioresponses

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant

HEALTH_URL = "http://addon:8098/health"


async def test_setup_entry_succeeds(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """A healthy add-on results in a loaded entry carrying the claude version."""
    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert mock_config_entry.state is ConfigEntryState.LOADED
    assert mock_config_entry.runtime_data.claude_version == "2.1.99"


async def test_setup_entry_retries_when_addon_is_down(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """An unreachable add-on leaves the entry retrying, not failed."""
    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=500)
        await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert mock_config_entry.state is ConfigEntryState.SETUP_RETRY


async def test_unload_entry(hass: HomeAssistant, mock_config_entry) -> None:
    """The entry unloads cleanly."""
    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert await hass.config_entries.async_unload(mock_config_entry.entry_id)
    assert mock_config_entry.state is ConfigEntryState.NOT_LOADED
