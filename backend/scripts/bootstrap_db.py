"""
Bootstrap alembic_version + idempotent schema safety net for the
Railway Postgres database.

Two responsibilities, both safe to re-run on every boot:

1.  **Stamp alembic_version** when the DB was originally bootstrapped
    via ``Base.metadata.create_all()`` (so ``alembic upgrade head`` will
    apply only the deltas, not re-create existing tables).

2.  **Backfill any missing columns** the live model expects. Migration
    007_repair_legacy_schema does this via alembic; we additionally do
    it here so a stuck/borked ``alembic_version`` cannot leave the
    schema permanently incomplete. Every statement is ``IF NOT EXISTS``
    or otherwise idempotent, running this against an already-current
    schema is a no-op.

The safety net is what unblocks click_events inserts on production: if
``is_vpn`` / ``asn_org`` / ``latitude`` etc. are missing from the table,
every ORM INSERT (which lists all model columns) fails with
``UndefinedColumnError`` and analytics never accumulate device, browser,
or geo data even though the redirect itself succeeds.
"""

from __future__ import annotations

import asyncio
import logging
import sys

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

from app.core.config import settings


logging.basicConfig(level=logging.INFO, format="bootstrap_db: %(message)s")
log = logging.getLogger(__name__)


STAMP_REVISION = "52f5b4d7d10e"


# All statements are idempotent. Order matters only for FK-dependent
# additions, so we put column adds before index adds.
SCHEMA_SAFETY_NET = [
    # --- click_events: every model column the ORM emits in an INSERT ---
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS link_id UUID",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS ip_address VARCHAR(45)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS user_agent TEXT",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS referrer TEXT",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS device_type VARCHAR(50)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS browser VARCHAR(100)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS os VARCHAR(100)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS country VARCHAR(100)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS country_code VARCHAR(2)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS region VARCHAR(100)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS city VARCHAR(100)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS is_vpn BOOLEAN NOT NULL DEFAULT false",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS asn_org VARCHAR(255)",
    "ALTER TABLE click_events ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMP NOT NULL DEFAULT now()",
    # --- link_clicks: counter / tracking columns the redirect updates ---
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS short_code VARCHAR(20)",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS project_id UUID",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS project_name VARCHAR(255)",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS tracked_url TEXT",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS anchor_text VARCHAR(500)",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS link_position INTEGER",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS click_count INTEGER DEFAULT 0",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS unique_clicks INTEGER DEFAULT 0",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS first_clicked_at TIMESTAMP",
    "ALTER TABLE link_clicks ADD COLUMN IF NOT EXISTS last_clicked_at TIMESTAMP",
]


async def _apply_schema_safety_net(conn: AsyncConnection) -> None:
    """Run every idempotent schema statement, logging any unexpected failures.

    Missing tables are tolerated, alembic will create them on the next
    step. ``ALTER TABLE`` on a non-existent table raises
    ``UndefinedTableError``; we swallow that specific case and continue
    so the safety net doesn't block a fresh-install path.
    """
    for stmt in SCHEMA_SAFETY_NET:
        try:
            await conn.execute(text(stmt))
        except Exception as exc:
            msg = str(exc).lower()
            if "does not exist" in msg and "table" in msg:
                # Table not created yet, alembic will handle it.
                continue
            log.warning("safety-net statement failed (continuing): %s :: %s", stmt, exc)


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
                log.info("fresh database (no users table), letting alembic create the schema from scratch")
                return 0

            version_table_exists = await conn.scalar(text(
                "SELECT EXISTS ("
                "  SELECT 1 FROM information_schema.tables"
                "  WHERE table_schema = 'public' AND table_name = 'alembic_version'"
                ")"
            ))
            already_stamped = False
            if version_table_exists:
                existing_count = await conn.scalar(text("SELECT COUNT(*) FROM alembic_version"))
                if existing_count and existing_count > 0:
                    current = await conn.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
                    log.info("alembic_version already populated at %s, no stamp needed", current)
                    already_stamped = True

            if not already_stamped:
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
                log.info("stamped legacy schema at %s, alembic upgrade head will apply newer migrations only", STAMP_REVISION)

            # Always run the safety net. It's idempotent, fast, and the
            # only reliable way to recover from a schema that drifted from
            # alembic_version (e.g. a half-applied 007_repair_legacy).
            log.info("applying schema safety net (idempotent ADD COLUMN IF NOT EXISTS)")
            await _apply_schema_safety_net(conn)
            log.info("schema safety net complete")
        return 0
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
