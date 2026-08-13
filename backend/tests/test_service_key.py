"""Service-key lane (X-Service-Key): identity, allowlist scope, and pages."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.core.config import settings
from app.models.org import Organization, OrganizationMembership
from app.models.user import User

SERVICE_KEY = "sk_beam_test_key_0123456789abcdef0123456789abcdef"
HEADERS = {"X-Service-Key": SERVICE_KEY, "Content-Type": "application/json"}


async def _provision_service_identity(role: str = "admin") -> None:
    from app.db import postgres

    async with postgres.async_session_maker() as session:
        user = User(
            id=uuid4(), email="service+champ-workspace@championsmail.com", is_active=True
        )
        org = Organization(
            id=uuid4(), clerk_org_id="org_test_champions", name="Champions", slug="champions"
        )
        session.add_all([user, org])
        await session.flush()
        session.add(
            OrganizationMembership(
                id=uuid4(), organization_id=org.id, user_id=user.id, role=role
            )
        )
        await session.commit()


@pytest.fixture()
def service_key_env(monkeypatch):
    monkeypatch.setattr(settings, "service_api_keys", f"champ-workspace:{SERVICE_KEY}")


@pytest.mark.asyncio
async def test_full_workspace_contract(app_client, service_key_env):
    """The exact three-step contract from the handoff spec."""
    await _provision_service_identity()

    # 1. Register a workspace share URL as a library item.
    created = await app_client.post(
        "/api/v1/content",
        json={
            "title": "Eton Solutions - campaign plan",
            "kind": "link",
            "canonical_url": "https://workspace.example.com/share/AbC123",
        },
        headers=HEADERS,
    )
    assert created.status_code == 201, created.text
    content_id = created.json()["id"]

    # 2. Mint the tracked share link (empty body, as the workspace sends).
    shared = await app_client.post(
        f"/api/v1/content/{content_id}/share", headers={"X-Service-Key": SERVICE_KEY}
    )
    assert shared.status_code == 201, shared.text
    assert "share_url" in shared.json()

    # 3. Fallback lane: plain tracked short link, workspace field name "url".
    fallback = await app_client.post(
        "/api/v1/utm/generate",
        json={
            "url": "https://workspace.example.com/share/AbC123",
            "utm_source": "champ-workspace",
            "utm_medium": "share",
        },
        headers=HEADERS,
    )
    assert fallback.status_code == 200, fallback.text
    body = fallback.json()
    assert body["short_url"] and body["link_id"]


@pytest.mark.asyncio
async def test_scope_allowlist(app_client, service_key_env):
    await _provision_service_identity()
    key_only = {"X-Service-Key": SERVICE_KEY}

    # Valid key on non-allowlisted routes -> 403, reads especially.
    for method, path in [
        ("GET", "/api/v1/content"),
        ("GET", "/api/v1/auth/me"),
        ("GET", "/api/v1/utm/analytics/overview"),
        ("GET", "/api/v1/domains"),
        ("DELETE", "/api/v1/content/00000000-0000-0000-0000-000000000000"),
        ("GET", "/api/v1/api-keys"),
    ]:
        resp = await app_client.request(method, path, headers=key_only)
        assert resp.status_code == 403, (method, path, resp.status_code)

    # Bad key -> 401 even on allowlisted routes.
    resp = await app_client.post(
        "/api/v1/content",
        json={"title": "x", "kind": "link", "canonical_url": "https://e.com/1"},
        headers={"X-Service-Key": "wrong"},
    )
    assert resp.status_code == 401

    # No key configured at all -> 401 (header presented but map empty).
    settings_backup = settings.service_api_keys
    try:
        settings.service_api_keys = ""
        resp = await app_client.post(
            "/api/v1/utm/generate", json={"url": "https://e.com/2"}, headers=key_only
        )
        assert resp.status_code == 401
    finally:
        settings.service_api_keys = settings_backup


@pytest.mark.asyncio
async def test_unprovisioned_identity_is_401(app_client, service_key_env):
    # Key is valid but no service user row exists.
    resp = await app_client.post(
        "/api/v1/utm/generate", json={"url": "https://e.com/3"}, headers=HEADERS
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_pages_publish_and_update(app_client, service_key_env, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    await _provision_service_identity()

    v1 = "<html><body><script>localStorage.done='1'</script>Checklist v1</body></html>"
    pub = await app_client.post(
        "/api/v1/pages",
        json={"title": "Prudhvi Onboarding", "html": v1},
        headers=HEADERS,
    )
    assert pub.status_code == 201, pub.text
    page = pub.json()
    assert page["url"].endswith(f"/f/{page['short_code']}")

    served = await app_client.get(f"/f/{page['short_code']}")
    assert served.status_code == 200 and "Checklist v1" in served.text

    upd = await app_client.put(
        f"/api/v1/pages/{page['page_id']}",
        json={"html": "<html><body>Checklist v2</body></html>"},
        headers=HEADERS,
    )
    assert upd.status_code == 200, upd.text
    assert upd.json()["short_code"] == page["short_code"]

    served2 = await app_client.get(f"/f/{page['short_code']}")
    assert "Checklist v2" in served2.text and "v1" not in served2.text

    # GET on pages does not exist and the service key must not unlock file reads.
    denied = await app_client.get(
        f"/api/v1/files/{page['page_id']}/summary", headers={"X-Service-Key": SERVICE_KEY}
    )
    assert denied.status_code == 403


@pytest.mark.asyncio
async def test_pages_with_user_api_key(app_client, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))

    from tests.test_api_keys import _mint_key

    raw_key, _, _ = await _mint_key()
    pub = await app_client.post(
        "/api/v1/pages",
        json={"title": "My checklist", "html": "<html><body>hi</body></html>"},
        headers={"X-API-Key": raw_key},
    )
    assert pub.status_code == 201, pub.text
