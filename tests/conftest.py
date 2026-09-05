"""Shared fixtures for the claude_code_conversation tests."""

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from custom_components.claude_code_conversation.const import (
    CONF_BASE_URL,
    CONF_TOKEN,
    DOMAIN,
)

pytest_plugins = "pytest_homeassistant_custom_component"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):
    """Load custom_components/ during tests."""
    return


@pytest.fixture(autouse=True)
async def setup_homeassistant_integration(hass: HomeAssistant) -> None:
    """Set up the base `homeassistant` domain.

    Normal HA bootstrap always sets this up before any other integration.
    The test `hass` fixture does not, so any flow that pulls in our
    `conversation` dependency trips over `homeassistant.exposed_entities`
    being unpopulated (`conversation`'s default agent records which of the
    already-live entities are exposed as soon as it starts). Matches the
    idiom HA core's own integration tests use. `async_setup_component` is
    idempotent, so this is harmless for test files (like test_config_flow)
    that also set it up themselves.
    """
    assert await async_setup_component(hass, "homeassistant", {})


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """A configured connection to the add-on's prompt API."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Claude Code Agent",
        data={CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"},
    )
