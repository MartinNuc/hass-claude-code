"""Tests for the Claude conversation entity."""

from aioresponses import aioresponses
import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry
from yarl import URL

from homeassistant import config_entries
from homeassistant.components import conversation
from homeassistant.config_entries import ConfigSubentryData
from homeassistant.const import CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT
from homeassistant.core import HomeAssistant
from homeassistant.helpers import intent, llm

from custom_components.claude_code_conversation.const import (
    CONF_BASE_URL,
    CONF_NAME,
    CONF_TOKEN,
    DOMAIN,
)

HEALTH_URL = "http://addon:8098/health"
CONVERSE_URL = "http://addon:8098/conversation"


@pytest.fixture
def agent_entry() -> MockConfigEntry:
    """A config entry carrying one conversation agent.

    `ConfigEntry.subentries` is populated only from the `subentries_data`
    constructor argument (set via `object.__setattr__` in `__init__`), so
    unlike the brief's indicative fixture this cannot be bolted on to an
    already-constructed `mock_config_entry` afterward — the entry must be
    built with its subentries from the start.
    """
    return MockConfigEntry(
        domain=DOMAIN,
        title="Claude Code Agent",
        data={CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"},
        subentries_data=[
            ConfigSubentryData(
                data={
                    CONF_NAME: "Voice",
                    CONF_MODEL: "haiku",
                    CONF_PROMPT: "Be brief.",
                    CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
                },
                subentry_type="conversation",
                title="Voice",
                unique_id=None,
            )
        ],
    )


async def _setup(hass: HomeAssistant, entry, mocked) -> str:
    entry.add_to_hass(hass)
    mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return next(
        eid for eid in hass.states.async_entity_ids("conversation") if "voice" in eid
    )


async def test_agent_answers(hass: HomeAssistant, agent_entry) -> None:
    """A successful turn is spoken back to the user."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={
                "text": "The kitchen light is on.",
                "session_id": "s1",
                "duration_ms": 900,
                "cost_usd": 0.01,
                "is_error": False,
            },
        )
        result = await conversation.async_converse(
            hass, "which lights are on?", None, None, agent_id=entity_id
        )

    assert result.response.speech["plain"]["speech"] == "The kitchen light is on."


async def test_agent_sends_system_prompt_and_conversation_id(
    hass: HomeAssistant, agent_entry
) -> None:
    """HA's generated system prompt and conversation id reach the add-on."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={"text": "ok", "session_id": "s1", "is_error": False},
        )
        await conversation.async_converse(
            hass, "hello", "conv-42", None, agent_id=entity_id
        )

        # aioresponses records every intercepted request keyed by
        # (method, url); the health-check GET fired during setup shares
        # `mocked.requests` with this POST, so address the POST directly.
        request = mocked.requests[("POST", URL(CONVERSE_URL))][-1]
        body = request.kwargs["json"]

    assert body["conversation_id"] == "conv-42"
    assert body["model"] == "haiku"
    assert body["text"] == "hello"
    # async_provide_llm_data injects the Assist instructions into the prompt.
    assert "Be brief." in body["system_prompt"]


async def test_agent_reports_a_busy_addon(hass: HomeAssistant, agent_entry) -> None:
    """A 503 surfaces the translated 'busy' error, not a leaked client exception.

    `_async_handle_chat_log` raises `HomeAssistantError(translation_key="busy")`,
    but `conversation.async_converse` (unlike the brief's indicative
    `pytest.raises`) catches every `HomeAssistantError` its agent raises and
    folds it into an error `ConversationResult` — the translation_key is
    resolved into English text there and does not reach the caller as an
    exception. Assert on that resolved result instead.
    """
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(CONVERSE_URL, status=503)
        result = await conversation.async_converse(
            hass, "hello", None, None, agent_id=entity_id
        )

    assert result.response.error_code == intent.IntentResponseErrorCode.UNKNOWN
    assert "busy" in result.response.speech["plain"]["speech"].lower()


async def test_agent_passes_through_claude_errors(
    hass: HomeAssistant, agent_entry
) -> None:
    """is_error results are spoken as answers, not raised as exceptions."""
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={
                "text": "I can't see that entity.",
                "session_id": "s1",
                "is_error": True,
            },
        )
        result = await conversation.async_converse(
            hass, "turn on the thing", None, None, agent_id=entity_id
        )

    assert result.response.speech["plain"]["speech"] == "I can't see that entity."


async def test_agent_401_starts_reauth(hass: HomeAssistant, agent_entry) -> None:
    """A runtime 401 kicks off reauth instead of blaming the add-on.

    PromptApiAuthError subclasses PromptApiError, so before this was fixed a
    401 at turn time fell into the generic handler and the user heard "the
    add-on isn't responding" forever - the reauth flow config_flow.py
    implements was never reached. Realistic trigger: /data is wiped and
    30-deploy-integration.sh writes a fresh token while the entry keeps the
    old one.
    """
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(CONVERSE_URL, status=401)
        result = await conversation.async_converse(
            hass, "hello", None, None, agent_id=entity_id
        )
        # async_start_reauth schedules a task; let it run.
        await hass.async_block_till_done()

    assert result.response.error_code == intent.IntentResponseErrorCode.UNKNOWN
    speech = result.response.speech["plain"]["speech"].lower()
    assert "token" in speech
    assert "isn't responding" not in speech

    flows = [
        flow
        for flow in hass.config_entries.flow.async_progress_by_handler(DOMAIN)
        if flow["context"].get("source") == config_entries.SOURCE_REAUTH
    ]
    assert len(flows) == 1
    assert flows[0]["context"]["entry_id"] == agent_entry.entry_id


async def test_agent_device_reports_the_model(
    hass: HomeAssistant, agent_entry
) -> None:
    """Each agent gets its own service device labelled with its model."""
    from homeassistant.helpers import device_registry as dr

    with aioresponses() as mocked:
        await _setup(hass, agent_entry, mocked)

    subentry_id = next(iter(agent_entry.subentries))
    device = dr.async_get(hass).async_get_device(
        identifiers={(DOMAIN, subentry_id)}
    )
    assert device is not None
    assert device.model == "haiku"
    assert device.sw_version == "2.1.99"


async def test_agent_without_the_option_stays_closed(
    hass: HomeAssistant, agent_entry
) -> None:
    """An agent created before web access existed must not acquire it.

    The `agent_entry` fixture deliberately has no web_access key, which is
    exactly the shape of a subentry stored by an earlier version. Reading a
    missing key as anything but False would silently widen the tool surface of
    every existing agent on upgrade.
    """
    with aioresponses() as mocked:
        entity_id = await _setup(hass, agent_entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={"text": "ok", "session_id": "s1", "is_error": False},
        )
        await conversation.async_converse(
            hass, "hello", "conv-1", None, agent_id=entity_id
        )
        body = mocked.requests[("POST", URL(CONVERSE_URL))][-1].kwargs["json"]

    assert body["web_access"] is False
    # Same story for effort: no key means no flag, not a default of our own.
    assert body["effort"] == ""


async def test_agent_with_web_access_forwards_it(hass: HomeAssistant) -> None:
    """An agent configured with the toggle on asks the add-on for web tools."""
    from custom_components.claude_code_conversation.const import CONF_WEB_ACCESS

    entry = MockConfigEntry(
        domain=DOMAIN,
        title="Claude Code Agent",
        data={CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"},
        subentries_data=[
            ConfigSubentryData(
                data={
                    CONF_NAME: "Voice",
                    CONF_MODEL: "haiku",
                    CONF_PROMPT: "Be brief.",
                    CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
                    CONF_WEB_ACCESS: True,
                },
                subentry_type="conversation",
                title="Voice",
                unique_id=None,
            )
        ],
    )

    with aioresponses() as mocked:
        entity_id = await _setup(hass, entry, mocked)
        mocked.post(
            CONVERSE_URL,
            payload={"text": "ok", "session_id": "s1", "is_error": False},
        )
        await conversation.async_converse(
            hass, "hello", "conv-1", None, agent_id=entity_id
        )
        body = mocked.requests[("POST", URL(CONVERSE_URL))][-1].kwargs["json"]

    assert body["web_access"] is True
