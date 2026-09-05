"""Constants for the Claude Code Agent conversation integration."""

import logging

DOMAIN = "claude_code_conversation"
LOGGER = logging.getLogger(__package__)

CONF_BASE_URL = "base_url"
CONF_TOKEN = "token"
CONF_NAME = "name"

# Aliases understood by `claude --model`. A pinned id such as "claude-opus-5"
# can also be typed in, because the selector allows custom values.
MODELS = ["opus", "sonnet", "haiku", "fable"]
RECOMMENDED_MODEL = "sonnet"

# Generous: a controlling turn pays several MCP round-trips inside claude.
# The add-on applies its own hard timeout, so this is only the outer bound.
DEFAULT_TIMEOUT = 90
