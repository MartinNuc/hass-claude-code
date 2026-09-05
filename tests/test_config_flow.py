"""Tests for the claude_code_conversation config flow."""

from unittest.mock import patch

from aioresponses import aioresponses

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType

from custom_components.claude_code_conversation.const import (
    CONF_BASE_URL,
    CONF_TOKEN,
    DOMAIN,
)

HEALTH_URL = "http://addon:8098/health"
USER_INPUT = {CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"}


async def test_user_flow_creates_entry(hass: HomeAssistant) -> None:
    """A reachable add-on produces a config entry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )
    assert result["type"] is FlowResultType.FORM

    # Creating the entry runs real config-entry setup (async_finish_flow
    # awaits it inline). PLATFORMS forwards to a conversation.py platform
    # that a later task adds, so async_setup_entry is patched out here per
    # the controller ruling — this is HA core's own idiom for flow tests.
    with (
        aioresponses() as mocked,
        patch(
            "custom_components.claude_code_conversation.async_setup_entry",
            return_value=True,
        ),
    ):
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], USER_INPUT
        )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == USER_INPUT


async def test_user_flow_reports_invalid_auth(hass: HomeAssistant) -> None:
    """A rejected token is reported as bad auth, not as a dead add-on."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )

    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=401)
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], USER_INPUT
        )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "invalid_auth"}


async def test_reauth_updates_the_token(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """Reauth replaces the stored token without creating a second entry."""
    mock_config_entry.add_to_hass(hass)
    result = await mock_config_entry.start_reauth_flow(hass)
    assert result["type"] is FlowResultType.FORM

    # async_update_reload_and_abort schedules a reload of the entry, which
    # runs real config-entry setup. Patched out for the same reason as
    # above — see the comment on test_user_flow_creates_entry.
    with (
        aioresponses() as mocked,
        patch(
            "custom_components.claude_code_conversation.async_setup_entry",
            return_value=True,
        ),
    ):
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], {CONF_TOKEN: "fresh"}
        )
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert mock_config_entry.data[CONF_TOKEN] == "fresh"


async def test_user_flow_reports_cannot_connect(hass: HomeAssistant) -> None:
    """An unreachable add-on shows an error and lets the user retry."""
    result = await hass.config_entries.flow.async_init(
        DOMAIN, context={"source": config_entries.SOURCE_USER}
    )

    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=500)
        result = await hass.config_entries.flow.async_configure(
            result["flow_id"], USER_INPUT
        )

    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_user_flow_prefills_from_addon_discovery(hass: HomeAssistant) -> None:
    """The form is pre-filled from the .addon.json the add-on dropped."""
    with patch(
        "custom_components.claude_code_conversation.config_flow._read_addon_discovery",
        return_value={CONF_BASE_URL: "http://discovered:8098", CONF_TOKEN: "found"},
    ):
        result = await hass.config_entries.flow.async_init(
            DOMAIN, context={"source": config_entries.SOURCE_USER}
        )

    schema = result["data_schema"].schema
    defaults = {
        str(key): key.description["suggested_value"]
        for key in schema
        if getattr(key, "description", None)
    }
    assert defaults[CONF_BASE_URL] == "http://discovered:8098"
    assert defaults[CONF_TOKEN] == "found"


async def test_conversation_subentry_creates_agent(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """Adding a conversation subentry stores model, prompt and the pinned API."""
    from homeassistant.const import CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT
    from homeassistant.helpers import llm

    from custom_components.claude_code_conversation.const import CONF_NAME

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

    result = await hass.config_entries.subentries.async_init(
        (mock_config_entry.entry_id, "conversation"),
        context={"source": config_entries.SOURCE_USER},
    )
    assert result["type"] is FlowResultType.FORM

    result = await hass.config_entries.subentries.async_configure(
        result["flow_id"],
        {CONF_NAME: "Voice", CONF_MODEL: "haiku", CONF_PROMPT: "Be brief."},
    )

    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Voice"
    assert result["data"] == {
        CONF_NAME: "Voice",
        CONF_MODEL: "haiku",
        CONF_PROMPT: "Be brief.",
        CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
    }


async def test_conversation_subentry_reconfigure(
    hass: HomeAssistant, mock_config_entry
) -> None:
    """Reconfiguring an agent updates it in place rather than adding another."""
    from homeassistant.const import CONF_MODEL, CONF_PROMPT

    from custom_components.claude_code_conversation.const import CONF_NAME

    mock_config_entry.add_to_hass(hass)
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        assert await hass.config_entries.async_setup(mock_config_entry.entry_id)
        await hass.async_block_till_done()

        result = await hass.config_entries.subentries.async_init(
            (mock_config_entry.entry_id, "conversation"),
            context={"source": config_entries.SOURCE_USER},
        )
        await hass.config_entries.subentries.async_configure(
            result["flow_id"],
            {CONF_NAME: "Voice", CONF_MODEL: "haiku", CONF_PROMPT: "Be brief."},
        )
        await hass.async_block_till_done()

        subentry_id = next(iter(mock_config_entry.subentries))
        result = await hass.config_entries.subentries.async_init(
            (mock_config_entry.entry_id, "conversation"),
            context={
                "source": config_entries.SOURCE_RECONFIGURE,
                "subentry_id": subentry_id,
            },
        )
        result = await hass.config_entries.subentries.async_configure(
            result["flow_id"],
            {CONF_NAME: "Voice", CONF_MODEL: "opus", CONF_PROMPT: "Be brief."},
        )
        await hass.async_block_till_done()

    assert result["type"] is FlowResultType.ABORT
    assert len(mock_config_entry.subentries) == 1
    assert mock_config_entry.subentries[subentry_id].data[CONF_MODEL] == "opus"
