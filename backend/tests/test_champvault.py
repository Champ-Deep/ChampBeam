"""Tests for the ChampVault connector: delivery-target selection, the beam
endpoint (mints a tracked link), and the redirect re-mint. The external
ChampVault API is monkeypatched — no network."""

from __future__ import annotations

import importlib
import uuid as _uuid
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.integrations import champvault_client as cvc
from app.integrations.champvault_client import Asset, ChampVault, delivery_target
from app.models.user import User
from app.models.utm import LinkClick

_CURRENT: dict[str, TokenData] = {}


def test_delivery_target_picks_player_for_video_and_url_for_file():
    assert delivery_target({"kind": "file", "url": "https://v/d/1?sig=x"}) == "https://v/d/1?sig=x"
    video = {"kind": "video", "hlsUrl": "https://s/h.m3u8", "iframeUrl": "https://s/iframe"}
    # Video must open the embeddable player, not the raw HLS manifest.
    assert delivery_target(video) == "https://s/iframe"


@pytest_asyncio.fixture(scope="function")
async def cv_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
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


async def _seed_user(maker) -> str:
    uid = _uuid.uuid4()
    async with maker() as s:
        s.add(User(id=uid, clerk_id="u_bd", email="bd@example.com"))
        await s.commit()
    return str(uid)


@pytest.mark.asyncio
async def test_beam_mints_tracked_link_and_redirect_remints(cv_ctx, monkeypatch):
    client, maker = cv_ctx
    user_id = await _seed_user(maker)
    _CURRENT["token"] = TokenData(user_id=user_id, email="bd@example.com", clerk_user_id="u_bd")

    # Pretend ChampVault is configured and stub its delivery (two calls: one at
    # beam time, a fresh one at redirect time).
    monkeypatch.setattr(settings, "champvault_url", "https://vault.test")
    monkeypatch.setattr(settings, "champvault_api_key", "cvb_test")

    calls = {"n": 0}

    async def fake_deliver(self, asset_id, expires_in_s=3600, timeout=None):
        calls["n"] += 1
        return {"kind": "file", "url": f"https://vault.test/d/{asset_id}?v={calls['n']}", "expiresAt": 9999}

    monkeypatch.setattr(ChampVault, "deliver", fake_deliver)

    # Beam an asset -> a tracked /r/ link.
    resp = await client.post("/api/v1/champvault/assets/asset_123/beam", json={"expires_in_days": 7})
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["asset_id"] == "asset_123"
    assert body["beam_url"].endswith("/r/" + body["beam_url"].rsplit("/", 1)[1])
    short_code = body["beam_url"].rsplit("/", 1)[1]

    # The link is stamped with the asset id (so the redirect knows to re-mint).
    async with maker() as s:
        link = (await s.execute(select(LinkClick).where(LinkClick.short_code == short_code))).scalar_one()
        assert link.champvault_asset_id == "asset_123"
        assert str(link.user_id) == user_id

    # Opening the beam re-mints a FRESH delivery URL (different ?v=) and redirects.
    r = await client.get(f"/r/{short_code}", headers={"X-Forwarded-For": "10.0.0.5"})
    assert r.status_code == 302
    assert r.headers["location"].startswith("https://vault.test/d/asset_123?v=")
    assert calls["n"] >= 2  # delivered once at beam, again at open


@pytest.mark.asyncio
async def test_beam_returns_503_when_not_configured(cv_ctx, monkeypatch):
    client, maker = cv_ctx
    user_id = await _seed_user(maker)
    _CURRENT["token"] = TokenData(user_id=user_id, email="bd@example.com", clerk_user_id="u_bd")

    monkeypatch.setattr(settings, "champvault_url", "")
    monkeypatch.setattr(settings, "champvault_api_key", "")

    resp = await client.post("/api/v1/champvault/assets/x/beam", json={})
    assert resp.status_code == 503

    cfg = await client.get("/api/v1/champvault/config")
    assert cfg.json() == {"configured": False}


@pytest.mark.asyncio
async def test_list_assets_proxies_published(cv_ctx, monkeypatch):
    client, maker = cv_ctx
    user_id = await _seed_user(maker)
    _CURRENT["token"] = TokenData(user_id=user_id, email="bd@example.com", clerk_user_id="u_bd")
    monkeypatch.setattr(settings, "champvault_url", "https://vault.test")
    monkeypatch.setattr(settings, "champvault_api_key", "cvb_test")

    seen = {}

    async def fake_list(self, **kwargs):
        seen.update(kwargs)
        return [Asset.from_json({"id": "a1", "title": "Deck", "type": "deck", "storage": "r2", "status": "published"})]

    monkeypatch.setattr(ChampVault, "list_assets", fake_list)

    resp = await client.get("/api/v1/champvault/assets?type=deck")
    assert resp.status_code == 200
    assert resp.json()[0]["title"] == "Deck"
    # BD-facing listing is forced to published.
    assert seen.get("status") == "published"
    assert seen.get("type") == "deck"
