"""Integration tests for Hosted Briefing Rooms + identified visit tracking
(functional spec Modules B & C).

Covers the Slice-1 spine: create/publish/archive a room, mint a per-recipient
tokenized link, resolve it publicly with personalization, ingest engagement
events (identified + anonymous/forwarded), and read the self-ranking engagement
score. No network — the app runs against in-memory SQLite.

Maps to docs/TESTING.md § Briefing Rooms: ROOM-1..7.
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

from app.core.security import TokenData, require_auth
from app.models.org import Organization, OrganizationMembership
from app.models.user import User

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def room_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
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


async def _seed_org(maker) -> str:
    member_id = str(_uuid.uuid4())
    async with maker() as s:
        s.add(User(id=_uuid.UUID(member_id), clerk_id="u_m", email="m@example.com", full_name="Rep One"))
        org = Organization(id=_uuid.uuid4(), clerk_org_id="org_test", name="Acme", slug="acme")
        s.add(org)
        await s.flush()
        s.add(OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(member_id), role="member"))
        await s.commit()
    return member_id


async def _make_room(client) -> dict:
    resp = await client.post("/api/v1/rooms", json={
        "title": "Ferrovial Briefing",
        "bucket": "infrastructure",
        "asset_ids": ["asset_deck", "asset_video"],
        "personalization": {
            "prepared_for_line": "Prepared for {{company_name}}'s leadership team",
        },
    })
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_room1_create_publish_and_slug(room_ctx):
    """ROOM-1: a rep creates a draft room (unique slug, assets stored) and publishes it."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)

    room = await _make_room(client)
    assert room["state"] == "draft"
    assert room["slug"].startswith("ferrovial-briefing")
    assert room["asset_ids"] == ["asset_deck", "asset_video"]

    pub = await client.post(f"/api/v1/rooms/{room['id']}/publish")
    assert pub.status_code == 200
    assert pub.json()["state"] == "published"


@pytest.mark.asyncio
async def test_room2_recipient_link_is_unique_and_tokenized(room_ctx):
    """ROOM-2: each recipient gets a unique tokenized link to the room."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    room = await _make_room(client)

    r1 = (await client.post(f"/api/v1/rooms/{room['id']}/recipients", json={
        "name": "Ana García", "company": "Ferrovial", "email": "ana@ferrovial.com",
    })).json()
    r2 = (await client.post(f"/api/v1/rooms/{room['id']}/recipients", json={
        "name": "Luis Pérez", "company": "Acciona",
    })).json()

    assert r1["token"] and r2["token"] and r1["token"] != r2["token"]
    assert r1["url"].endswith(f"?t={r1['token']}")
    assert f"/rooms/{room['slug']}" in r1["url"]


@pytest.mark.asyncio
async def test_room3_public_resolve_personalizes_by_token(room_ctx):
    """ROOM-3: the public resolve endpoint renders per-recipient personalization
    when a valid token is supplied, and stays anonymous without one."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    room = await _make_room(client)
    await client.post(f"/api/v1/rooms/{room['id']}/publish")
    recip = (await client.post(f"/api/v1/rooms/{room['id']}/recipients", json={
        "name": "Ana García", "company": "Ferrovial",
    })).json()

    identified = (await client.get(f"/api/v1/rooms/public/{room['slug']}?t={recip['token']}")).json()
    assert identified["identified"] is True
    assert identified["personalization"]["prepared_for_line"] == "Prepared for Ferrovial's leadership team"
    assert identified["asset_ids"] == ["asset_deck", "asset_video"]

    anon = (await client.get(f"/api/v1/rooms/public/{room['slug']}")).json()
    assert anon["identified"] is False
    assert "your team" in anon["personalization"]["prepared_for_line"]


@pytest.mark.asyncio
async def test_room4_draft_hidden_archived_shows_ended(room_ctx):
    """ROOM-4: a draft room is 404 publicly; an archived room resolves with
    ended=True (branded "briefing has ended", never a 404)."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    room = await _make_room(client)

    # Draft → not resolvable publicly.
    assert (await client.get(f"/api/v1/rooms/public/{room['slug']}")).status_code == 404

    await client.post(f"/api/v1/rooms/{room['id']}/publish")
    assert (await client.get(f"/api/v1/rooms/public/{room['slug']}")).status_code == 200

    await client.post(f"/api/v1/rooms/{room['id']}/archive")
    ended = (await client.get(f"/api/v1/rooms/public/{room['slug']}")).json()
    assert ended["state"] == "archived"
    assert ended["ended"] is True


@pytest.mark.asyncio
async def test_room5_track_events_and_engagement_score(room_ctx):
    """ROOM-5: identified events ingest against the recipient and roll into a
    self-ranking engagement score (video 30 + return 20 + cta 20 + dwell 10 = 80)."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    room = await _make_room(client)
    await client.post(f"/api/v1/rooms/{room['id']}/publish")
    recip = (await client.post(f"/api/v1/rooms/{room['id']}/recipients", json={
        "name": "Ana García", "company": "Ferrovial",
    })).json()
    tok = recip["token"]
    slug = room["slug"]

    async def track(type_, payload=None, session_id="s1"):
        r = await client.post("/api/v1/rooms/track", json={
            "slug": slug, "type": type_, "token": tok,
            "session_id": session_id, "payload": payload or {},
        })
        assert r.status_code == 204, r.text

    await track("page_view", session_id="s1")
    await track("video_progress", {"percent": 80, "asset_id": "asset_video"}, "s1")
    await track("cta_click", {"kind": "booking"}, "s1")
    await track("session", {"duration_s": 200}, "s1")
    await track("page_view", session_id="s2")  # return visit (2nd session)

    analytics = (await client.get(f"/api/v1/rooms/{room['id']}/analytics")).json()
    assert len(analytics["recipients"]) == 1
    me = analytics["recipients"][0]
    assert me["company"] == "Ferrovial"
    assert me["score"] == 80  # 30 video + 20 return + 20 cta + 10 dwell
    assert me["events"] == 5


@pytest.mark.asyncio
async def test_room6_anonymous_forwarded_viewer_is_flagged(room_ctx):
    """ROOM-6: an event with no token is recorded anonymously (forwarded/unknown
    viewer) and surfaced as a signal, not attributed to a recipient."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    room = await _make_room(client)
    await client.post(f"/api/v1/rooms/{room['id']}/publish")

    r = await client.post("/api/v1/rooms/track", json={
        "slug": room["slug"], "type": "page_view", "session_id": "anon1",
    })
    assert r.status_code == 204

    analytics = (await client.get(f"/api/v1/rooms/{room['id']}/analytics")).json()
    assert analytics["recipients"] == []
    assert analytics["anonymous_events"] == 1
    assert analytics["anonymous_sessions"] == 1


@pytest.mark.asyncio
async def test_room7_unknown_event_type_and_bad_slug_rejected(room_ctx):
    """ROOM-7: an unknown event type is 400; tracking against a missing room is 404."""
    client, maker = room_ctx
    member_id = await _seed_org(maker)
    _CURRENT["token"] = _token(member_id)
    room = await _make_room(client)
    await client.post(f"/api/v1/rooms/{room['id']}/publish")

    bad_type = await client.post("/api/v1/rooms/track", json={
        "slug": room["slug"], "type": "keystroke", "session_id": "s",
    })
    assert bad_type.status_code == 400

    bad_slug = await client.post("/api/v1/rooms/track", json={
        "slug": "no-such-room", "type": "page_view", "session_id": "s",
    })
    assert bad_slug.status_code == 404
