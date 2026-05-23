"""
Security utilities — Clerk session-token verification.
"""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

_jwks_cache: dict[str, Any] | None = None
_jwks_fetched_at: float = 0
JWKS_CACHE_TTL = 3600


class TokenData(BaseModel):
    user_id: str
    email: str


def _fetch_clerk_jwks() -> dict[str, Any]:
    global _jwks_cache, _jwks_fetched_at
    now = time.time()
    if _jwks_cache and (now - _jwks_fetched_at) < JWKS_CACHE_TTL:
        return _jwks_cache

    resp = httpx.get(
        "https://api.clerk.com/v1/jwks",
        headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
        timeout=10,
    )
    resp.raise_for_status()
    _jwks_cache = resp.json()
    _jwks_fetched_at = now
    return _jwks_cache


def _verify_clerk_token(token: str) -> str:
    """Verify a Clerk session JWT. Returns the Clerk user ID (sub)."""
    try:
        jwks = _fetch_clerk_jwks()
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")

        key = next((k for k in jwks.get("keys", []) if k["kid"] == kid), None)
        if key is None:
            # Key not found — force refresh in case keys rotated
            global _jwks_cache
            _jwks_cache = None
            jwks = _fetch_clerk_jwks()
            key = next((k for k in jwks.get("keys", []) if k["kid"] == kid), None)
            if key is None:
                raise HTTPException(status_code=401, detail="Unknown signing key")

        payload = jwt.decode(token, key, algorithms=["RS256"], options={"verify_aud": False})
        clerk_user_id = payload.get("sub")
        if not clerk_user_id:
            raise HTTPException(status_code=401, detail="Invalid token: missing sub")
        return clerk_user_id

    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> TokenData | None:
    if credentials is None:
        return None

    from app.db.postgres import async_session_maker
    from app.services.user_service import user_service

    clerk_user_id = _verify_clerk_token(credentials.credentials)
    async with async_session_maker() as session:
        user = await user_service.get_or_create_by_clerk_id(session, clerk_user_id)
        await session.commit()
        return TokenData(user_id=str(user.id), email=user.email or "")


async def require_auth(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> TokenData:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
            headers={"WWW-Authenticate": "Bearer"},
        )

    from app.db.postgres import async_session_maker
    from app.services.user_service import user_service

    clerk_user_id = _verify_clerk_token(credentials.credentials)
    async with async_session_maker() as session:
        user = await user_service.get_or_create_by_clerk_id(session, clerk_user_id)
        await session.commit()
        return TokenData(user_id=str(user.id), email=user.email or "")
