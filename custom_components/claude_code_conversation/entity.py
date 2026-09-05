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
    PromptApiAuthError,
    PromptApiBusyError,
    PromptApiError,
    PromptApiTimeoutError,
)
from .const import CONF_WEB_ACCESS, DOMAIN, LOGGER


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
                # Agents created before this option existed have no key at
                # all, and they must stay closed rather than inherit it.
                web_access=bool(self.subentry.data.get(CONF_WEB_ACCESS, False)),
            )
        except PromptApiAuthError as err:
            # Must come first: PromptApiAuthError subclasses PromptApiError, so
            # without its own clause a runtime 401 falls into the generic
            # handler below and the user hears "the add-on isn't responding"
            # forever, while the reauth flow config_flow.py implements is never
            # reached. Realistic trigger: the add-on is reinstalled or /data is
            # wiped, so 30-deploy-integration.sh generates a fresh prompt API
            # token while this config entry still holds the old one.
            #
            # ConfigEntryAuthFailed would be wrong here: config_entries only
            # turns it into a reauth flow when it is raised during entry setup.
            # From an entity's turn handler it is just another
            # HomeAssistantError, so start the flow explicitly - the same thing
            # HA core integrations do from entity code.
            LOGGER.error("Prompt API rejected our token: %s", err)
            self.entry.async_start_reauth(self.hass)
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="invalid_auth"
            ) from err
        except PromptApiBusyError as err:
            LOGGER.warning("Prompt API is at its concurrency cap: %s", err)
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="busy"
            ) from err
        except PromptApiTimeoutError as err:
            LOGGER.warning("Claude turn timed out: %s", err)
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="timeout"
            ) from err
        except PromptApiError as err:
            # The user-facing message is deliberately generic, so without this
            # line the real cause - a DNS failure, a refused connection, an
            # unexpected status - never reaches the log, and the turn fails
            # with nothing anywhere to diagnose it from. Logged at error level
            # rather than debug for that reason: by the time a user notices,
            # the failing turn is already in the past.
            LOGGER.error("Prompt API call failed: %s", err)
            raise HomeAssistantError(
                translation_domain=DOMAIN, translation_key="cannot_connect"
            ) from err

        # Turns cost real money (a trivial haiku turn has been measured at
        # $0.051) and nothing else in Home Assistant reports it, so at least
        # make it discoverable by enabling debug logging for this integration.
        LOGGER.debug(
            "Claude turn finished: cost=%s USD, duration=%s ms, is_error=%s",
            result.cost_usd,
            result.duration_ms,
            result.is_error,
        )

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
