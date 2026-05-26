"""
Bootstrap alembic_version for databases originally created via
``Base.metadata.create_all()`` instead of Alembic migrations.

On the deployed Railway Postgres, ``init_db()`` historically ran
``create_all`` on every boot, so the tables exist but no row was ever
written to ``alembic_version``. When ``alembic upgrade head`` then
runs at deploy time, it sees the empty version table, assumes the DB
is fresh, and tries to apply 001_initial — which fails with
``relation "users" already exists``.

This script bridges that gap: if ``users`` exists but
``alembic_version`` is empty, it stamps the DB at the revision that
matches what ``create_all`` would have produced, so the subsequent
``alembic upgrade head`` only applies migrations newer than that
state (i.e. 006_add_clerk_id — the one and only column the deployed
schema is genuinely missing).

Idempotent: re-runs are no-ops once ``alembic_version`` is populated.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import settings


logging.basicConfig(level=logging.INFO, format="bootstrap_db: %(message)s")
log = logging.getLogger(__name__)


# Revision immediately preceding 006_add_clerk_id. The deployed schema
# matches what ``create_all`` produced before Clerk auth landed, so
# stamping here lets alembic apply exactly the missing bits.
STAMP_REVISION = "52f5b4d7d10e"


async def main() -> int:
    engine = create_async_engine(settings.postgres_url)
    try:
        async with engine.begin() as conn:
            users_exists = await conn.scalar(text(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.tables"
                "  WHERE table_schema = 'public' AND table_name = 'users'"
                ")"
            ))
            if not users_exists:
                log.info("fresh database (no users table) — letting alembic create the schema from scratch")
                return 0

            version_table_exists = await conn.scalar(text(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.tables"
                "  WHERE table_schema = 'public' AND table_name = 'alembic_version'"
                ")"
            ))
            if version_table_exists:
                existing_count = await conn.scalar(text("SELECT COUNT(*) FROM alembic_version"))
                if existing_count and existing_count > 0:
                    current = await conn.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
                    log.info("alembic_version already populated at %s — no stamp needed", current)
                    return 0

            await conn.execute(text(
                "CREATE TABLE IF NOT EXISTS alembic_version ("
                "  version_num VARCHAR(32) NOT NULL PRIMARY KEY"
                ")"
            ))
            await conn.execute(text("DELETE FROM alembic_version"))
            await conn.execute(
                text("INSERT INTO alembic_version (version_num) VALUES (:rev)"),
                {"rev": STAMP_REVISION},
            )
            log.info("stamped legacy schema at %s — alembic upgrade head will apply newer migrations only", STAMP_REVISION)
            return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
