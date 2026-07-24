"""Regression tests for click tracking: unique-click counting on the /r/ path
and UTC timestamp serialization.

Uses private IPs so the post-redirect GeoIP background task short-circuits
without any network call.
"""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timezone
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.user import User
from app.models.utm import LinkClick


@pytest_asyncio.fixture(scope="function")
async def client_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
    import importlib

    from app.db.postgres import Base, get_db_session
    from app.main import app
    from app.middleware.rate_limit import limiter

    # importlib (not `import ... as`) because app.services.__init__ rebinds the
    # `utm_service` attribute to the singleton, shadowing the submodule.
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

    # The redirect counters/events run in their own session via this maker.
    orig = utm_module.async_session_maker
    utm_module.async_session_maker = maker
    app.dependency_overrides[get_db_session] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, maker

    app.dependency_overrides.clear()
    utm_module.async_session_maker = orig
    await engine.dispose()


async def _seed_link(maker, short_code: str) -> str:
    uid = _uuid.uuid4()
    lid = _uuid.uuid4()
    async with maker() as s:
        s.add(User(id=uid, clerk_id="u_click", email="click@example.com"))
        s.add(LinkClick(
            id=lid, user_id=uid, short_code=short_code, domain_id=None,
            original_url="https://example.com/dest", tracked_url="https://example.com/dest",
            click_count=0, unique_clicks=0,
        ))
        await s.commit()
    return str(lid)


@pytest.mark.asyncio
async def test_unique_clicks_counts_distinct_ips(client_ctx):
    client, maker = client_ctx
    link_id = await _seed_link(maker, "uniqtest")

    # Same IP twice, then a different IP once -> 3 clicks, 2 unique.
    for ip in ["10.0.0.1", "10.0.0.1", "10.0.0.2"]:
        resp = await client.get("/r/uniqtest", headers={"X-Forwarded-For": ip})
        assert resp.status_code == 302
        assert resp.headers["location"] == "https://example.com/dest"

    async with maker() as s:
        link = (await s.execute(select(LinkClick).where(LinkClick.id == _uuid.UUID(link_id)))).scalar_one()
        assert link.click_count == 3
        assert link.unique_clicks == 2


@pytest.mark.asyncio
async def test_recent_clicks_timestamp_is_utc(monkeypatch):
    """clicked_at in API responses must carry a UTC designator so the browser
    renders it in the viewer's local time instead of treating it as local."""
    from app.core.timeutils import iso_utc

    naive = datetime(2026, 6, 23, 20, 0, 0)  # naive UTC, as stored in the DB
    out = iso_utc(naive)
    assert out is not None and (out.endswith("Z") or "+00:00" in out)
    # Round-trips back to the same instant.
    from datetime import datetime as dt
    parsed = dt.fromisoformat(out.replace("Z", "+00:00"))
    assert parsed.astimezone(timezone.utc).replace(tzinfo=None) == naive
    assert iso_utc(None) is None


def test_multi_platform_hosts_keep_old_links_alive():
    """A comma-separated PLATFORM_REDIRECT_HOST lets the old public host keep
    serving previously-issued links after the backend URL changes."""
    from app.core.config import settings

    old = settings.platform_redirect_host
    try:
        settings.platform_redirect_host = "champbeam.com, champbeam.up.railway.app"
        hosts = settings.platform_redirect_hosts
        assert "champbeam.com" in hosts and "champbeam.up.railway.app" in hosts
        # The primary (for building new URLs) is the first entry.
        assert settings.resolved_platform_redirect_host == "champbeam.com"
        # Both old and new hosts resolve as platform-default (links keep working).
        assert settings.is_platform_host("champbeam.com")
        assert settings.is_platform_host("champbeam.up.railway.app")
        assert settings.is_platform_host("")  # empty host => platform default
        # A real customer BYOD host is NOT platform-default.
        assert not settings.is_platform_host("track.acme.com")
    finally:
        settings.platform_redirect_host = old
