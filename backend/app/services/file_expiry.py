"""Expiry for anonymous (auto-expiring) file assets.

Two layers: lazy expiry at serve time (``expire_asset``, called from
``api/files.py`` when an expired file is requested) and a periodic
``expiry_sweeper_loop`` started in the app lifespan that reclaims expired
blobs + rows even if nobody visits them again.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from uuid import UUID

from sqlalchemy import select

from app.core.config import settings
from app.db.postgres import async_session_maker
from app.models.file_asset import FileAsset, STATUS_DELETED
from app.services import storage

logger = logging.getLogger(__name__)


async def _delete_blob(storage_key: str) -> None:
    try:
        await storage.delete_object(storage_key)
    except storage.StorageError:
        logger.exception("file expiry: blob delete failed for key=%s", storage_key)
    except storage.StorageNotConfigured:
        pass


async def expire_asset(file_id: UUID) -> None:
    """Soft-delete one asset and best-effort remove its blob."""
    async with async_session_maker() as session:
        result = await session.execute(select(FileAsset).where(FileAsset.id == file_id))
        asset = result.scalar_one_or_none()
        if asset is None or asset.status == STATUS_DELETED:
            return
        storage_key = asset.storage_key
        asset.status = STATUS_DELETED
        await session.commit()
    await _delete_blob(storage_key)


async def sweep_expired(limit: int = 200) -> int:
    """Delete a batch of expired files. Returns the number swept."""
    now = datetime.utcnow()
    async with async_session_maker() as session:
        result = await session.execute(
            select(FileAsset)
            .where(
                FileAsset.expires_at.is_not(None),
                FileAsset.expires_at < now,
                FileAsset.status != STATUS_DELETED,
            )
            .limit(limit)
        )
        assets = result.scalars().all()
        keys = [a.storage_key for a in assets]
        for asset in assets:
            asset.status = STATUS_DELETED
        if assets:
            await session.commit()
    for key in keys:
        await _delete_blob(key)
    return len(keys)


async def expiry_sweeper_loop() -> None:
    """Background task: periodically reclaim expired guest files."""
    interval = max(60, settings.anon_sweep_interval_seconds)
    logger.info("file expiry sweeper started (interval=%ss)", interval)
    while True:
        try:
            await asyncio.sleep(interval)
            swept = await sweep_expired()
            if swept:
                logger.info("file expiry sweeper reclaimed %d file(s)", swept)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("file expiry sweeper iteration failed")
