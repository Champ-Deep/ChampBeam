"""
Security utilities — Clerk session-token verification.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

_jwks_cache: dict[str, Any] | None = None
_jwks_fetched_at: float = 0
_jwks_lock = asyncio.Lock()
JWKS_CACHE_TTL = 3600


class TokenData(BaseModel):
    user_id: str
    email: str


async def _fetch_clerk_jwks(force_refresh: bool = False) -> dict[str, Any]:
    """Fetch (and cache) Clerk's JWKS. Non-blocking; safe under concurrency."""
    global _jwks_cache, _jwks_fetched_at

    now = time.time()
    if not force_refresh and _jwks_cache and (now - _jwks_fetched_at) < JWKS_CACHE_TTL:
        return _jwks_cache

    async with _jwks_lock:
        # Re-check after acquiring the lock — another coroutine may have refreshed.
        now = time.time()
        if not force_refresh and _jwks_cache and (now - _jwks_fetched_at) < JWKS_CACHE_TTL:
            return _jwks_cache

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                "https://api.clerk.com/v1/jwks",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
            resp.raise_for_status()
            _jwks_cache = resp.json()
            _jwks_fetched_at = time.time()
            return _jwks_cache


async def _verify_clerk_token(token: str) -> str:
    """Verify a Clerk session JWT. Returns the Clerk user ID (sub)."""
    try:
        jwks = await _fetch_clerk_jwks()
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")

        key = next((k for k in jwks.get("keys", []) if k["kid"] == kid), None)
        if key is None:
            # Key not found — refresh in case keys rotated.
            jwks = await _fetch_clerk_jwks(force_refresh=True)
            key = next((k for k in jwks.get("keys", []) if k["kid"] == kid), None)
            if key is None:
                raise HTTPException(status_code=401, detail="Unknown signing key")

        payload = jwt.decode(token, key, algorithms=["RS256"], options={"verify_aud": False})
        clerk_user_id = payload.get("sub")
        if not clerk_user_id:
            raise HTTPException(status_code=401, detail="Invalid token: missing sub")
        return clerk_user_id

    except HTTPException:
        raise
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def _resolve_user(clerk_user_id: str) -> TokenData:
    """Look up (or create) the local user row for a verified Clerk ID."""
    from app.db.postgres import async_session_maker
    from app.services.user_service import user_service

    async with async_session_maker() as session:
        user = await user_service.get_or_create_by_clerk_id(session, clerk_user_id)
        await session.commit()
        return TokenData(user_id=str(user.id), email=user.email or "")


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> TokenData | None:
    if credentials is None:
        return None
    try:
        clerk_user_id = await _verify_clerk_token(credentials.credentials)
        return await _resolve_user(clerk_user_id)
    except HTTPException:
        raise
    except (httpx.HTTPError, SQLAlchemyError) as exc:
        logger.exception("auth: upstream/DB failure resolving optional user")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth service temporarily unavailable",
        ) from exc
    except Exception as exc:  # noqa: BLE001 — last-resort guard so 500s carry CORS headers
        logger.exception("auth: unexpected error in get_current_user")
        raise HTTPException(status_code=500, detail="Internal authentication error") from exc


async def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> TokenData:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )
    try:
        clerk_user_id = await _verify_clerk_token(credentials.credentials)
        return await _resolve_user(clerk_user_id)
    except HTTPException:
        raise
    except (httpx.HTTPError, SQLAlchemyError) as exc:
        logger.exception("auth: upstream/DB failure resolving required user")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth service temporarily unavailable",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("auth: unexpected error in require_auth")
        raise HTTPException(status_code=500, detail="Internal authentication error") from exc
