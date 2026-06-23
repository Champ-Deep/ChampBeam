"""Integration tests for the org content library + consolidated analytics.

Exercises the full premier use case: an admin curates content, two members
share it via their own links, clicks land on each member's link, and the admin's
consolidated report rolls everything up under one content item — while a member
is blocked from the admin-only analytics.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.security import TokenData, require_auth
from app.models.content import ContentShare
from app.models.org import Organization, OrganizationMembership
from app.models.user import User
from app.models.utm import ClickEvent

# Holder so a test can switch which user the overridden auth returns.
_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def org_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
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
        user_id=user_id,
        email=f"{user_id}@example.com",
        clerk_user_id="u_" + user_id[:6],
        org_id="org_test",
        org_role=role,
        org_slug="acme",
    )


async def _seed_org(maker) -> tuple[str, str]:
    """Create an org with an admin + one member. Returns (admin_id, member_id)."""
    admin_id, member_id = str(_uuid.uuid4()), str(_uuid.uuid4())
    async with maker() as s:
        s.add(User(id=_uuid.UUID(admin_id), clerk_id="u_admin", email="admin@example.com", full_name="Ada Admin"))
        s.add(User(id=_uuid.UUID(member_id), clerk_id="u_member", email="mark@example.com", full_name="Mark Member"))
        org = Organization(id=_uuid.uuid4(), clerk_org_id="org_test", name="Acme", slug="acme")
        s.add(org)
        await s.flush()
        s.add(OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(admin_id), role="admin"))
        s.add(OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(member_id), role="member"))
        await s.commit()
    return admin_id, member_id


async def _link_id_for_share(maker, content_id: str, user_id: str) -> str:
    async with maker() as s:
        row = (await s.execute(
            select(ContentShare).where(
                ContentShare.content_id == _uuid.UUID(content_id),
                ContentShare.shared_by_user_id == _uuid.UUID(user_id),
            )
        )).scalar_one()
        return str(row.link_id)


async def _add_clicks(maker, link_id: str, ips: list[str]) -> None:
    async with maker() as s:
        for ip in ips:
            s.add(ClickEvent(id=_uuid.uuid4(), link_id=_uuid.UUID(link_id), ip_address=ip, clicked_at=datetime.utcnow()))
        await s.commit()


@pytest.mark.asyncio
async def test_content_share_and_consolidated_analytics(org_ctx):
    client, maker = org_ctx
    admin_id, member_id = await _seed_org(maker)

    # Admin curates a link content item.
    _CURRENT["token"] = _token(admin_id, "admin")
    resp = await client.post("/api/v1/content", json={
        "title": "Q3 Pitch", "kind": "link", "canonical_url": "https://example.com/pitch",
    })
    assert resp.status_code == 201, resp.text
    content_id = resp.json()["id"]

    # Admin shares it, then the member shares it — two distinct links.
    assert (await client.post(f"/api/v1/content/{content_id}/share", json={})).status_code == 201
    _CURRENT["token"] = _token(member_id, "member")
    assert (await client.post(f"/api/v1/content/{content_id}/share", json={})).status_code == 201

    admin_link = await _link_id_for_share(maker, content_id, admin_id)
    member_link = await _link_id_for_share(maker, content_id, member_id)
    assert admin_link != member_link

    # Clicks: admin link 3 opens / 2 unique; member link 5 opens / 5 unique.
    await _add_clicks(maker, admin_link, ["1.1.1.1", "1.1.1.1", "2.2.2.2"])
    await _add_clicks(maker, member_link, ["3.3.3.3", "4.4.4.4", "5.5.5.5", "6.6.6.6", "7.7.7.7"])

    # Member cannot see the admin analytics.
    assert (await client.get("/api/v1/org/analytics/content")).status_code == 403

    # Admin consolidated report: one content item, 8 opens, 7 unique, 2 sharers.
    _CURRENT["token"] = _token(admin_id, "admin")
    report = (await client.get("/api/v1/org/analytics/content")).json()
    assert report["total_content"] == 1
    assert report["total_shares"] == 2
    assert report["total_opens"] == 8
    item = report["items"][0]
    assert item["content_id"] == content_id
    assert item["opens"] == 8
    assert item["unique_opens"] == 7
    assert item["shares"] == 2
    assert item["sharing_members"] == 2

    # Per-member breakdown: member (5) ranks above admin (3).
    breakdown = (await client.get(f"/api/v1/org/analytics/content/{content_id}")).json()
    assert breakdown["opens"] == 8
    members = breakdown["members"]
    assert members[0]["opens"] == 5
    assert members[0]["full_name"] == "Mark Member"
    assert members[1]["opens"] == 3

    # Member roster reflects sharing activity.
    roster = (await client.get("/api/v1/org/members")).json()
    by_name = {m["full_name"]: m for m in roster}
    assert by_name["Mark Member"]["opens"] == 5
    assert by_name["Ada Admin"]["shares"] == 1


@pytest.mark.asyncio
async def test_org_context_and_member_gating(org_ctx):
    client, maker = org_ctx
    admin_id, member_id = await _seed_org(maker)

    _CURRENT["token"] = _token(member_id, "member")
    ctx = await client.get("/api/v1/org/context")
    assert ctx.status_code == 200
    body = ctx.json()
    assert body["org_id"] == "org_test"
    assert body["is_admin"] is False
    assert body["member_count"] == 2

    # A member can browse the library but not create content.
    assert (await client.get("/api/v1/content")).status_code == 200
    assert (await client.post("/api/v1/content", json={
        "title": "x", "kind": "link", "canonical_url": "https://e.com",
    })).status_code == 403
