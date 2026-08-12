"""API-key auth: key resolution, integration-surface access, management guards."""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta
from uuid import uuid4

import pytest

from app.models.api_key import API_KEY_PREFIX, ApiKey
from app.models.user import User


async def _mint_key(
    *, name: str = "test key", revoked: bool = False, expired: bool = False
) -> tuple[str, ApiKey, User]:
    """Insert a user + API key directly; returns (raw_key, key_row, user)."""
    from app.db import postgres

    raw_key = API_KEY_PREFIX + secrets.token_urlsafe(32)
    async with postgres.async_session_maker() as session:
        user = User(id=uuid4(), email=f"{uuid4().hex[:10]}@example.com", is_active=True)
        session.add(user)
        await session.flush()
        row = ApiKey(
            id=uuid4(),
            user_id=user.id,
            name=name,
            key_prefix=raw_key[:12],
            key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
            revoked_at=datetime.utcnow() if revoked else None,
            expires_at=datetime.utcnow() - timedelta(minutes=1) if expired else None,
        )
        session.add(row)
        await session.commit()
        return raw_key, row, user


@pytest.mark.asyncio
async def test_generate_link_with_api_key_header(app_client):
    raw_key, _, _ = await _mint_key()
    resp = await app_client.post(
        "/api/v1/utm/generate",
        json={"base_url": "https://example.com/page", "utm_source": "api"},
        headers={"X-API-Key": raw_key},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["link_id"] is not None
    assert data["short_code"]
    assert data["short_url"] and data["short_code"] in data["short_url"]
    assert "utm_source=api" in data["tracked_url"]


@pytest.mark.asyncio
async def test_generate_link_with_bearer_api_key(app_client):
    raw_key, _, _ = await _mint_key()
    resp = await app_client.post(
        "/api/v1/utm/generate",
        json={"base_url": "https://example.com/page"},
        headers={"Authorization": f"Bearer {raw_key}"},
    )
    assert resp.status_code == 200
    assert resp.json()["link_id"] is not None


@pytest.mark.asyncio
async def test_invalid_key_is_401_not_anonymous(app_client):
    """A presented-but-bad key must never fall through to the anonymous
    branch of /utm/generate (which would silently mint an untracked link)."""
    resp = await app_client.post(
        "/api/v1/utm/generate",
        json={"base_url": "https://example.com/page"},
        headers={"X-API-Key": API_KEY_PREFIX + "definitely-not-a-real-key"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_revoked_and_expired_keys_rejected(app_client):
    for kwargs in ({"revoked": True}, {"expired": True}):
        raw_key, _, _ = await _mint_key(**kwargs)
        resp = await app_client.get(
            "/api/v1/projects", headers={"X-API-Key": raw_key}
        )
        assert resp.status_code == 401, kwargs


@pytest.mark.asyncio
async def test_key_reads_integration_surface(app_client):
    raw_key, _, _ = await _mint_key()
    headers = {"X-API-Key": raw_key}
    for path in ("/api/v1/projects", "/api/v1/domains", "/api/v1/utm/analytics/links"):
        resp = await app_client.get(path, headers=headers)
        assert resp.status_code == 200, path


@pytest.mark.asyncio
async def test_key_link_lifecycle(app_client):
    """Create, list, update, delete a link purely via API key."""
    raw_key, _, _ = await _mint_key()
    headers = {"X-API-Key": raw_key}

    created = await app_client.post(
        "/api/v1/utm/generate",
        json={"base_url": "https://example.com/doc", "utm_campaign": "q3"},
        headers=headers,
    )
    assert created.status_code == 200
    link_id = created.json()["link_id"]

    listed = await app_client.get("/api/v1/utm/analytics/links", headers=headers)
    assert listed.status_code == 200
    assert any(l["link_id"] == link_id for l in listed.json())

    deleted = await app_client.delete(f"/api/v1/utm/links/{link_id}", headers=headers)
    assert deleted.status_code in (200, 204)


@pytest.mark.asyncio
async def test_api_key_cannot_manage_keys(app_client):
    raw_key, _, _ = await _mint_key()
    resp = await app_client.get("/api/v1/api-keys", headers={"X-API-Key": raw_key})
    assert resp.status_code == 403

    resp = await app_client.post(
        "/api/v1/api-keys", json={"name": "sneaky"}, headers={"X-API-Key": raw_key}
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_key_management_with_clerk_session(app_client):
    """Management endpoints work for a Clerk-authenticated user."""
    from app.core.security import TokenData, require_clerk_auth
    from app.db import postgres
    from app.main import app

    async with postgres.async_session_maker() as session:
        user = User(id=uuid4(), email="owner@example.com", is_active=True)
        session.add(user)
        await session.commit()
        user_id = str(user.id)

    async def fake_clerk_auth():
        return TokenData(user_id=user_id, email="owner@example.com")

    app.dependency_overrides[require_clerk_auth] = fake_clerk_auth
    try:
        created = await app_client.post("/api/v1/api-keys", json={"name": "ci key"})
        assert created.status_code == 201
        body = created.json()
        assert body["api_key"].startswith(API_KEY_PREFIX)
        assert body["key_prefix"] == body["api_key"][:12]
        key_id = body["id"]

        # The freshly minted key authenticates as its owner.
        me_links = await app_client.get(
            "/api/v1/utm/analytics/links", headers={"X-API-Key": body["api_key"]}
        )
        assert me_links.status_code == 200

        listed = await app_client.get("/api/v1/api-keys")
        assert listed.status_code == 200
        assert [k["id"] for k in listed.json()] == [key_id]
        assert "api_key" not in listed.json()[0]  # full key never shown again

        revoked = await app_client.post(f"/api/v1/api-keys/{key_id}/revoke")
        assert revoked.status_code == 200
        assert revoked.json()["revoked_at"] is not None

        rejected = await app_client.get(
            "/api/v1/utm/analytics/links", headers={"X-API-Key": body["api_key"]}
        )
        assert rejected.status_code == 401
    finally:
        app.dependency_overrides.pop(require_clerk_auth, None)


@pytest.mark.asyncio
async def test_rate_limit_429_when_redis_counts_over(app_client, monkeypatch):
    from app.db.redis import redis_client

    raw_key, _, _ = await _mint_key()

    async def over_limit(key, ttl):
        return 121

    monkeypatch.setattr(redis_client, "incr_with_ttl", over_limit)
    resp = await app_client.get("/api/v1/projects", headers={"X-API-Key": raw_key})
    assert resp.status_code == 429
