"""Tests for soft assignments (Slice 3): leader → rep recommendations.

Soft = never gates sending. A leader recommends a ChampVault asset to one of
their reps; the rep sees it on their shelf; once the rep actually sends the
asset, the assignment's ``sent`` flips true (derived from the ContentShare).
"""

from __future__ import annotations

import importlib
import uuid as _uuid
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.integrations.champvault_client import Asset, ChampVault
from app.models.org import Organization, OrganizationMembership
from app.models.user import User

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def asg_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
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


def _token(user_id: str, role: str) -> TokenData:
    return TokenData(
        user_id=user_id, email=f"{user_id}@e.com", clerk_user_id="u_" + user_id[:6],
        org_id="org_test", org_role=role, org_slug="acme",
    )


async def _seed_team(maker) -> dict[str, str]:
    ids = {k: str(_uuid.uuid4()) for k in ("admin", "leader", "rep1", "rep2")}
    async with maker() as s:
        s.add_all([
            User(id=_uuid.UUID(ids["admin"]), clerk_id="u_a", email="a@e.com", full_name="Admin"),
            User(id=_uuid.UUID(ids["leader"]), clerk_id="u_l", email="l@e.com", full_name="Leader"),
            User(id=_uuid.UUID(ids["rep1"]), clerk_id="u_r1", email="r1@e.com", full_name="Rep One"),
            User(id=_uuid.UUID(ids["rep2"]), clerk_id="u_r2", email="r2@e.com", full_name="Rep Two"),
        ])
        org = Organization(id=_uuid.uuid4(), clerk_org_id="org_test", name="Acme", slug="acme")
        s.add(org)
        await s.flush()
        s.add_all([
            OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(ids["admin"]), role="admin"),
            OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(ids["leader"]), role="leader"),
            OrganizationMembership(
                organization_id=org.id, user_id=_uuid.UUID(ids["rep1"]), role="member",
                leader_user_id=_uuid.UUID(ids["leader"]),
            ),
            OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(ids["rep2"]), role="member"),
        ])
        await s.commit()
    return ids


def _configure_champvault(monkeypatch):
    monkeypatch.setattr(settings, "champvault_url", "https://vault.test")
    monkeypatch.setattr(settings, "champvault_api_key", "cvb_test")
    n = {"i": 0}

    async def fake_deliver(self, asset_id, expires_in_s=3600, timeout=None):
        n["i"] += 1
        return {"kind": "file", "url": f"https://vault.test/d/{asset_id}?v={n['i']}", "expiresAt": 9999}

    async def fake_get_asset(self, asset_id):
        return Asset.from_json({"id": asset_id, "title": f"Deck {asset_id}", "type": "deck",
                                "storage": "r2", "status": "published"})

    monkeypatch.setattr(ChampVault, "deliver", fake_deliver)
    monkeypatch.setattr(ChampVault, "get_asset", fake_get_asset)


@pytest.mark.asyncio
async def test_leader_assigns_and_scope_is_enforced(asg_ctx):
    client, maker = asg_ctx
    ids = await _seed_team(maker)

    # Leader assigns to their rep -> ok, not yet sent.
    _CURRENT["token"] = _token(ids["leader"], "leader")
    r = await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_a", "asset_title": "Pitch A", "assigned_to_user_id": ids["rep1"],
        "note": "Use this for enterprise leads",
    })
    assert r.status_code == 201, r.text
    assert r.json()["sent"] is False
    assert r.json()["asset_title"] == "Pitch A"

    # Leader cannot assign to a rep that isn't theirs.
    bad = await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_a", "assigned_to_user_id": ids["rep2"],
    })
    assert bad.status_code == 403

    # Super admin can assign to anyone.
    _CURRENT["token"] = _token(ids["admin"], "admin")
    assert (await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_a", "assigned_to_user_id": ids["rep2"],
    })).status_code == 201

    # Rep sees their assignment on their shelf.
    _CURRENT["token"] = _token(ids["rep1"], "member")
    mine = (await client.get("/api/v1/org/assignments/mine")).json()
    assert len(mine) == 1
    assert mine[0]["champvault_asset_id"] == "deck_a"
    assert mine[0]["sent"] is False


@pytest.mark.asyncio
async def test_sent_flips_true_after_rep_sends(asg_ctx, monkeypatch):
    client, maker = asg_ctx
    ids = await _seed_team(maker)
    _configure_champvault(monkeypatch)

    _CURRENT["token"] = _token(ids["leader"], "leader")
    await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_b", "assigned_to_user_id": ids["rep1"],
    })

    # Rep sends the asset from the library -> assignment now reads as sent.
    _CURRENT["token"] = _token(ids["rep1"], "member")
    assert (await client.post("/api/v1/champvault/assets/deck_b/beam", json={})).status_code == 201
    mine = (await client.get("/api/v1/org/assignments/mine")).json()
    assert mine[0]["sent"] is True

    # Leader's own list reflects the sent status too.
    _CURRENT["token"] = _token(ids["leader"], "leader")
    made = (await client.get("/api/v1/org/assignments")).json()
    assert made[0]["sent"] is True


@pytest.mark.asyncio
async def test_assignment_idempotent_update_and_delete(asg_ctx):
    client, maker = asg_ctx
    ids = await _seed_team(maker)
    _CURRENT["token"] = _token(ids["leader"], "leader")

    first = await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_c", "assigned_to_user_id": ids["rep1"], "note": "v1",
    })
    second = await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_c", "assigned_to_user_id": ids["rep1"], "note": "v2",
    })
    assert first.json()["id"] == second.json()["id"]  # same row, updated
    assert second.json()["note"] == "v2"

    # Rep has exactly one assignment for the asset.
    _CURRENT["token"] = _token(ids["rep1"], "member")
    assert len(( await client.get("/api/v1/org/assignments/mine")).json()) == 1

    # Leader withdraws it.
    _CURRENT["token"] = _token(ids["leader"], "leader")
    assert (await client.delete(f"/api/v1/org/assignments/{first.json()['id']}")).status_code == 204
    _CURRENT["token"] = _token(ids["rep1"], "member")
    assert (await client.get("/api/v1/org/assignments/mine")).json() == []


@pytest.mark.asyncio
async def test_plain_member_cannot_assign(asg_ctx):
    client, maker = asg_ctx
    ids = await _seed_team(maker)
    _CURRENT["token"] = _token(ids["rep2"], "member")
    assert (await client.post("/api/v1/org/assignments", json={
        "champvault_asset_id": "deck_a", "assigned_to_user_id": ids["rep1"],
    })).status_code == 403
    assert (await client.get("/api/v1/org/assignments")).status_code == 403
