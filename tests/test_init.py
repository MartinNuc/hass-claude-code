"""Tests for setting up the claude_code_conversation config entry."""

from aioresponses import aioresponses

from homeassistant.config_entries import ConfigEntryState

from custom_components.claude_code_conversation.const import DOMAIN
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


async def test_restart_issue_raised_when_core_runs_stale_files(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """A newer deployed version than the running one raises a repair.

    This is the whole point of the check: the add-on updated the files on disk,
    Home Assistant is still running the old ones, and nothing else in HA can
    tell the user that a restart is what is missing.
    """
    from homeassistant.helpers import issue_registry as ir

    from custom_components.claude_code_conversation import RESTART_REQUIRED_ISSUE

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(
            HEALTH_URL,
            payload={
                "ok": True,
                "claude_version": "2.1.99",
                "integration_version": "99.0.0",
            },
        )
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    issue = ir.async_get(hass).async_get_issue(DOMAIN, RESTART_REQUIRED_ISSUE)
    assert issue is not None
    assert issue.severity is ir.IssueSeverity.WARNING
    assert issue.translation_placeholders["deployed"] == "99.0.0"


async def test_no_restart_issue_when_versions_agree(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """The add-on reporting our own version raises nothing."""
    import json
    from pathlib import Path

    from homeassistant.helpers import issue_registry as ir

    from custom_components.claude_code_conversation import RESTART_REQUIRED_ISSUE

    manifest = json.loads(
        (
            Path(__file__).parent.parent
            / "custom_components/claude_code_conversation/manifest.json"
        ).read_text()
    )

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(
            HEALTH_URL,
            payload={
                "ok": True,
                "claude_version": "2.1.99",
                "integration_version": manifest["version"],
            },
        )
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert ir.async_get(hass).async_get_issue(DOMAIN, RESTART_REQUIRED_ISSUE) is None


async def test_no_restart_issue_from_an_older_addon(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """An add-on that does not report the field must not look like a mismatch.

    Absence is not disagreement — treating it as one would show every user of
    an older add-on a repair they cannot act on.
    """
    from homeassistant.helpers import issue_registry as ir

    from custom_components.claude_code_conversation import RESTART_REQUIRED_ISSUE

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    assert ir.async_get(hass).async_get_issue(DOMAIN, RESTART_REQUIRED_ISSUE) is None
