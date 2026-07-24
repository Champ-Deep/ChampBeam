"""Tests for the team hierarchy (Slice 2): role tiers + leader-scoped analytics.

Roles: a super admin (role ending in "admin") sees the whole org; a leader sees
only the reps assigned to them (+ their own activity); a plain member sees no
team analytics. Super admins assign reps to leaders via PATCH /org/members/{id}.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime
from typing import AsyncGenerator, Optional

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.security import TokenData, require_auth
from app.models.content import ContentShare
from app.models.org import Organization, OrganizationMembership
from app.models.user import User
from app.models.utm import ClickEvent

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def team_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
    from app.db.postgres import Base, get_db_session
    from app.main import app
    from app.middleware.rate_limit import limiter

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

    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[require_auth] = override_auth

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, maker

    app.dependency_overrides.clear()
    await engine.dispose()


def _token(user_id: str, role: str) -> TokenData:
    return TokenData(
        user_id=user_id, email=f"{user_id}@example.com", clerk_user_id="u_" + user_id[:6],
        org_id="org_test", org_role=role, org_slug="acme",
    )


async def _seed_team(maker) -> dict[str, str]:
    """admin, leader, rep1 (reports to leader), rep2 (unassigned)."""
    ids = {k: str(_uuid.uuid4()) for k in ("admin", "leader", "rep1", "rep2")}
    async with maker() as s:
        s.add_all([
            User(id=_uuid.UUID(ids["admin"]), clerk_id="u_a", email="a@e.com", full_name="Admin"),
            User(id=_uuid.UUID(ids["leader"]), clerk_id="u_l", email="l@e.com", full_name="Leah Leader"),
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


async def _add_clicks(maker, link_id: str, ips: list[str]) -> None:
    async with maker() as s:
        for ip in ips:
            s.add(ClickEvent(id=_uuid.uuid4(), link_id=_uuid.UUID(link_id), ip_address=ip, clicked_at=datetime.utcnow()))
        await s.commit()


async def _link_id(maker, content_id: str, user_id: str) -> str:
    async with maker() as s:
        row = (await s.execute(
            select(ContentShare).where(
                ContentShare.content_id == _uuid.UUID(content_id),
                ContentShare.shared_by_user_id == _uuid.UUID(user_id),
            )
        )).scalar_one()
        return str(row.link_id)


async def _setup_content_with_shares(client, maker, ids) -> str:
    """Admin creates content; rep1 and rep2 each share; clicks land on each."""
    _CURRENT["token"] = _token(ids["admin"], "admin")
    content_id = (await client.post("/api/v1/content", json={
        "title": "Deck", "kind": "link", "canonical_url": "https://e.com/deck",
    })).json()["id"]

    _CURRENT["token"] = _token(ids["rep1"], "member")
    assert (await client.post(f"/api/v1/content/{content_id}/share", json={})).status_code == 201
    _CURRENT["token"] = _token(ids["rep2"], "member")
    assert (await client.post(f"/api/v1/content/{content_id}/share", json={})).status_code == 201

    await _add_clicks(maker, await _link_id(maker, content_id, ids["rep1"]), ["1.1.1.1", "1.1.1.2"])
    await _add_clicks(maker, await _link_id(maker, content_id, ids["rep2"]), ["2.2.2.1", "2.2.2.2", "2.2.2.3"])
    return content_id


@pytest.mark.asyncio
async def test_super_admin_sees_all_leader_sees_only_their_reps(team_ctx):
    client, maker = team_ctx
    ids = await _seed_team(maker)
    content_id = await _setup_content_with_shares(client, maker, ids)

    # Super admin: both reps roll up (2 sharers, 5 opens).
    _CURRENT["token"] = _token(ids["admin"], "admin")
    admin_item = (await client.get("/api/v1/org/analytics/content")).json()["items"][0]
    assert admin_item["shares"] == 2
    assert admin_item["opens"] == 5

    # Leader: only rep1 (their rep) counts — 1 share, 2 opens. rep2 is excluded.
    _CURRENT["token"] = _token(ids["leader"], "leader")
    report = (await client.get("/api/v1/org/analytics/content")).json()
    leader_item = next(i for i in report["items"] if i["content_id"] == content_id)
    assert leader_item["shares"] == 1
    assert leader_item["opens"] == 2

    # Leader roster is scoped to themselves + their reps (no rep2).
    roster = {m["full_name"] for m in (await client.get("/api/v1/org/members")).json()}
    assert roster == {"Leah Leader", "Rep One"}

    # Breakdown for the leader shows only rep1.
    bd = (await client.get(f"/api/v1/org/analytics/content/{content_id}")).json()
    assert [m["full_name"] for m in bd["members"]] == ["Rep One"]
    assert bd["opens"] == 2


@pytest.mark.asyncio
async def test_plain_member_cannot_see_team_analytics(team_ctx):
    client, maker = team_ctx
    ids = await _seed_team(maker)
    _CURRENT["token"] = _token(ids["rep2"], "member")
    assert (await client.get("/api/v1/org/members")).status_code == 403
    assert (await client.get("/api/v1/org/analytics/content")).status_code == 403


@pytest.mark.asyncio
async def test_admin_assigns_rep_to_leader_and_scope_updates(team_ctx):
    client, maker = team_ctx
    ids = await _seed_team(maker)
    content_id = await _setup_content_with_shares(client, maker, ids)

    # Before: leader sees only rep1.
    _CURRENT["token"] = _token(ids["leader"], "leader")
    before = next(i for i in (await client.get("/api/v1/org/analytics/content")).json()["items"]
                  if i["content_id"] == content_id)
    assert before["shares"] == 1

    # A member cannot assign leaders.
    _CURRENT["token"] = _token(ids["rep1"], "member")
    assert (await client.patch(f"/api/v1/org/members/{ids['rep2']}",
                               json={"leader_user_id": ids["leader"]})).status_code == 403

    # Super admin assigns rep2 to the leader.
    _CURRENT["token"] = _token(ids["admin"], "admin")
    r = await client.patch(f"/api/v1/org/members/{ids['rep2']}", json={"leader_user_id": ids["leader"]})
    assert r.status_code == 200, r.text
    assert r.json()["leader_user_id"] == ids["leader"]

    # Now the leader sees both reps (2 shares, 5 opens).
    _CURRENT["token"] = _token(ids["leader"], "leader")
    after = next(i for i in (await client.get("/api/v1/org/analytics/content")).json()["items"]
                 if i["content_id"] == content_id)
    assert after["shares"] == 2
    assert after["opens"] == 5


@pytest.mark.asyncio
async def test_assign_leader_validation(team_ctx):
    client, maker = team_ctx
    ids = await _seed_team(maker)
    _CURRENT["token"] = _token(ids["admin"], "admin")

    # Self-lead rejected.
    assert (await client.patch(f"/api/v1/org/members/{ids['rep1']}",
                               json={"leader_user_id": ids["rep1"]})).status_code == 400
    # Target that isn't a leader/admin rejected.
    assert (await client.patch(f"/api/v1/org/members/{ids['rep1']}",
                               json={"leader_user_id": ids["rep2"]})).status_code == 400
    # Clearing the assignment works.
    ok = await client.patch(f"/api/v1/org/members/{ids['rep1']}", json={"leader_user_id": None})
    assert ok.status_code == 200
    assert ok.json()["leader_user_id"] is None
