"""
Redis client for caching.
Provides async Redis connection with connection pooling.
"""

from __future__ import annotations

import json
import logging
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

from app.core.config import settings


class RedisClient:
    """Async Redis client wrapper with connection pooling.

    Gracefully degrades when Redis is unavailable, all operations
    return None / no-op instead of raising exceptions.
    """

    def __init__(self):
        self._client: Optional[aioredis.Redis] = None
        self._available = True

    async def _get_client(self) -> Optional[aioredis.Redis]:
        """Get or create Redis client with connection pool."""
        if not self._available:
            return None
        if self._client is None:
            try:
                self._client = aioredis.from_url(
                    settings.redis_url,
                    encoding="utf-8",
                    decode_responses=True,
                    socket_connect_timeout=5,
                    socket_timeout=5,
                    retry_on_timeout=True,
                )
            except Exception as e:
                logger.warning("Redis unavailable: %s", e)
                self._available = False
                return None
        return self._client

    async def get(self, key: str) -> Optional[str]:
        """Get value by key."""
        try:
            client = await self._get_client()
            if client is None:
                return None
            return await client.get(key)
        except Exception:
            return None

    async def set(self, key: str, value: str, ex: Optional[int] = None):
        """Set key-value pair with optional TTL."""
        try:
            client = await self._get_client()
            if client is None:
                return
            await client.set(key, value, ex=ex)
        except Exception:
            pass

    async def delete(self, key: str):
        """Delete a key."""
        try:
            client = await self._get_client()
            if client is None:
                return
            await client.delete(key)
        except Exception:
            pass

    async def get_json(self, key: str) -> Optional[dict]:
        """Get and deserialize JSON value."""
        raw = await self.get(key)
        if raw:
            return json.loads(raw)
        return None

    async def set_json(self, key: str, value: dict, ex: Optional[int] = None):
        """Serialize and set JSON value."""
        await self.set(key, json.dumps(value), ex=ex)

    async def close(self):
        """Close the Redis connection."""
        if self._client:
            await self._client.close()
            self._client = None

    async def ping(self) -> bool:
        """Check Redis connectivity."""
        try:
            client = await self._get_client()
            if client is None:
                return False
            return await client.ping()
        except Exception:
            return False


# Singleton instance
redis_client = RedisClient()
