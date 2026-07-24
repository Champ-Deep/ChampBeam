"""Tests for scripts/merge_clerk_user: reassigning a user's data to a new Clerk
identity (the dev->prod instance switch continuity fix)."""

from __future__ import annotations

import uuid as _uuid

import pytest
import pytest_asyncio
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import app.db.postgres as pg
from app.models.domain import Domain
from app.models.user import User
from app.models.utm import LinkClick
from scripts.merge_clerk_user import merge


@pytest_asyncio.fixture(scope="function")
async def maker():
    from app.db.postgres import Base

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(conn, _rec):
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    test_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    # merge() reads app.db.postgres.async_session_maker at call time.
    orig = pg.async_session_maker
    pg.async_session_maker = test_maker
    try:
        yield test_maker
    finally:
        pg.async_session_maker = orig
        await engine.dispose()


@pytest.mark.asyncio
async def test_merge_reassigns_ownership_and_retires_source(maker):
    dev_id, prod_id = _uuid.uuid4(), _uuid.uuid4()
    link_id, dom_id = _uuid.uuid4(), _uuid.uuid4()
    async with maker() as s:
        # Dev-instance user with real email + owned data.
        s.add(User(id=dev_id, clerk_id="user_DEV", email="deep@championsmail.com", full_name="Deep"))
        # Prod-instance user: fresh login, still on the placeholder email.
        s.add(User(id=prod_id, clerk_id="user_PROD", email="user_PROD@clerk.placeholder"))
        s.add(LinkClick(
            id=link_id, user_id=dev_id, short_code="abc123", domain_id=None,
            original_url="https://example.com", tracked_url="https://example.com",
            click_count=5, unique_clicks=3,
        ))
        s.add(Domain(id=dom_id, user_id=dev_id, hostname="track.deep.com", status="active"))
        await s.commit()

    # Re-link by email -> the production clerk id.
    await merge("deep@championsmail.com", "user_PROD", dry_run=False)

    async with maker() as s:
        link = (await s.execute(select(LinkClick).where(LinkClick.id == link_id))).scalar_one()
        dom = (await s.execute(select(Domain).where(Domain.id == dom_id))).scalar_one()
        prod = (await s.execute(select(User).where(User.id == prod_id))).scalar_one()
        dev = (await s.execute(select(User).where(User.id == dev_id))).scalar_one()

    # Ownership moved to the production user.
    assert str(link.user_id) == str(prod_id)
    assert str(dom.user_id) == str(prod_id)
    # Real identity promoted onto the kept (prod) row; source retired.
    assert prod.email == "deep@championsmail.com"
    assert prod.full_name == "Deep"
    assert dev.is_active is False
    assert dev.clerk_id is None


@pytest.mark.asyncio
async def test_merge_dry_run_writes_nothing(maker):
    dev_id, prod_id = _uuid.uuid4(), _uuid.uuid4()
    link_id = _uuid.uuid4()
    async with maker() as s:
        s.add(User(id=dev_id, clerk_id="user_DEV", email="x@example.com"))
        s.add(User(id=prod_id, clerk_id="user_PROD", email="user_PROD@clerk.placeholder"))
        s.add(LinkClick(
            id=link_id, user_id=dev_id, short_code="z", domain_id=None,
            original_url="https://e.com", tracked_url="https://e.com",
        ))
        await s.commit()

    await merge("user_DEV", "user_PROD", dry_run=True)

    async with maker() as s:
        link = (await s.execute(select(LinkClick).where(LinkClick.id == link_id))).scalar_one()
        dev = (await s.execute(select(User).where(User.id == dev_id))).scalar_one()
    assert str(link.user_id) == str(dev_id)  # unchanged
    assert dev.is_active is True
