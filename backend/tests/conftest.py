"""
Shared pytest fixtures for the Champbeam test suite.

Swaps in an in-process SQLite database so integration tests can exercise the
full register/login/UTM/redirect/analytics flow without a running PostgreSQL.
SQLAlchemy 2.0's `Uuid`/`JSON` base classes emulate on SQLite automatically,
so we only need to redirect the session maker and dependency.
"""

from __future__ import annotations

import os
import uuid as _uuid
from typing import AsyncGenerator

# httpx ASGITransport defaults the Host header to "test" via base_url. The
# BYOD redirect handler refuses unknown hosts to enforce tenant isolation,
# so we mark "test" as the platform-default host before any app.* module
# imports and caches its Settings instance.
os.environ.setdefault("PLATFORM_REDIRECT_HOST", "test")

import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import event
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


def _coerce_uuid_bind_processor(self, dialect):
    """SQLite has no native UUID type. Always serialize to hex so the
    binding succeeds regardless of whether the caller handed us a UUID
    instance (e.g. ``uuid4()``) or a plain string (e.g. JWT user_id)."""
    if dialect.name != "sqlite":
        return _ORIG_PG_UUID_BIND_PROCESSOR(self, dialect)

    def process(value):
        if value is None:
            return None
        if isinstance(value, _uuid.UUID):
            return value.hex
        return _uuid.UUID(str(value)).hex

    return process


_ORIG_PG_UUID_BIND_PROCESSOR = PG_UUID.bind_processor
PG_UUID.bind_processor = _coerce_uuid_bind_processor


@pytest_asyncio.fixture(scope="function")
async def app_client() -> AsyncGenerator[AsyncClient, None]:
    """FastAPI test client backed by an in-process SQLite database."""

    from app.db.postgres import Base, get_db_session
    from app.main import app
    from app.middleware.rate_limit import limiter

    # Each test starts with an empty rate-limit window so the order/count
    # of requests in one test never trips the limiter in another.
    limiter.reset()

    sqlite_engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        future=True,
    )

    sync_engine = sqlite_engine.sync_engine

    @event.listens_for(sync_engine, "connect")
    def _enable_fk(dbapi_connection, _conn_record):
        cur = dbapi_connection.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    test_sessionmaker = async_sessionmaker(
        sqlite_engine, class_=AsyncSession, expire_on_commit=False
    )

    async with sqlite_engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def override_get_db():
        async with test_sessionmaker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    import importlib

    utm_service_module = importlib.import_module("app.services.utm_service")
    original_sessionmaker = utm_service_module.async_session_maker
    utm_service_module.async_session_maker = test_sessionmaker

    # API-key auth (app.core.security._resolve_api_key) opens its own session
    # via a lazy `from app.db.postgres import async_session_maker`, which reads
    # the module attribute at call time — point it at the test database too.
    postgres_module = importlib.import_module("app.db.postgres")
    original_pg_sessionmaker = postgres_module.async_session_maker
    postgres_module.async_session_maker = test_sessionmaker

    app.dependency_overrides[get_db_session] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client

    app.dependency_overrides.clear()
    utm_service_module.async_session_maker = original_sessionmaker
    postgres_module.async_session_maker = original_pg_sessionmaker
    await sqlite_engine.dispose()
