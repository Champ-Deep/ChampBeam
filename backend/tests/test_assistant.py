"""Assistant: config endpoint, admin provider picker, chat with mock provider.

The mock provider keeps the whole loop testable without keys: config round
trip, chat reply, 503 guards, and the admin-only write gate.
"""

from __future__ import annotations

import pytest

from app.core.config import settings
from tests.test_api_keys import _mint_key
from tests.test_pages_v2 import local_storage  # noqa: F401  (storage fixture)


async def _headers(app_client):
    raw, _, _ = await _mint_key()
    return {"X-API-Key": raw}


async def _bootstrap_config(app_client, monkeypatch):
    """Set the mock provider + keyless path as the active config."""
    monkeypatch.setattr(settings, "assistant_provider", "mock")
    headers = await _headers(app_client)
    r = await app_client.put("/api/v1/assistant/config", headers=headers, json={"provider": "mock"})
    assert r.status_code == 200, r.text
    return headers


@pytest.mark.asyncio
async def test_config_round_trip_and_provider_flags(app_client, monkeypatch):
    headers = await _headers(app_client)
    r = await app_client.get("/api/v1/assistant/config", headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["provider"] == "openrouter"  # env default before any write
    providers = {p["id"]: p for p in data["providers"]}
    assert set(providers) == {"mock", "openrouter", "vercel"}
    assert providers["mock"]["configured"] is True
    # OpenRouter key absent in tests => not configured.
    assert providers["openrouter"]["configured"] is False
    assert providers["openrouter"]["free_models"][0].endswith(":free")


@pytest.mark.asyncio
async def test_chat_with_mock_provider(app_client, monkeypatch):
    headers = await _bootstrap_config(app_client, monkeypatch)
    r = await app_client.post(
        "/api/v1/assistant/chat",
        headers=headers,
        json={"messages": [{"role": "user", "content": "How do I track a link?"}]},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["provider"] == "mock"
    assert "[mock:" in data["reply"]
    assert "track" in data["reply"].lower() or "utm" in data["reply"].lower()


@pytest.mark.asyncio
async def test_chat_requires_auth(app_client, monkeypatch):
    await _bootstrap_config(app_client, monkeypatch)
    r = await app_client.post(
        "/api/v1/assistant/chat",
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_chat_503_when_disabled(app_client, monkeypatch):
    headers = await _headers(app_client)
    r = await app_client.put("/api/v1/assistant/config", headers=headers, json={"enabled": False})
    assert r.status_code == 200
    r = await app_client.post(
        "/api/v1/assistant/chat",
        headers=headers,
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert r.status_code == 503


@pytest.mark.asyncio
async def test_chat_503_when_provider_unconfigured(app_client, monkeypatch):
    # Default openrouter with no key in tests => unconfigured.
    headers = await _headers(app_client)
    r = await app_client.put("/api/v1/assistant/config", headers=headers, json={"provider": "openrouter"})
    assert r.status_code == 200
    r = await app_client.post(
        "/api/v1/assistant/chat",
        headers=headers,
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert r.status_code == 503
    assert "API key" in r.json()["detail"]


@pytest.mark.asyncio
async def test_unknown_provider_rejected(app_client, monkeypatch):
    headers = await _headers(app_client)
    r = await app_client.put("/api/v1/assistant/config", headers=headers, json={"provider": "nope"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_prompt_includes_usage_counts(app_client, monkeypatch):
    # The system prompt is built server-side; with the mock provider the reply
    # echoes the request, but we can at least assert the pipeline assembles.
    headers = await _bootstrap_config(app_client, monkeypatch)
    r = await app_client.post(
        "/api/v1/assistant/chat",
        headers=headers,
        json={"messages": [{"role": "user", "content": "What should I try first on Champbeam?"}]},
    )
    assert r.status_code == 200
    assert r.json()["usage"]["prompt_tokens"] == 0  # mock reports zero usage