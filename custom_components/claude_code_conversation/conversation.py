"""The conversation platform for the Claude Code Agent integration."""

from __future__ import annotations

from typing import Literal

from homeassistant.components import conversation
from homeassistant.config_entries import ConfigSubentry
from homeassistant.const import CONF_LLM_HASS_API, CONF_PROMPT, MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import ClaudeCodeConfigEntry
from .const import DOMAIN
from .entity import ClaudeCodeBaseEntity


async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ClaudeCodeConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    """Create one conversation entity per conversation subentry."""
    for subentry in config_entry.subentries.values():
        if subentry.subentry_type != "conversation":
            continue
        async_add_entities(
            [ClaudeCodeConversationEntity(config_entry, subentry)],
            config_subentry_id=subentry.subentry_id,
        )


class ClaudeCodeConversationEntity(
    ClaudeCodeBaseEntity, conversation.ConversationEntity
):
    """A Claude agent selectable in an Assist pipeline."""

    _attr_supports_streaming = False

    def __init__(
        self, entry: ClaudeCodeConfigEntry, subentry: ConfigSubentry
    ) -> None:
        """Initialise the agent."""
        super().__init__(entry, subentry)
        self._attr_supported_features = (
            conversation.ConversationEntityFeature.CONTROL
        )

    @property
    def supported_languages(self) -> list[str] | Literal["*"]:
        """Claude handles whatever language the user speaks."""
        return MATCH_ALL

    async def _async_handle_message(
        self,
        user_input: conversation.ConversationInput,
        chat_log: conversation.ChatLog,
    ) -> conversation.ConversationResult:
        """Answer one Assist turn."""
        options = self.subentry.data

        try:
            await chat_log.async_provide_llm_data(
                user_input.as_llm_context(DOMAIN),
                options.get(CONF_LLM_HASS_API),
                options.get(CONF_PROMPT),
                user_input.extra_system_prompt,
            )
        except conversation.ConverseError as err:
            return err.as_conversation_result()

        await self._async_handle_chat_log(chat_log)

        return conversation.async_get_result_from_chat_log(user_input, chat_log)
