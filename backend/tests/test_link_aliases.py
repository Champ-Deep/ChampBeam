"""Named short links: alias on generate, uniqueness, redirect resolution,
rename and clear via PATCH.
"""

from __future__ import annotations

import pytest

from tests.test_api_keys import _mint_key


async def _headers(app_client):
    raw, _, _ = await _mint_key()
    return {"X-API-Key": raw}


@pytest.mark.asyncio
async def test_generate_with_alias_and_redirect(app_client):
    headers = await _headers(app_client)
    r = await app_client.post(
        "/api/v1/utm/generate",
        headers=headers,
        json={"base_url": "https://example.com/campaign", "utm_source": "newsletter", "alias": "summit"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["alias"] == "summit"
    assert data["short_url"].endswith("/s/summit")
    assert data["redirect_url"].endswith("/r/summit")
    assert data["short_code"] is not None

    r = await app_client.get("/r/summit", follow_redirects=False)
    assert r.status_code == 302
    assert "utm_source=newsletter" in r.headers["location"]
    assert "example.com/campaign" in r.headers["location"]


@pytest.mark.asyncio
async def test_alias_taken_returns_409(app_client):
    headers = await _headers(app_client)
    body = {"base_url": "https://example.com/one", "alias": "taken"}
    r1 = await app_client.post("/api/v1/utm/generate", headers=headers, json=body)
    assert r1.status_code == 200, r1.text
    r2 = await app_client.post(
        "/api/v1/utm/generate", headers=headers,
        json={"base_url": "https://example.com/two", "alias": "taken"},
    )
    assert r2.status_code == 409
    assert "taken" in r2.json()["detail"]


@pytest.mark.asyncio
async def test_invalid_alias_rejected(app_client):
    headers = await _headers(app_client)
    r = await app_client.post(
        "/api/v1/utm/generate", headers=headers,
        json={"base_url": "https://example.com", "alias": "Bad Alias!"},
    )
    assert r.status_code == 400
    r = await app_client.post(
        "/api/v1/utm/generate", headers=headers,
        json={"base_url": "https://example.com", "alias": "api"},
    )
    assert r.status_code == 400  # reserved word


@pytest.mark.asyncio
async def test_alias_shared_by_dedup_keeps_name(app_client):
    headers = await _headers(app_client)
    body = {"base_url": "https://example.com/same", "utm_source": "x", "alias": "named"}
    r1 = await app_client.post("/api/v1/utm/generate", headers=headers, json=body)
    assert r1.status_code == 200
    # Same URL + same params: dedup returns the same link, now with the alias.
    r2 = await app_client.post("/api/v1/utm/generate", headers=headers, json=body)
    assert r2.status_code == 200
    assert r2.json()["link_id"] == r1.json()["link_id"]
    assert r2.json()["alias"] == "named"
    r = await app_client.get("/r/named", follow_redirects=False)
    assert r.status_code == 302


@pytest.mark.asyncio
async def test_patch_alias_rename_and_clear(app_client):
    headers = await _headers(app_client)
    created = (
        await app_client.post(
            "/api/v1/utm/generate",
            headers=headers,
            json={"base_url": "https://example.com/x", "alias": "old-name"},
        )
    ).json()

    r = await app_client.patch(
        f"/api/v1/utm/links/{created['link_id']}",
        headers=headers,
        json={"alias": "new-name"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["alias"] == "new-name"

    assert (await app_client.get("/r/old-name", follow_redirects=False)).status_code == 302
    r = await app_client.get("/r/new-name", follow_redirects=False)
    assert r.status_code == 302
    assert "example.com/x" in r.headers["location"]

    # Clearing the name releases the alias.
    r = await app_client.patch(
        f"/api/v1/utm/links/{created['link_id']}",
        headers=headers,
        json={"alias": ""},
    )
    assert r.status_code == 200
    assert r.json()["alias"] is None
    # Unknown key now falls through to the platform home redirect.
    r = await app_client.get("/r/new-name", follow_redirects=False)
    assert r.status_code == 302
    assert r.headers["location"] == "/"


@pytest.mark.asyncio
async def test_patch_alias_409_when_taken(app_client):
    headers = await _headers(app_client)
    a = (
        await app_client.post(
            "/api/v1/utm/generate", headers=headers,
            json={"base_url": "https://example.com/a", "alias": "first"},
        )
    ).json()
    b = (
        await app_client.post(
            "/api/v1/utm/generate", headers=headers,
            json={"base_url": "https://example.com/b", "alias": "second"},
        )
    ).json()
    r = await app_client.patch(
        f"/api/v1/utm/links/{b['link_id']}",
        headers=headers,
        json={"alias": "first"},
    )
    assert r.status_code == 409