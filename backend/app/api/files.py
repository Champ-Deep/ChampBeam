"""Public serve endpoint for hosted file assets.

Routes ``GET /f/{code}`` and ``GET /f/{code}/{slug}`` (the slug is purely
cosmetic, the short_code is what we look up). Mirrors the BYOD redirect
handler at ``app/api/redirect.py``: the Host header decides which
short-code namespace to look in.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Form, Request
from fastapi.responses import RedirectResponse, Response, StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import access_control as ac
from app.api.access_pages import blocked_page, email_gate_page
from app.core.config import settings
from app.db.postgres import get_db_session
from app.models.domain import Domain, STATUS_ACTIVE as DOMAIN_STATUS_ACTIVE
from app.models.file_asset import (
    FileAsset,
    KIND_HTML,
    KIND_OTHER,
    SERVE_REDIRECT,
    STATUS_ACTIVE,
)
from app.services import storage
from app.services.file_expiry import expire_asset
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["File Serve"])


# Tight CSP for HTML files. Prevents the served page from loading external
# script/font/image resources or framing other origins. Inline scripts are
# left allowed (a hosted landing page often needs basic interactivity); a
# future hardening pass can drop 'unsafe-inline' and require a per-asset
# manifest.
_HTML_CSP = (
    "default-src 'self' data:; "
    "img-src 'self' data: blob:; "
    "style-src 'self' 'unsafe-inline'; "
    "script-src 'self' 'unsafe-inline'; "
    "font-src 'self' data:; "
    "connect-src 'self'; "
    "frame-ancestors 'none'; "
    "form-action 'self'; "
    "base-uri 'self'"
)


def _request_host(request: Request) -> str:
    host = (request.headers.get("host") or "").lower()
    return host.split(":", 1)[0]


async def _resolve_domain(host: str, session: AsyncSession) -> Optional[Domain]:
    if not host or settings.is_platform_host(host):
        return None
    result = await session.execute(
        select(Domain).where(
            Domain.hostname == host, Domain.status == DOMAIN_STATUS_ACTIVE
        )
    )
    return result.scalar_one_or_none()


def _safe_filename(name: str) -> str:
    return name.replace('"', "").replace("\n", " ")[:255]


def _common_headers(asset: FileAsset) -> dict[str, str]:
    # Arbitrary or unknown files (KIND_OTHER: zip, docs, archives) download
    # rather than render inline, which is also the safe default for untrusted
    # bytes served from our own origin.
    disposition = "attachment" if asset.kind == KIND_OTHER else "inline"
    headers = {
        "Content-Type": asset.mime_type,
        "Content-Disposition": f'{disposition}; filename="{_safe_filename(asset.filename)}"',
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
    }
    if asset.kind == KIND_HTML:
        headers["Content-Security-Policy"] = _HTML_CSP
    return headers


@router.get("/f/{short_code}")
@router.get("/f/{short_code}/{slug}")
async def serve_file(
    short_code: str,
    request: Request,
    background_tasks: BackgroundTasks,
    slug: Optional[str] = None,  # noqa: ARG001, slug is cosmetic
    session: AsyncSession = Depends(get_db_session),
):
    host = _request_host(request)
    domain = await _resolve_domain(host, session)

    if host and domain is None and not settings.is_platform_host(host):
        # Custom hostname that isn't registered or isn't active, refuse rather
        # than fall through to the platform-default bucket.
        return Response(status_code=404, content="File not found.")

    stmt = select(FileAsset).where(
        FileAsset.short_code == short_code,
        FileAsset.status == STATUS_ACTIVE,
    )
    if domain is None:
        stmt = stmt.where(FileAsset.domain_id.is_(None))
    else:
        stmt = stmt.where(FileAsset.domain_id == domain.id)

    result = await session.execute(stmt)
    asset = result.scalar_one_or_none()
    if asset is None:
        return Response(status_code=404, content="File not found.")

    brand = domain.hostname if (asset.branded and domain) else None
    ip_early = ac.client_ip(request)

    # --- Access gates (before serving / counting a view) -----------------
    # Email gate: capture a lead before access.
    if asset.require_email and not ac.has_gate_cookie(request, short_code):
        return email_gate_page(action=f"/f/{short_code}/unlock", brand=brand)
    # VPN/proxy block.
    if asset.block_vpn and await ac.is_vpn_ip(ip_early):
        return blocked_page("vpn", brand=brand)
    # Manual kill.
    if asset.revoked_at is not None:
        return blocked_page("revoked", brand=brand)
    # Time expiry (anonymous auto-expiry + authed self-destruct). Reclaim in bg.
    if asset.expires_at is not None and asset.expires_at < datetime.utcnow():
        background_tasks.add_task(expire_asset, asset.id)
        return blocked_page("expired", brand=brand)
    # View cap (burn-after-N). view_count reflects prior views.
    if asset.max_views is not None and (asset.view_count or 0) >= asset.max_views:
        return blocked_page("maxed", brand=brand)

    # Extract visitor info, same pattern as /r/{code}.
    ip_address = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not ip_address:
        ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("User-Agent")
    referrer = request.headers.get("Referer")

    event = await utm_service.record_file_view_event(
        file=asset,
        ip_address=ip_address,
        user_agent_str=user_agent,
        referrer=referrer,
        session=session,
        domain_id=domain.id if domain else None,
    )

    if ip_address:
        background_tasks.add_task(
            utm_service.resolve_geo_for_event, event.id, ip_address,
        )

    # Redirect-serve (large videos) only applies to S3; the local backend has
    # no presigned GET, so it always streams from disk.
    if asset.serve_mode == SERVE_REDIRECT and storage.backend_is_s3():
        try:
            url = storage.generate_presigned_get(
                asset.storage_key, filename=asset.filename, expires=300
            )
        except storage.StorageNotConfigured:
            return Response(status_code=503, content="Storage not configured.")
        except storage.StorageError as exc:
            logger.exception("presigned_get failed for key=%s: %s", asset.storage_key, exc)
            return Response(status_code=502, content="Storage error.")
        return RedirectResponse(url=url, status_code=302)

    # Stream mode, bytes proxied through Railway.
    try:
        return StreamingResponse(
            storage.stream_object(asset.storage_key),
            status_code=200,
            headers=_common_headers(asset),
            media_type=asset.mime_type,
        )
    except storage.StorageNotConfigured:
        return Response(status_code=503, content="Storage not configured.")


@router.post("/f/{short_code}/unlock")
async def unlock_file(
    short_code: str,
    request: Request,
    email: str = Form(default=""),
    session: AsyncSession = Depends(get_db_session),
):
    """Email-gate submit for a hosted file: capture the lead, set cookie, re-enter /f."""
    host = _request_host(request)
    domain = await _resolve_domain(host, session)
    stmt = select(FileAsset).where(
        FileAsset.short_code == short_code,
        FileAsset.status == STATUS_ACTIVE,
    )
    stmt = stmt.where(FileAsset.domain_id.is_(None)) if domain is None else stmt.where(
        FileAsset.domain_id == domain.id
    )
    asset = (await session.execute(stmt)).scalar_one_or_none()
    if asset is None:
        return Response(status_code=404, content="File not found.")

    brand = domain.hostname if (asset.branded and domain) else None
    if not ac.valid_email(email):
        return email_gate_page(action=f"/f/{short_code}/unlock", brand=brand, error=True)

    await ac.capture_lead(session, email, ip=ac.client_ip(request), file_id=asset.id)
    await session.commit()

    resp = RedirectResponse(url=f"/f/{short_code}", status_code=303)
    resp.set_cookie(
        ac.gate_cookie_name(short_code), "1",
        max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax",
    )
    return resp
