"""Tests for access controls / security console (Slice A):

self-destruct (view cap, expiry, revoke), the email gate + lead capture, and
VPN blocking — enforced on the public /r and /f serve paths — plus the owner
config endpoints. Storage isn't configured in tests, so an *allowed* file serve
returns 503 after passing the gates; we assert on the gate outcome (410 vs not).
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.security import TokenData, require_auth
from app.models.access_lead import AccessLead
from app.models.file_asset import FileAsset
from app.models.user import User
from app.models.utm import LinkClick

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def ac_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
    import importlib
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
        async with maker() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
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


async def _seed_user(maker) -> str:
    uid = _uuid.uuid4()
    async with maker() as s:
        s.add(User(id=uid, clerk_id="u", email="u@e.com"))
        await s.commit()
    return str(uid)


async def _seed_link(maker, user_id, code, **kw) -> str:
    lid = _uuid.uuid4()
    async with maker() as s:
        s.add(LinkClick(
            id=lid, user_id=_uuid.UUID(user_id), short_code=code,
            original_url="https://example.com", tracked_url="https://example.com", **kw,
        ))
        await s.commit()
    return str(lid)


def _token(user_id):
    return TokenData(user_id=user_id, email="u@e.com", clerk_user_id="u")


# ----------------------------------------------------------------------------
# Self-destruct — links
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_view_cap_self_destructs(ac_ctx):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    lid = await _seed_link(maker, uid, "cap123", max_views=2)

    r1 = await client.get("/r/cap123", headers={"X-Forwarded-For": "1.1.1.1"})
    r2 = await client.get("/r/cap123", headers={"X-Forwarded-For": "1.1.1.2"})
    r3 = await client.get("/r/cap123", headers={"X-Forwarded-For": "1.1.1.3"})
    assert r1.status_code == 302 and r2.status_code == 302
    assert r3.status_code == 410  # burned after 2 views
    assert "View limit reached" in r3.text

    async with maker() as s:
        link = await s.get(LinkClick, _uuid.UUID(lid))
        assert link.click_count == 2  # cap never exceeded


@pytest.mark.asyncio
async def test_link_expiry_and_revoke_block(ac_ctx):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    await _seed_link(maker, uid, "exp123", expires_at=datetime.utcnow() - timedelta(hours=1))
    await _seed_link(maker, uid, "rev123", revoked_at=datetime.utcnow())

    assert (await client.get("/r/exp123")).status_code == 410
    assert (await client.get("/r/rev123")).status_code == 410


# ----------------------------------------------------------------------------
# Email gate + lead capture — links
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_email_gate_captures_lead_then_grants(ac_ctx):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    lid = await _seed_link(maker, uid, "gate123", require_email=True)

    # No cookie -> gate page (200 HTML), not a redirect.
    g = await client.get("/r/gate123")
    assert g.status_code == 200 and "Enter your email" in g.text

    # Bad email -> gate page with error, no lead.
    bad = await client.post("/r/gate123/unlock", data={"email": "nope"})
    assert bad.status_code == 200

    # Good email -> 303 + cookie set + lead captured.
    ok = await client.post("/r/gate123/unlock", data={"email": "buyer@corp.com"},
                           headers={"X-Forwarded-For": "9.9.9.9"})
    assert ok.status_code == 303
    assert "cbgate_" in ok.headers.get("set-cookie", "")

    # The cookie is now in the jar -> access granted.
    after = await client.get("/r/gate123")
    assert after.status_code == 302

    # Lead visible to the owner.
    _CURRENT["token"] = _token(uid)
    leads = (await client.get(f"/api/v1/utm/links/{lid}/leads")).json()
    assert [l["email"] for l in leads] == ["buyer@corp.com"]


# ----------------------------------------------------------------------------
# VPN block — links
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_block_vpn(ac_ctx, monkeypatch):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    await _seed_link(maker, uid, "vpn123", block_vpn=True)

    import app.services.geoip_service as geo

    async def fake_lookup(ip):
        return {"is_vpn": ip == "6.6.6.6"}

    monkeypatch.setattr(geo, "lookup_ip", fake_lookup)

    blocked = await client.get("/r/vpn123", headers={"X-Forwarded-For": "6.6.6.6"})
    assert blocked.status_code == 410 and "Access blocked" in blocked.text
    ok = await client.get("/r/vpn123", headers={"X-Forwarded-For": "1.2.3.4"})
    assert ok.status_code == 302


# ----------------------------------------------------------------------------
# Owner config endpoint + status
# ----------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_set_link_access_and_status(ac_ctx):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    lid = await _seed_link(maker, uid, "cfg123")
    _CURRENT["token"] = _token(uid)

    # Plain link starts as "tracking".
    assert (await client.get(f"/api/v1/utm/links/{lid}/access")).json()["access_status"] == "tracking"

    r = await client.put(f"/api/v1/utm/links/{lid}/access", json={
        "max_views": 5, "expires_in_hours": 24, "require_email": True, "branded": True,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["max_views"] == 5 and body["remaining_views"] == 5
    assert body["require_email"] is True and body["branded"] is True
    assert body["access_status"] == "expiring"

    # Revoke, then clearing a limit with 0.
    assert (await client.put(f"/api/v1/utm/links/{lid}/access", json={"revoked": True})).json()["revoked"] is True
    cleared = await client.put(f"/api/v1/utm/links/{lid}/access", json={"max_views": 0, "revoked": False})
    assert cleared.json()["max_views"] is None


# ----------------------------------------------------------------------------
# Files
# ----------------------------------------------------------------------------


async def _seed_file(maker, user_id, code, **kw) -> str:
    fid = _uuid.uuid4()
    async with maker() as s:
        s.add(FileAsset(
            id=fid, user_id=_uuid.UUID(user_id), short_code=code, filename="deck.pdf",
            kind="pdf", mime_type="application/pdf", size_bytes=10, storage_key="k",
            status="active", serve_mode="stream", **kw,
        ))
        await s.commit()
    return str(fid)


@pytest.mark.asyncio
async def test_file_view_cap_and_config(ac_ctx):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    fid = await _seed_file(maker, uid, "file123")
    _CURRENT["token"] = _token(uid)

    # Configure: burn after 1 view.
    resp = await client.put(f"/api/v1/files/{fid}/access", json={"max_views": 1})
    assert resp.status_code == 200
    assert resp.json()["max_views"] == 1 and resp.json()["access_status"] == "expiring"
    assert resp.json()["remaining_views"] == 1

    # Simulate one prior view, so the cap is now reached; the serve gate trips
    # (asserting the gate without exercising real storage streaming).
    async with maker() as s:
        f = await s.get(FileAsset, _uuid.UUID(fid))
        f.view_count = 1
        await s.commit()

    served = await client.get("/f/file123", headers={"X-Forwarded-For": "1.1.1.2"})
    assert served.status_code == 410 and "View limit reached" in served.text

    # Config now reads as expired.
    assert (await client.get("/api/v1/files"))  # sanity: list endpoint works
    st = [f for f in (await client.get("/api/v1/files")).json() if f["id"] == fid][0]
    assert st["access_status"] == "expired" and st["remaining_views"] == 0


@pytest.mark.asyncio
async def test_file_email_gate_and_leads(ac_ctx):
    client, maker = ac_ctx
    uid = await _seed_user(maker)
    fid = await _seed_file(maker, uid, "fgate1", require_email=True)

    g = await client.get("/f/fgate1")
    assert g.status_code == 200 and "Enter your email" in g.text
    ok = await client.post("/f/fgate1/unlock", data={"email": "lead@corp.com"})
    assert ok.status_code == 303

    _CURRENT["token"] = _token(uid)
    leads = (await client.get(f"/api/v1/files/{fid}/leads")).json()
    assert [l["email"] for l in leads] == ["lead@corp.com"]
