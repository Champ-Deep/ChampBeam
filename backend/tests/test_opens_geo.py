"""Test the opens geo-map aggregation (Slice B): opens by country/city/day
across the caller's links and files."""

from __future__ import annotations

import uuid as _uuid
from datetime import datetime, timedelta
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.security import TokenData, require_auth
from app.models.file_asset import FileAsset
from app.models.user import User
from app.models.utm import ClickEvent, LinkClick

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def geo_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
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
        async with maker() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[require_auth] = lambda: _CURRENT["token"]
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, maker
    app.dependency_overrides.clear()
    await engine.dispose()


@pytest.mark.asyncio
async def test_opens_geo_aggregation(geo_ctx):
    client, maker = geo_ctx
    uid, link_id, file_id = _uuid.uuid4(), _uuid.uuid4(), _uuid.uuid4()
    now = datetime.utcnow()
    async with maker() as s:
        s.add(User(id=uid, clerk_id="u", email="u@e.com"))
        s.add(LinkClick(id=link_id, user_id=uid, short_code="l1", original_url="https://e.com"))
        s.add(FileAsset(id=file_id, user_id=uid, short_code="f1", filename="d.pdf", kind="pdf",
                        mime_type="application/pdf", size_bytes=1, storage_key="k",
                        status="active", serve_mode="stream"))
        await s.flush()

        def ev(target, ip, country, cc, city, when):
            kw = {"link_id": target} if target == link_id else {"file_id": target}
            return ClickEvent(id=_uuid.uuid4(), ip_address=ip, country=country, country_code=cc,
                              city=city, clicked_at=when, **kw)

        # US: 3 opens (2 unique IPs) across a link + file; UK: 1 open; 1 with no geo.
        s.add(ev(link_id, "1.1.1.1", "United States", "US", "San Francisco", now))
        s.add(ev(link_id, "1.1.1.1", "United States", "US", "San Francisco", now))
        s.add(ev(file_id, "2.2.2.2", "United States", "US", "New York", now))
        s.add(ev(link_id, "3.3.3.3", "United Kingdom", "GB", "London", now - timedelta(days=1)))
        s.add(ev(link_id, "4.4.4.4", None, None, None, now))
        await s.commit()

    _CURRENT["token"] = TokenData(user_id=str(uid), email="u@e.com", clerk_user_id="u")
    body = (await client.get("/api/v1/utm/analytics/geo?days=30")).json()

    assert body["total_opens"] == 5
    countries = {c["country"]: c for c in body["countries"]}
    assert countries["United States"]["opens"] == 3
    assert countries["United States"]["unique_opens"] == 2
    assert countries["United Kingdom"]["opens"] == 1
    assert body["countries"][0]["country"] == "United States"  # sorted by opens
    assert None not in countries  # geo-less opens excluded from the map

    cities = {c["city"] for c in body["cities"]}
    assert cities == {"San Francisco", "New York", "London"}

    # Two distinct days present in the trend.
    assert len(body["by_day"]) == 2
    assert sum(d["opens"] for d in body["by_day"]) == 5
