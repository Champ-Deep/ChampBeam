"""
Security utilities: Clerk session-token verification + org-role guards.

Production hardening over a bare signature check:
- verifies the issuer (`iss`) when one is configured/derivable,
- enforces authorized parties (`azp`) against the configured SPA origins,
- relies on jose for `exp`/`nbf`,
- extracts Clerk Organization claims (v1 and v2 "o" shapes) so endpoints can
  scope by org and gate on admin/member roles, and
- backfills the user's real email/name from Clerk so the local mirror moves off
  the first-auth placeholder.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, Optional

import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger(__name__)

security = HTTPBearer(auto_error=False)

_jwks_cache: dict[str, Any] | None = None
_jwks_fetched_at: float = 0
_jwks_lock = asyncio.Lock()
JWKS_CACHE_TTL = 3600

# Throttle Clerk profile backfills: clerk_user_id -> last_attempt (monotonic).
_identity_attempts: dict[str, float] = {}
_IDENTITY_RETRY_SECONDS = 600.0


class TokenData(BaseModel):
    user_id: str
    email: str
    clerk_user_id: Optional[str] = None
    # Active-organization claims, present only when the session has an org set.
    org_id: Optional[str] = None  # Clerk org id (org_...)
    org_role: Optional[str] = None  # normalized: "admin" | "member" | custom
    org_slug: Optional[str] = None

    @property
    def is_org_admin(self) -> bool:
        return bool(self.org_role) and self.org_role.lower().endswith("admin")


async def _fetch_clerk_jwks(force_refresh: bool = False) -> dict[str, Any]:
    """Fetch (and cache) Clerk's JWKS. Non-blocking; safe under concurrency."""
    global _jwks_cache, _jwks_fetched_at

    now = time.time()
    if not force_refresh and _jwks_cache and (now - _jwks_fetched_at) < JWKS_CACHE_TTL:
        return _jwks_cache

    async with _jwks_lock:
        now = time.time()
        if not force_refresh and _jwks_cache and (now - _jwks_fetched_at) < JWKS_CACHE_TTL:
            return _jwks_cache

        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"{settings.clerk_api_url.rstrip('/')}/v1/jwks",
                headers={"Authorization": f"Bearer {settings.clerk_secret_key}"},
            )
            resp.raise_for_status()
            _jwks_cache = resp.json()
            _jwks_fetched_at = time.time()
            return _jwks_cache


def _normalize_role(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    r = raw.strip()
    if r.startswith("org:"):
        r = r[4:]
    return r.lower() or None


def _extract_org_claims(payload: dict[str, Any]) -> tuple[Optional[str], Optional[str], Optional[str]]:
    """Return (org_id, normalized_role, org_slug) from v2 ("o") or v1 claims."""
    o = payload.get("o")
    if isinstance(o, dict):
        return o.get("id"), _normalize_role(o.get("rol")), o.get("slg")
    return (
        payload.get("org_id"),
        _normalize_role(payload.get("org_role")),
        payload.get("org_slug"),
    )


async def _verify_clerk_token(token: str) -> dict[str, Any]:
    """Verify a Clerk session JWT and return its verified claims."""
    try:
        jwks = await _fetch_clerk_jwks()
        header = jwt.get_unverified_header(token)
        kid = header.get("kid")

        key = next((k for k in jwks.get("keys", []) if k["kid"] == kid), None)
        if key is None:
            jwks = await _fetch_clerk_jwks(force_refresh=True)
            key = next((k for k in jwks.get("keys", []) if k["kid"] == kid), None)
            if key is None:
                raise HTTPException(status_code=401, detail="Unknown signing key")

        decode_kwargs: dict[str, Any] = {
            "algorithms": ["RS256"],
            "options": {"verify_aud": False},
        }
        issuer = settings.resolved_clerk_issuer
        if issuer:
            decode_kwargs["issuer"] = issuer  # jose verifies `iss` and raises on mismatch

        payload = jwt.decode(token, key, **decode_kwargs)

        # Authorized-party check: the token's azp must be an origin we serve the
        # SPA from. Skipped when no parties are configured or no azp is present.
        parties = settings.clerk_authorized_parties_list
        azp = payload.get("azp")
        if parties and azp and azp.rstrip("/") not in parties:
            raise HTTPException(status_code=401, detail="Unauthorized party")

        if not payload.get("sub"):
            raise HTTPException(status_code=401, detail="Invalid token: missing sub")
        return payload

    except HTTPException:
        raise
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


async def _maybe_backfill_identity(session: AsyncSession, user, token_email: Optional[str]) -> None:
    """Populate a placeholder user's real email/name from the token or Clerk API."""
    from app.services.user_service import user_service

    if not user_service.has_placeholder_email(user):
        return
    # Prefer an email claim (custom JWT template) to avoid a network call.
    if token_email:
        await user_service.apply_identity(session, user, email=token_email)
        return
    # Throttle Clerk API lookups so a user with no resolvable email isn't fetched
    # on every request.
    clerk_id = user.clerk_id
    now = time.monotonic()
    last = _identity_attempts.get(clerk_id)
    if last is not None and (now - last) < _IDENTITY_RETRY_SECONDS:
        return
    _identity_attempts[clerk_id] = now

    from app.services import clerk_client

    payload = await clerk_client.fetch_user(clerk_id)
    if payload:
        await user_service.apply_identity(
            session,
            user,
            email=clerk_client.primary_email(payload),
            full_name=clerk_client.full_name(payload),
        )


async def _resolve_user(payload: dict[str, Any]) -> TokenData:
    """Look up (or create) the local user row and mirror org state from claims."""
    from app.db.postgres import async_session_maker
    from app.services import org_service
    from app.services.user_service import user_service

    clerk_user_id = payload["sub"]
    org_id, org_role, org_slug = _extract_org_claims(payload)
    token_email = payload.get("email")

    async with async_session_maker() as session:
        user = await user_service.get_or_create_by_clerk_id(session, clerk_user_id)
        await _maybe_backfill_identity(session, user, token_email)
        if org_id:
            await org_service.sync_from_token(
                session, user, org_id, org_role or "member", org_slug
            )
        await session.commit()
        return TokenData(
            user_id=str(user.id),
            email=user.email or "",
            clerk_user_id=clerk_user_id,
            org_id=org_id,
            org_role=org_role,
            org_slug=org_slug,
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
) -> TokenData | None:
    if credentials is None:
        return None
    try:
        payload = await _verify_clerk_token(credentials.credentials)
        return await _resolve_user(payload)
    except HTTPException:
        raise
    except (httpx.HTTPError, SQLAlchemyError) as exc:
        logger.exception("auth: upstream/DB failure resolving optional user")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Auth service temporarily unavailable",
        ) from exc
    except Exception as exc:  # noqa: BLE001, last-resort guard so 500s carry CORS headers
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
        payload = await _verify_clerk_token(credentials.credentials)
        return await _resolve_user(payload)
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


async def require_org_member(user: TokenData = Depends(require_auth)) -> TokenData:
    """Require an authenticated user with an active organization selected."""
    if not user.org_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Select an organization to use team features.",
        )
    return user


async def require_org_admin(user: TokenData = Depends(require_org_member)) -> TokenData:
    """Require an active org AND the admin role within it."""
    if not user.is_org_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="This action requires an organization admin.",
        )
    return user
