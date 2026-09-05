"""Tests for PromptApiClient, the HTTP client for the add-on's prompt API."""

import aiohttp
import pytest
from aioresponses import aioresponses
from yarl import URL

from custom_components.claude_code_conversation.client import (
    ConverseResult,
    PromptApiAuthError,
    PromptApiBusyError,
    PromptApiClient,
    PromptApiError,
    PromptApiTimeoutError,
)

BASE_URL = "http://addon:8098"
HEALTH_URL = f"{BASE_URL}/health"
CONVERSE_URL = f"{BASE_URL}/conversation"
TOKEN = "secret"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations():
    """Shadow tests/conftest.py's directory-wide, hass-dependent fixture.

    This suite tests PromptApiClient in isolation against a real
    aiohttp.ClientSession + aioresponses; it has no custom_components to
    load and needs no HomeAssistant test instance. Without this override,
    pytest would still resolve the same-named autouse fixture from
    tests/conftest.py, which depends on `enable_custom_integrations`, which
    depends on `hass` - reintroducing the exact HA-core coupling that
    motivated pulling these tests out of test_init.py.
    """
    return


@pytest.fixture
async def http_session():
    """A real aiohttp session for aioresponses to intercept requests from."""
    async with aiohttp.ClientSession() as session:
        yield session


@pytest.fixture
def client(http_session: aiohttp.ClientSession) -> PromptApiClient:
    """The client under test, talking to the fake add-on above."""
    return PromptApiClient(BASE_URL, TOKEN, http_session)


async def test_async_health_returns_payload(client: PromptApiClient) -> None:
    """A healthy add-on's JSON body comes back untouched."""
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        result = await client.async_health()

    assert result == {"ok": True, "claude_version": "2.1.99"}


async def test_async_health_sends_bearer_token(client: PromptApiClient) -> None:
    """The health check authenticates with the configured token."""
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, payload={"ok": True, "claude_version": "2.1.99"})
        await client.async_health()
        request = mocked.requests[("GET", URL(HEALTH_URL))][0]

    assert request.kwargs["headers"]["Authorization"] == f"Bearer {TOKEN}"


async def test_async_health_raises_auth_error_on_401(client: PromptApiClient) -> None:
    """A rejected token surfaces as PromptApiAuthError."""
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=401)
        with pytest.raises(PromptApiAuthError):
            await client.async_health()


async def test_async_health_raises_prompt_api_error_on_500(
    client: PromptApiClient,
) -> None:
    """Any other bad status surfaces as the plain PromptApiError."""
    with aioresponses() as mocked:
        mocked.get(HEALTH_URL, status=500)
        with pytest.raises(PromptApiError) as exc_info:
            await client.async_health()

    assert exc_info.type is PromptApiError


async def test_async_converse_returns_converse_result(client: PromptApiClient) -> None:
    """A successful turn maps text/session_id/is_error onto ConverseResult."""
    with aioresponses() as mocked:
        mocked.post(
            CONVERSE_URL,
            payload={"text": "hi there", "session_id": "abc123", "is_error": False},
        )
        result = await client.async_converse("hello", "conv-1", "sonnet", "be nice")

    assert result == ConverseResult(
        text="hi there", session_id="abc123", is_error=False
    )


async def test_async_converse_sends_expected_body_and_auth(
    client: PromptApiClient,
) -> None:
    """The request carries exactly the documented body and the bearer token."""
    with aioresponses() as mocked:
        mocked.post(
            CONVERSE_URL,
            payload={"text": "hi", "session_id": "s1", "is_error": False},
        )
        await client.async_converse("hello", "conv-1", "sonnet", "be nice")
        request = mocked.requests[("POST", URL(CONVERSE_URL))][0]

    assert request.kwargs["json"] == {
        "text": "hello",
        "conversation_id": "conv-1",
        "model": "sonnet",
        "system_prompt": "be nice",
    }
    assert request.kwargs["headers"]["Authorization"] == f"Bearer {TOKEN}"


async def test_async_converse_raises_busy_error_on_503(client: PromptApiClient) -> None:
    """The add-on at capacity surfaces as PromptApiBusyError."""
    with aioresponses() as mocked:
        mocked.post(CONVERSE_URL, status=503)
        with pytest.raises(PromptApiBusyError):
            await client.async_converse("hello", "conv-1", "sonnet", "be nice")


async def test_async_converse_raises_timeout_error_on_504(
    client: PromptApiClient,
) -> None:
    """A turn that took too long surfaces as PromptApiTimeoutError."""
    with aioresponses() as mocked:
        mocked.post(CONVERSE_URL, status=504)
        with pytest.raises(PromptApiTimeoutError):
            await client.async_converse("hello", "conv-1", "sonnet", "be nice")


async def test_async_converse_raises_auth_error_on_401(client: PromptApiClient) -> None:
    """A rejected token surfaces as PromptApiAuthError."""
    with aioresponses() as mocked:
        mocked.post(CONVERSE_URL, status=401)
        with pytest.raises(PromptApiAuthError):
            await client.async_converse("hello", "conv-1", "sonnet", "be nice")


async def test_async_converse_raises_prompt_api_error_on_502(
    client: PromptApiClient,
) -> None:
    """Any other failure surfaces as the plain PromptApiError."""
    with aioresponses() as mocked:
        mocked.post(CONVERSE_URL, status=502)
        with pytest.raises(PromptApiError) as exc_info:
            await client.async_converse("hello", "conv-1", "sonnet", "be nice")

    assert exc_info.type is PromptApiError


async def test_async_converse_tolerates_missing_optional_fields(
    client: PromptApiClient,
) -> None:
    """A partial 200 body still yields a well-formed ConverseResult, no KeyError."""
    with aioresponses() as mocked:
        mocked.post(CONVERSE_URL, payload={})
        result = await client.async_converse("hello", "conv-1", "sonnet", "be nice")

    assert result == ConverseResult(text="", session_id="", is_error=False)
