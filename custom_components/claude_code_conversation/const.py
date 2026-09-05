"""Constants for the Claude Code Agent conversation integration."""

import logging

from homeassistant.const import CONF_LLM_HASS_API, CONF_PROMPT
from homeassistant.helpers import llm

DOMAIN = "claude_code_conversation"
LOGGER = logging.getLogger(__package__)

CONF_BASE_URL = "base_url"
CONF_TOKEN = "token"
CONF_NAME = "name"
CONF_WEB_ACCESS = "web_access"

# Aliases understood by `claude --model`. A pinned id such as "claude-opus-5"
# can also be typed in, because the selector allows custom values.
MODELS = ["opus", "sonnet", "haiku", "fable"]
RECOMMENDED_MODEL = "sonnet"

# Generous: a controlling turn pays several MCP round-trips inside claude.
# The add-on applies its own hard timeout, so this is only the outer bound.
DEFAULT_TIMEOUT = 90

# CONF_LLM_HASS_API is pinned rather than offered as a form field. It is what
# makes chat_log.async_provide_llm_data emit the exposed-entity list into the
# system prompt, but Home Assistant never executes the tools here — Claude does,
# over MCP. A visible toggle meaning something different from the identical
# toggle in every other integration would be worse than no toggle.
RECOMMENDED_CONVERSATION_OPTIONS = {
    CONF_LLM_HASS_API: [llm.LLM_API_ASSIST],
    CONF_PROMPT: llm.DEFAULT_INSTRUCTIONS_PROMPT,
    # Off by default. An Assist turn runs unattended and is invocable by anyone
    # who can speak to a voice satellite, so every capability here is opt-in
    # per agent — you may want it in the chat panel and not in the kitchen.
    CONF_WEB_ACCESS: False,
}
