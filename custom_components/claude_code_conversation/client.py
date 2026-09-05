"""HTTP client for the add-on's prompt API."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import aiohttp

from .const import DEFAULT_TIMEOUT


class PromptApiError(Exception):
    """The prompt API could not be reached or failed."""


class PromptApiAuthError(PromptApiError):
    """The prompt API rejected our token."""


class PromptApiBusyError(PromptApiError):
    """The add-on is already running its maximum number of turns."""


class PromptApiTimeoutError(PromptApiError):
    """The turn took too long."""


@dataclass(slots=True)
class ConverseResult:
    """One completed turn."""

    text: str
    session_id: str
    is_error: bool
    # What the turn actually cost. The add-on always reports these; they are
    # optional here only so a partial body cannot raise. Real money: a trivial
    # haiku turn has been measured at $0.051.
    cost_usd: float | None = None
    duration_ms: int | None = None


class PromptApiClient:
    """Talks to prompt-api.js inside the add-on container."""

    def __init__(
        self, base_url: str, token: str, session: aiohttp.ClientSession
    ) -> None:
        """Store connection details."""
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._session = session

    async def async_health(self) -> dict[str, Any]:
        """Return the add-on's health payload, raising if it is not well."""
        try:
            async with self._session.get(
                f"{self._base_url}/health",
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as resp:
                if resp.status == 401:
                    raise PromptApiAuthError("the add-on rejected the token")
                if resp.status != 200:
                    raise PromptApiError(f"health returned HTTP {resp.status}")
                return await resp.json()
        except TimeoutError as err:
            raise PromptApiTimeoutError("health check timed out") from err
        except aiohttp.ClientError as err:
            raise PromptApiError(f"cannot reach the add-on: {err}") from err

    async def async_converse(
        self,
        text: str,
        conversation_id: str,
        model: str,
        system_prompt: str,
        web_access: bool = False,
    ) -> ConverseResult:
        """Run one turn through `claude -p` in the add-on."""
        payload = {
            "text": text,
            "conversation_id": conversation_id,
            "model": model,
            "system_prompt": system_prompt,
            # The add-on treats anything but True as no web access, so a
            # stale add-on that ignores this field simply stays closed.
            "web_access": web_access,
        }
        try:
            async with self._session.post(
                f"{self._base_url}/conversation",
                json=payload,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=DEFAULT_TIMEOUT),
            ) as resp:
                if resp.status == 401:
                    raise PromptApiAuthError("the add-on rejected the token")
                if resp.status == 503:
                    raise PromptApiBusyError("the add-on is busy")
                if resp.status == 504:
                    raise PromptApiTimeoutError("claude took too long")
                if resp.status != 200:
                    raise PromptApiError(f"conversation returned HTTP {resp.status}")
                body = await resp.json()
        except asyncio.TimeoutError as err:
            raise PromptApiTimeoutError("the turn timed out") from err
        except aiohttp.ClientError as err:
            raise PromptApiError(f"cannot reach the add-on: {err}") from err

        return ConverseResult(
            text=body.get("text") or "",
            session_id=body.get("session_id") or "",
            is_error=bool(body.get("is_error")),
            cost_usd=body.get("cost_usd"),
            duration_ms=body.get("duration_ms"),
        )
