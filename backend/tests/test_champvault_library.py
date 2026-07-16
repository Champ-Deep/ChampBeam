"""Integration tests for the ChampVault library layer (Slice 1):

- per-user favorites (add / list / remove / idempotency / annotation on /assets),
- org-scoped sends: an org member "beams" a ChampVault asset and it is recorded
  as a ``ContentShare`` against a lazily-created shadow ``Content`` so it rolls
  up in the org's team analytics — the same consolidation the internal library
  already gives, now for external ChampVault assets.

The external ChampVault API is monkeypatched — no network.
"""

from __future__ import annotations

import importlib
import uuid as _uuid
from datetime import datetime
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.integrations.champvault_client import Asset, ChampVault
from app.models.content import Content, ContentShare
from app.models.org import Organization, OrganizationMembership
from app.models.user import User
from app.models.utm import ClickEvent

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def lib_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
    from app.db.postgres import Base, get_db_session
    from app.main import app
    from app.middleware.rate_limit import limiter

    utm_module = importlib.import_module("app.services.utm_service")

    limiter.reset()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(conn, _rec):
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def override_get_db():
        async with maker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def override_auth():
        return _CURRENT["token"]

    orig = utm_module.async_session_maker
    utm_module.async_session_maker = maker
    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[require_auth] = override_auth

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, maker

    app.dependency_overrides.clear()
    utm_module.async_session_maker = orig
    await engine.dispose()


def _token(user_id: str, role: str = "member") -> TokenData:
    return TokenData(
        user_id=user_id,
        email=f"{user_id}@example.com",
        clerk_user_id="u_" + user_id[:6],
        org_id="org_test",
        org_role=role,
        org_slug="acme",
    )


async def _seed_org(maker, *, members: int = 1) -> tuple[str, list[str]]:
    """Create an org with an admin + N members. Returns (admin_id, [member_ids])."""
    admin_id = str(_uuid.uuid4())
    member_ids = [str(_uuid.uuid4()) for _ in range(members)]
    async with maker() as s:
        s.add(User(id=_uuid.UUID(admin_id), clerk_id="u_admin", email="admin@example.com", full_name="Ada Admin"))
        org = Organization(id=_uuid.uuid4(), clerk_org_id="org_test", name="Acme", slug="acme")
        s.add(org)
        await s.flush()
        s.add(OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(admin_id), role="admin"))
        for i, mid in enumerate(member_ids):
            s.add(User(id=_uuid.UUID(mid), clerk_id=f"u_m{i}", email=f"m{i}@example.com", full_name=f"Member {i}"))
            s.add(OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(mid), role="member"))
        await s.commit()
    return admin_id, member_ids


def _configure_champvault(monkeypatch) -> dict:
    """Wire ChampVault as configured and stub deliver/get_asset. Returns a call counter."""
    monkeypatch.setattr(settings, "champvault_url", "https://vault.test")
    monkeypatch.setattr(settings, "champvault_api_key", "cvb_test")
    calls = {"deliver": 0}

    async def fake_deliver(self, asset_id, expires_in_s=3600, timeout=None):
        calls["deliver"] += 1
        return {"kind": "file", "url": f"https://vault.test/d/{asset_id}?v={calls['deliver']}", "expiresAt": 9999}

    async def fake_get_asset(self, asset_id):
        return Asset.from_json({
            "id": asset_id, "title": f"Deck {asset_id}", "type": "deck",
            "storage": "r2", "status": "published", "description": "A pitch deck",
        })

    monkeypatch.setattr(ChampVault, "deliver", fake_deliver)
    monkeypatch.setattr(ChampVault, "get_asset", fake_get_asset)
    return calls


async def _add_clicks(maker, link_id: str, ips: list[str]) -> None:
    async with maker() as s:
        for ip in ips:
            s.add(ClickEvent(id=_uuid.uuid4(), link_id=_uuid.UUID(link_id), ip_address=ip, clicked_at=datetime.utcnow()))
        await s.commit()


# ----------------------------------------------------------------------------
# Favorites
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_favorite_add_list_remove_and_annotation(lib_ctx, monkeypatch):
    client, maker = lib_ctx
    _admin, (member_id,) = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    _configure_champvault(monkeypatch)

    async def fake_list(self, **kwargs):
        return [
            Asset.from_json({"id": "a1", "title": "One", "type": "deck", "storage": "r2", "status": "published"}),
            Asset.from_json({"id": "a2", "title": "Two", "type": "pdf", "storage": "r2", "status": "published"}),
        ]

    monkeypatch.setattr(ChampVault, "list_assets", fake_list)

    # Favorite a1 (idempotent: twice is still one).
    assert (await client.put("/api/v1/champvault/assets/a1/favorite")).status_code == 204
    assert (await client.put("/api/v1/champvault/assets/a1/favorite")).status_code == 204

    # The favorites shelf resolves full asset details (works cross-search).
    favs = (await client.get("/api/v1/champvault/favorites")).json()
    assert [f["id"] for f in favs] == ["a1"]
    assert favs[0]["favorited"] is True
    assert favs[0]["title"] == "Deck a1"

    # /assets annotates the caller's favorite state.
    assets = {a["id"]: a for a in (await client.get("/api/v1/champvault/assets")).json()}
    assert assets["a1"]["favorited"] is True
    assert assets["a2"]["favorited"] is False

    # Remove it (idempotent).
    assert (await client.delete("/api/v1/champvault/assets/a1/favorite")).status_code == 204
    assert (await client.delete("/api/v1/champvault/assets/a1/favorite")).status_code == 204
    assert (await client.get("/api/v1/champvault/favorites")).json() == []


@pytest.mark.asyncio
async def test_favorites_shelf_skips_unresolvable_assets(lib_ctx, monkeypatch):
    client, maker = lib_ctx
    _admin, (member_id,) = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    monkeypatch.setattr(settings, "champvault_url", "https://vault.test")
    monkeypatch.setattr(settings, "champvault_api_key", "cvb_test")

    from app.integrations.champvault_client import ChampVaultError

    async def fake_get_asset(self, asset_id):
        if asset_id == "gone":
            raise ChampVaultError("get gone -> 404")
        return Asset.from_json({"id": asset_id, "title": f"Deck {asset_id}", "type": "deck",
                                "storage": "r2", "status": "published"})

    monkeypatch.setattr(ChampVault, "get_asset", fake_get_asset)

    for aid in ("live", "gone"):
        assert (await client.put(f"/api/v1/champvault/assets/{aid}/favorite")).status_code == 204

    # The unresolvable favorite is silently skipped; the live one still shows.
    favs = (await client.get("/api/v1/champvault/favorites")).json()
    assert [f["id"] for f in favs] == ["live"]


# ----------------------------------------------------------------------------
# Org-scoped sends -> team analytics
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_org_send_records_shadow_content_and_shows_in_analytics(lib_ctx, monkeypatch):
    client, maker = lib_ctx
    admin_id, (member_id,) = await _seed_org(maker)
    _configure_champvault(monkeypatch)

    # Member sends a ChampVault asset from the library.
    _CURRENT["token"] = _token(member_id)
    resp = await client.post("/api/v1/champvault/assets/asset_deck/beam", json={"expires_in_days": 7})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["content_id"] and body["link_id"]
    short_code = body["beam_url"].rsplit("/", 1)[1]

    # A single shadow Content + the member's ContentShare now exist.
    async with maker() as s:
        content = (await s.execute(
            select(Content).where(Content.champvault_asset_id == "asset_deck")
        )).scalar_one()
        assert content.title == "Deck asset_deck"
        share = (await s.execute(
            select(ContentShare).where(ContentShare.content_id == content.id)
        )).scalar_one()
        assert str(share.shared_by_user_id) == member_id
    content_id = body["content_id"]

    # Opens on the member's beam roll up in the org analytics.
    await _add_clicks(maker, body["link_id"], ["9.9.9.1", "9.9.9.2", "9.9.9.2"])

    _CURRENT["token"] = _token(admin_id, "admin")
    report = (await client.get("/api/v1/org/analytics/content")).json()
    item = next(i for i in report["items"] if i["content_id"] == content_id)
    assert item["opens"] == 3
    assert item["unique_opens"] == 2
    assert item["shares"] == 1

    roster = {m["user_id"]: m for m in (await client.get("/api/v1/org/members")).json()}
    assert roster[member_id]["shares"] == 1
    assert roster[member_id]["opens"] == 3

    # The beam still re-mints a fresh delivery URL on open.
    r = await client.get(f"/r/{short_code}", headers={"X-Forwarded-For": "10.0.0.9"})
    assert r.status_code == 302
    assert r.headers["location"].startswith("https://vault.test/d/asset_deck?v=")


@pytest.mark.asyncio
async def test_admin_adds_champvault_asset_to_library(lib_ctx, monkeypatch):
    """CVLIB-1: an admin adds a ChampVault asset to the Content Library; it becomes
    a shadow Content the whole team can then share (title resolved from ChampVault,
    champvault_asset_id surfaced, idempotent per org+asset)."""
    client, maker = lib_ctx
    admin_id, (member_id,) = await _seed_org(maker)
    _configure_champvault(monkeypatch)

    _CURRENT["token"] = _token(admin_id, "admin")
    resp = await client.post("/api/v1/content/from-champvault", json={"asset_id": "asset_deck"})
    assert resp.status_code == 201, resp.text
    item = resp.json()
    assert item["champvault_asset_id"] == "asset_deck"
    assert item["title"] == "Deck asset_deck"  # resolved from ChampVault
    assert item["kind"] == "link"
    content_id = item["id"]

    # Idempotent: re-adding the same asset returns the same library item.
    again = await client.post("/api/v1/content/from-champvault", json={"asset_id": "asset_deck"})
    assert again.status_code == 201
    assert again.json()["id"] == content_id

    # It shows up in the org library, and a member can share it (re-mintable).
    lib = (await client.get("/api/v1/content")).json()
    assert any(c["id"] == content_id and c["champvault_asset_id"] == "asset_deck" for c in lib)

    _CURRENT["token"] = _token(member_id)
    share = await client.post(f"/api/v1/content/{content_id}/share", json={})
    assert share.status_code == 201, share.text
    short_code = share.json()["share_url"].rsplit("/", 1)[1]
    r = await client.get(f"/r/{short_code}", headers={"X-Forwarded-For": "10.0.0.5"})
    assert r.status_code == 302
    assert r.headers["location"].startswith("https://vault.test/d/asset_deck?v=")


@pytest.mark.asyncio
async def test_admin_add_champvault_title_override_and_member_forbidden(lib_ctx, monkeypatch):
    """CVLIB-2: an explicit title skips the ChampVault lookup; a non-admin member
    cannot add to the library (admin-only)."""
    client, maker = lib_ctx
    admin_id, (member_id,) = await _seed_org(maker)
    _configure_champvault(monkeypatch)

    # A supplied title is used verbatim (no get_asset needed).
    async def _boom(self, asset_id):
        raise AssertionError("get_asset must not be called when a title is supplied")

    monkeypatch.setattr(ChampVault, "get_asset", _boom)

    _CURRENT["token"] = _token(admin_id, "admin")
    resp = await client.post(
        "/api/v1/content/from-champvault",
        json={"asset_id": "asset_z", "title": "Custom Q3 Pitch"},
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["title"] == "Custom Q3 Pitch"

    # Members can't add to the library.
    _CURRENT["token"] = _token(member_id)
    forbidden = await client.post("/api/v1/content/from-champvault", json={"asset_id": "asset_y", "title": "x"})
    assert forbidden.status_code == 403


@pytest.mark.asyncio
async def test_org_send_idempotent_and_consolidates_across_members(lib_ctx, monkeypatch):
    client, maker = lib_ctx
    admin_id, (m1, m2) = await _seed_org(maker, members=2)
    _configure_champvault(monkeypatch)

    # Member 1 sends twice (idempotent → one stable beam), member 2 sends once.
    _CURRENT["token"] = _token(m1)
    first = (await client.post("/api/v1/champvault/assets/asset_x/beam", json={})).json()
    second = (await client.post("/api/v1/champvault/assets/asset_x/beam", json={})).json()
    assert first["beam_url"] == second["beam_url"]

    _CURRENT["token"] = _token(m2)
    third = (await client.post("/api/v1/champvault/assets/asset_x/beam", json={})).json()
    assert third["content_id"] == first["content_id"]  # one shadow content for the org

    # Exactly one shadow Content, two ContentShares (one per member).
    async with maker() as s:
        contents = (await s.execute(
            select(Content).where(Content.champvault_asset_id == "asset_x")
        )).scalars().all()
        assert len(contents) == 1
        shares = (await s.execute(
            select(ContentShare).where(ContentShare.content_id == contents[0].id)
        )).scalars().all()
        assert len(shares) == 2

    await _add_clicks(maker, first["link_id"], ["1.0.0.1", "1.0.0.2"])
    await _add_clicks(maker, third["link_id"], ["2.0.0.1", "2.0.0.2", "2.0.0.3"])

    _CURRENT["token"] = _token(admin_id, "admin")
    report = (await client.get("/api/v1/org/analytics/content")).json()
    item = next(i for i in report["items"] if i["content_id"] == first["content_id"])
    assert item["opens"] == 5
    assert item["unique_opens"] == 5
    assert item["shares"] == 2
    assert item["sharing_members"] == 2
