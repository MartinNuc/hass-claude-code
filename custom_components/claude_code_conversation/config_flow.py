"""Config flow for the Claude Code Agent conversation integration."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    SOURCE_USER,
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    ConfigSubentryFlow,
    SubentryFlowResult,
)
from homeassistant.const import CONF_LLM_HASS_API, CONF_MODEL, CONF_PROMPT
from homeassistant.core import callback
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.selector import (
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TemplateSelector,
)

from .client import PromptApiAuthError, PromptApiClient, PromptApiError
from .const import (
    CONF_BASE_URL,
    CONF_NAME,
    CONF_TOKEN,
    DOMAIN,
    LOGGER,
    MODELS,
    RECOMMENDED_CONVERSATION_OPTIONS,
    RECOMMENDED_MODEL,
)

# Written by the add-on's 30-deploy-integration.sh, beside this package. The
# add-on knows its own Supervisor hostname; an integration inside HA Core
# cannot guess it, because it is prefixed with the repository hash.
DISCOVERY_FILE = Path(__file__).parent / ".addon.json"


def _read_addon_discovery() -> dict[str, str]:
    """Return connection details the add-on left for us, or an empty dict."""
    try:
        raw = json.loads(DISCOVERY_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {
        CONF_BASE_URL: str(raw.get("base_url", "")),
        CONF_TOKEN: str(raw.get("token", "")),
    }


class ClaudeCodeConfigFlow(ConfigFlow, domain=DOMAIN):
    """Connect Home Assistant to the Claude Code Agent add-on."""

    VERSION = 1

    @classmethod
    @callback
    def async_get_supported_subentry_types(
        cls, config_entry: ConfigEntry
    ) -> dict[str, type[ConfigSubentryFlow]]:
        """Each conversation agent is a subentry of the add-on connection."""
        return {"conversation": ConversationSubentryFlowHandler}

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for (or confirm) the add-on's prompt API details."""
        errors: dict[str, str] = {}

        if user_input is not None:
            client = PromptApiClient(
                user_input[CONF_BASE_URL],
                user_input[CONF_TOKEN],
                async_get_clientsession(self.hass),
            )
            try:
                await client.async_health()
            except PromptApiAuthError:
                errors["base"] = "invalid_auth"
            except PromptApiError:
                errors["base"] = "cannot_connect"
            except Exception:  # noqa: BLE001
                LOGGER.exception("Unexpected error validating the prompt API")
                errors["base"] = "unknown"
            else:
                return self.async_create_entry(
                    title="Claude Code Agent", data=user_input
                )

        discovered = await self.hass.async_add_executor_job(_read_addon_discovery)
        suggested = {**discovered, **(user_input or {})}

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_BASE_URL,
                        description={
                            "suggested_value": suggested.get(CONF_BASE_URL, "")
                        },
                    ): str,
                    vol.Required(
                        CONF_TOKEN,
                        description={"suggested_value": suggested.get(CONF_TOKEN, "")},
                    ): str,
                }
            ),
            errors=errors,
        )

    async def async_step_reauth(
        self, entry_data: Mapping[str, Any]
    ) -> ConfigFlowResult:
        """Start reauth when the stored token stops working."""
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Ask for a fresh token, pre-filled from the add-on if it left one."""
        entry = self._get_reauth_entry()
        errors: dict[str, str] = {}

        if user_input is not None:
            client = PromptApiClient(
                entry.data[CONF_BASE_URL],
                user_input[CONF_TOKEN],
                async_get_clientsession(self.hass),
            )
            try:
                await client.async_health()
            except PromptApiAuthError:
                errors["base"] = "invalid_auth"
            except PromptApiError:
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(
                    entry, data_updates={CONF_TOKEN: user_input[CONF_TOKEN]}
                )

        discovered = await self.hass.async_add_executor_job(_read_addon_discovery)

        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_TOKEN,
                        description={
                            "suggested_value": discovered.get(CONF_TOKEN, "")
                        },
                    ): str
                }
            ),
            errors=errors,
        )


class ConversationSubentryFlowHandler(ConfigSubentryFlow):
    """Create or reconfigure one Claude conversation agent."""

    def __init__(self) -> None:
        """Start with no options loaded."""
        self.options: dict[str, Any] = {}

    @property
    def _is_new(self) -> bool:
        """Return True when creating rather than reconfiguring."""
        return self.source == SOURCE_USER

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Create a new agent."""
        self.options = dict(RECOMMENDED_CONVERSATION_OPTIONS)
        return await self.async_step_init(user_input)

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Reconfigure an existing agent."""
        self.options = dict(self._get_reconfigure_subentry().data)
        return await self.async_step_init(user_input)

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> SubentryFlowResult:
        """Collect the agent's name, model and system prompt."""
        if user_input is not None:
            data = {
                **user_input,
                CONF_LLM_HASS_API: RECOMMENDED_CONVERSATION_OPTIONS[CONF_LLM_HASS_API],
            }
            if self._is_new:
                return self.async_create_entry(title=user_input[CONF_NAME], data=data)
            return self.async_update_and_abort(
                self._get_entry(),
                self._get_reconfigure_subentry(),
                title=user_input[CONF_NAME],
                data=data,
            )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_NAME,
                        description={
                            "suggested_value": self.options.get(
                                CONF_NAME, "Claude"
                            )
                        },
                    ): str,
                    vol.Required(
                        CONF_MODEL,
                        default=self.options.get(CONF_MODEL, RECOMMENDED_MODEL),
                    ): SelectSelector(
                        SelectSelectorConfig(
                            options=MODELS,
                            mode=SelectSelectorMode.DROPDOWN,
                            custom_value=True,
                        )
                    ),
                    vol.Optional(
                        CONF_PROMPT,
                        description={
                            "suggested_value": self.options.get(
                                CONF_PROMPT,
                                RECOMMENDED_CONVERSATION_OPTIONS[CONF_PROMPT],
                            )
                        },
                    ): TemplateSelector(),
                }
            ),
        )
