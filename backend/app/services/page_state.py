"""Beam State service: page resolution, public token, write limits, events.

Shared by the public /api/pages/{ident}/… router and the owner-facing
/api/v1/pages/{id}/… endpoints so every rule has exactly one implementation.
"""

from __future__ import annotations

import hmac
import json
import re
import secrets
import time
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import HTTPException, Request
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.file_asset import FileAsset, KIND_HTML
from app.models.page_state import PageComment, PageEvent, PageState

# Hard caps enforced in SQL/validation (Redis windows fail open, these don't).
MAX_COMMENTS_PER_PAGE = 5000
MAX_KEYS_PER_PAGE = 200
MAX_COMMENT_BODY = 4000
MAX_AUTHOR = 120
MAX_VALUE_BYTES = 16 * 1024
WRITES_PER_MINUTE = 30

KEY_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")
TOKEN_HEADER = "X-Beam-Token"


# ---------------------------------------------------------------------------
# Page resolution + lifecycle
# ---------------------------------------------------------------------------


async def resolve_public_page(request: Request, ident: str, session: AsyncSession) -> Optional[FileAsset]:
    """Host-aware lookup by slug (preferred) or short code; html pages only.
    Returns None for unknown pages AND for unregistered custom hosts."""
    from app.api.files import _lookup_asset, _request_host, _resolve_domain
    from app.core.config import settings

    host = _request_host(request)
    domain = await _resolve_domain(host, session)
    if host and domain is None and not settings.is_platform_host(host):
        return None
    raw = (ident or "").strip()
    # Slugs are lowercase by construction; short codes are case-sensitive.
    asset = await _lookup_asset(session, domain, slug=raw.lower())
    if asset is None:
        asset = await _lookup_asset(session, domain, short_code=raw)
    if asset is None or asset.kind != KIND_HTML:
        return None
    return asset


def page_killed(asset: FileAsset) -> bool:
    """True when the page itself would be blocked (kill switch semantics)."""
    if asset.revoked_at is not None:
        return True
    if asset.expires_at is not None and asset.expires_at < datetime.utcnow():
        return True
    if asset.max_views is not None and (asset.view_count or 0) >= asset.max_views:
        return True
    return False


def ensure_state_token(asset: FileAsset) -> str:
    """Lazily mint the page's public state token (caller commits)."""
    if not asset.state_token:
        asset.state_token = secrets.token_urlsafe(24)
    return asset.state_token


def rotate_state_token(asset: FileAsset) -> str:
    asset.state_token = secrets.token_urlsafe(24)
    return asset.state_token


def check_token(asset: FileAsset, request: Request) -> None:
    """401 unless the request carries this page's token (header or Bearer)."""
    presented = (request.headers.get(TOKEN_HEADER) or "").strip()
    if not presented:
        auth = request.headers.get("Authorization") or ""
        if auth.lower().startswith("bearer "):
            presented = auth[7:].strip()
    expected = asset.state_token or ""
    if not presented or not expected or not hmac.compare_digest(presented, expected):
        raise HTTPException(status_code=401, detail="Invalid page token")


# ---------------------------------------------------------------------------
# Limits + validation
# ---------------------------------------------------------------------------


async def enforce_write_limit(ip: Optional[str], page_id: UUID) -> None:
    """Fixed window per IP+page; fails open when Redis is unavailable."""
    from app.db.redis import redis_client

    window = int(time.time() // 60)
    count = await redis_client.incr_with_ttl(f"pgst_rl:{page_id}:{ip or '-'}:{window}", ttl=60)
    if count is not None and count > WRITES_PER_MINUTE:
        raise HTTPException(
            status_code=429, detail=f"Too many writes ({WRITES_PER_MINUTE}/minute per page)."
        )


def validate_key(key: str) -> str:
    if not KEY_RE.match(key or ""):
        raise HTTPException(
            status_code=400,
            detail="Key must be 1–120 characters of letters, digits, '_', '.', ':' or '-'.",
        )
    return key


def validate_value(value: Any) -> str:
    try:
        encoded = json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Value must be JSON-serializable.")
    if len(encoded.encode("utf-8")) > MAX_VALUE_BYTES:
        raise HTTPException(status_code=413, detail=f"Value exceeds {MAX_VALUE_BYTES // 1024} KB.")
    return encoded


def validate_comment(author: str, body: str) -> tuple[str, str]:
    author = (author or "").strip()
    body = (body or "").strip()
    if not author or len(author) > MAX_AUTHOR:
        raise HTTPException(status_code=400, detail=f"Author is required (max {MAX_AUTHOR} chars).")
    if not body:
        raise HTTPException(status_code=400, detail="Comment body is required.")
    if len(body) > MAX_COMMENT_BODY:
        raise HTTPException(status_code=413, detail=f"Comment exceeds {MAX_COMMENT_BODY} characters.")
    return author, body


async def comment_count(session: AsyncSession, page_id: UUID) -> int:
    return int((await session.execute(
        select(func.count(PageComment.id)).where(PageComment.page_id == page_id)
    )).scalar_one() or 0)


async def key_count(session: AsyncSession, page_id: UUID) -> int:
    return int((await session.execute(
        select(func.count(PageState.id)).where(PageState.page_id == page_id)
    )).scalar_one() or 0)


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


def record_page_event(
    session: AsyncSession,
    page_id: UUID,
    event_type: str,
    *,
    ref: Optional[str] = None,
    visitor_id: Optional[str] = None,
    ip: Optional[str] = None,
) -> PageEvent:
    """Single seam for typed page events (caller flushes/commits)."""
    event = PageEvent(
        page_id=page_id,
        event_type=event_type,
        ref=(ref or None) and str(ref)[:160],
        visitor_id=(visitor_id or None) and str(visitor_id)[:64],
        ip=(ip or None) and str(ip)[:45],
    )
    session.add(event)
    return event
