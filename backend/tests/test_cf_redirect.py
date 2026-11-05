"""CF_REDIRECT_BASE hands every public request to the Cloudflare Worker (health stays local)."""

import pytest


@pytest.mark.asyncio
async def test_off_by_default(app_client, monkeypatch):
    monkeypatch.delenv("CF_REDIRECT_BASE", raising=False)
    r = await app_client.get("/r/abc123", follow_redirects=False)
    assert "champbeam.com" not in r.headers.get("location", "")


@pytest.mark.asyncio
async def test_redirects_get_with_query_and_keeps_health(app_client, monkeypatch):
    monkeypatch.setenv("CF_REDIRECT_BASE", "https://champbeam.com/")
    r = await app_client.get("/p/china-sourcing-guide?utm_source=mail", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "https://champbeam.com/p/china-sourcing-guide?utm_source=mail"
    assert r.headers["cache-control"] == "no-store"
    h = await app_client.get("/health", follow_redirects=False)
    assert h.status_code == 200


@pytest.mark.asyncio
async def test_post_keeps_method(app_client, monkeypatch):
    monkeypatch.setenv("CF_REDIRECT_BASE", "https://champbeam.com")
    r = await app_client.post("/r/abc123/unlock", data={"email": "a@b.co"}, follow_redirects=False)
    assert r.status_code == 307
    assert r.headers["location"] == "https://champbeam.com/r/abc123/unlock"
