"""Per-page engagement (Slice C): the viewer ingests per-page dwell events;
the owner reads the heatmap rollup."""

from __future__ import annotations

import uuid as _uuid
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.security import TokenData, require_auth
from app.models.file_asset import FileAsset
from app.models.page_engagement import PageEngagement
from app.models.user import User

_CURRENT: dict[str, TokenData] = {}


@pytest_asyncio.fixture(scope="function")
async def pe_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
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


async def _seed_file(maker):
    uid, fid = _uuid.uuid4(), _uuid.uuid4()
    async with maker() as s:
        s.add(User(id=uid, clerk_id="u", email="u@e.com"))
        s.add(FileAsset(id=fid, user_id=uid, short_code="doc1", filename="deck.pdf", kind="pdf",
                        mime_type="application/pdf", size_bytes=1, storage_key="k",
                        status="active", serve_mode="stream"))
        await s.commit()
    return str(uid), str(fid)


@pytest.mark.asyncio
async def test_ingest_and_rollup(pe_ctx):
    client, maker = pe_ctx
    uid, fid = await _seed_file(maker)

    # Two view sessions report page dwell (viewer is public — no auth needed).
    r1 = await client.post("/f/doc1/page-events", json={
        "session_id": "s1", "events": [{"page": 1, "dwell_ms": 1000}, {"page": 2, "dwell_ms": 5000}],
    })
    r2 = await client.post("/f/doc1/page-events", json={
        "session_id": "s2", "events": [{"page": 1, "dwell_ms": 3000}, {"page": 2, "dwell_ms": 1000}],
    })
    assert r1.status_code == 204 and r2.status_code == 204

    # Unknown code -> 404.
    assert (await client.post("/f/nope/page-events", json={"session_id": "x", "events": []})).status_code == 404

    # Owner reads the heatmap rollup.
    _CURRENT["token"] = TokenData(user_id=uid, email="u@e.com", clerk_user_id="u")
    body = (await client.get(f"/api/v1/files/{fid}/pages")).json()
    pages = {p["page"]: p for p in body["pages"]}

    assert pages[1]["avg_ms"] == 2000 and pages[1]["sessions"] == 2   # (1000+3000)/2
    assert pages[2]["avg_ms"] == 3000 and pages[2]["total_ms"] == 6000
    assert body["peak_avg_ms"] == 3000  # page 2 holds the most attention
