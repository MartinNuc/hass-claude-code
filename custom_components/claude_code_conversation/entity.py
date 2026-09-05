"""Base entity for the Claude Code Agent conversation integration."""

from __future__ import annotations

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigSubentry
from homeassistant.const import CONF_MODEL
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import device_registry as dr
from homeassistant.helpers.entity import Entity

from . import ClaudeCodeConfigEntry
from .client import (
    PromptApiBusyError,
    PromptApiError,
    PromptApiTimeoutError,
)
from .const import DOMAIN, LOGGER


class ClaudeCodeBaseEntity(Entity):
    """Shared behaviour for entities backed by one conversation subentry."""

    _attr_has_entity_name = True
    _attr_name = None

    def __init__(
        self, entry: ClaudeCodeConfigEntry, subentry: ConfigSubentry
    ) -> None:
        """Initialise the entity and its service device."""
        self.entry = entry
        self.subentry = subentry
        self._attr_unique_id = subentry.subentry_id
        self._attr_device_info = dr.DeviceInfo(
            identifiers={(DOMAIN, subentry.subentry_id)},
            name=subentry.title,
            manufacturer="Anthropic",
            model=subentry.data[CONF_MODEL],
            sw_version=entry.runtime_data.claude_version,
            entry_type=dr.DeviceEntryType.SERVICE,
        )

    async def _async_handle_chat_log(self, chat_log: conversation.ChatLog) -> None:
        """Run one turn through the add-on and append the answer.

        Unlike the other LLM integrations there is no tool loop here: the loop
        lives inside `claude -p`, which reaches Home Assistant over MCP. One
        request in, one final answer out.
        """
        latest = chat_log.content[-1]
        if getattr(latest, "attachments", None):
            raise HomeAssistantError(
                translation_domain=DOMAIN,
                translation_key="unsupported_attachment",
            )

        system_prompt = "\n".join(
            content.content
            for content in chat_log.content
            if isinstance(content, conversation.SystemContent) and content.content
        )

        client = self.entry.runtime_data.client
        try:
            result = await client.async_converse(
                text=latest.content or "",
                conversation_id=chat_log.conversation_id,
                model=self.subentry.data[CONF_MODEL],
                system_prompt=system_prompt,
            )
        except PromptApiBusyError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="busy"
            ) from err
        except PromptApiTimeoutError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="timeout"
            ) from err
        except PromptApiError as err:
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="cannot_connect"
            ) from err

        if result.is_error:
            # Claude reporting a problem is usually a useful answer in its own
            # right ("I can't see that entity"), so speak it rather than
            # replacing it with a generic failure.
            LOGGER.debug("Claude returned an error result: %s", result.text)

        chat_log.async_add_assistant_content_without_tools(
            conversation.AssistantContent(
                agent_id=self.entity_id, content=result.text
            )
        )
