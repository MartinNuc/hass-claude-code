"""Shared fixtures for the claude_code_conversation tests."""

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

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


@pytest.fixture
def mock_config_entry() -> MockConfigEntry:
    """A configured connection to the add-on's prompt API."""
    return MockConfigEntry(
        domain=DOMAIN,
        title="Claude Code Agent",
        data={CONF_BASE_URL: "http://addon:8098", CONF_TOKEN: "secret"},
    )
