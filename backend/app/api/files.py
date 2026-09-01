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
from pydantic import BaseModel, Field
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import access_control as ac
from app.api.access_pages import blocked_page, code_gate_page, email_gate_page
from app.core.config import settings
from app.db.postgres import get_db_session
from app.models.page_engagement import PageEngagement  # noqa: F401  (register table)
from app.models.domain import Domain, STATUS_ACTIVE as DOMAIN_STATUS_ACTIVE
from app.models.file_asset import (
    FileAsset,
    KIND_HTML,
    KIND_OTHER,
    SERVE_REDIRECT,
    STATUS_ACTIVE,
)
from app.services import pages_service, storage
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
    # Google Fonts is the one external dependency hosted pages routinely need
    # (stylesheet from fonts.googleapis.com, woff2 from fonts.gstatic.com).
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
    "script-src 'self' 'unsafe-inline'; "
    "font-src 'self' data: https://fonts.gstatic.com; "
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


async def _lookup_asset(
    session: AsyncSession,
    domain: Optional[Domain],
    *,
    short_code: Optional[str] = None,
    slug: Optional[str] = None,
) -> Optional[FileAsset]:
    """Find the active asset for ``short_code`` OR ``slug`` in the host's namespace.

    Platform host → ``domain_id IS NULL``. A custom domain serves its owner's
    whole library: assets explicitly assigned to this domain AND the owner's
    platform-bucket assets (domain_id NULL), because serve URLs are minted on
    the user's PRIMARY domain even for assets created before that domain
    existed. Exact domain match wins when both buckets hold the same code.
    """
    if (short_code is None) == (slug is None):
        raise ValueError("pass exactly one of short_code / slug")
    ident = FileAsset.short_code == short_code if short_code is not None else FileAsset.slug == slug
    stmt = select(FileAsset).where(ident, FileAsset.status == STATUS_ACTIVE)
    if domain is None:
        stmt = stmt.where(FileAsset.domain_id.is_(None))
    else:
        stmt = (
            stmt.where(
                or_(
                    FileAsset.domain_id == domain.id,
                    and_(
                        FileAsset.user_id == domain.user_id,
                        FileAsset.domain_id.is_(None),
                    ),
                )
            )
            .order_by((FileAsset.domain_id == domain.id).desc())
            .limit(1)
        )
    return (await session.execute(stmt)).scalars().first()


def _is_https(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto.split(",")[0].strip() == "https"


async def _read_blob(storage_key: str) -> bytes:
    chunks: list[bytes] = []
    async for chunk in storage.stream_object(storage_key):
        chunks.append(chunk)
    return b"".join(chunks)


async def _serve_asset(
    asset: FileAsset,
    domain: Optional[Domain],
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession,
):
    """Gates → count the view → serve. Shared by /f/{code} and /p/{slug}."""
    short_code = asset.short_code
    brand = domain.hostname if (asset.branded and domain) else None
    ip_address = ac.client_ip(request)

    # --- Access gates (before serving / counting a view) -----------------
    # Access-code gate first: authorize before identify, so uninvited visitors
    # are never asked for (and never leak) an email.
    if getattr(asset, "access_code_hash", None) and not ac.has_code_cookie(request, asset):
        return code_gate_page(action=f"/f/{short_code}/unlock-code", brand=brand)
    # Email gate: capture a lead before access.
    if asset.require_email and not ac.has_gate_cookie(request, short_code):
        return email_gate_page(action=f"/f/{short_code}/unlock", brand=brand)
    # VPN/proxy block.
    if asset.block_vpn and await ac.is_vpn_ip(ip_address):
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

    # --- Visitor identity + revisit detection ----------------------------
    visitor_id = pages_service.valid_visitor_id(request.cookies.get(pages_service.VISITOR_COOKIE))
    is_new_visitor = visitor_id is None
    if is_new_visitor:
        visitor_id = pages_service.new_visitor_id()
    is_revisit = False
    if not is_new_visitor:
        last = await utm_service.last_file_view_at(session, asset.id, visitor_id)
        if last is not None:
            gap = (datetime.utcnow() - last).total_seconds()
            is_revisit = gap >= settings.pages_revisit_window_s

    user_agent = request.headers.get("User-Agent")
    referrer = request.headers.get("Referer")

    # Beam State: hosted pages get a page-scoped public token (minted lazily,
    # persisted with the view below) that the injected helper uses.
    if asset.kind == KIND_HTML:
        from app.services.page_state import ensure_state_token

        ensure_state_token(asset)

    event = await utm_service.record_file_view_event(
        file=asset,
        ip_address=ip_address,
        user_agent_str=user_agent,
        referrer=referrer,
        session=session,
        domain_id=domain.id if domain else None,
        visitor_id=visitor_id,
        is_revisit=is_revisit,
    )
    # Commit NOW, not at dependency teardown: with a StreamingResponse the
    # yield-dependency (and its commit) only closes after the whole response
    # cycle, background tasks included -- so resolve_geo_for_event would query
    # a row that is not yet visible and drop the enrichment. expire_on_commit
    # is False, so the asset attributes used below stay loaded.
    await session.commit()

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

    try:
        if asset.kind == KIND_HTML and (asset.size_bytes or 0) <= settings.pages_inject_max_bytes:
            # Beam Pages: inject the tracking snippet at serve time. The stored
            # blob is never modified; the body is per-visitor so it is not cached.
            payload = await _read_blob(asset.storage_key)
            snippet = pages_service.tracking_snippet(
                visitor_id=visitor_id,
                page_id=str(asset.id),
                beacon_url=f"/f/{short_code}/page-events",
                extra_js=pages_service.state_snippet_js(asset),
            )
            headers = _common_headers(asset)
            headers["Cache-Control"] = "no-store"
            resp: Response = Response(
                content=pages_service.inject_snippet(payload, snippet),
                status_code=200,
                headers=headers,
                media_type=asset.mime_type,
            )
        else:
            # Stream mode, bytes proxied through the API.
            resp = StreamingResponse(
                storage.stream_object(asset.storage_key),
                status_code=200,
                headers=_common_headers(asset),
                media_type=asset.mime_type,
            )
    except storage.StorageNotConfigured:
        return Response(status_code=503, content="Storage not configured.")

    resp.set_cookie(
        pages_service.VISITOR_COOKIE,
        visitor_id,
        max_age=pages_service.VISITOR_COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=_is_https(request),
        path="/",
    )
    return resp


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

    asset = await _lookup_asset(session, domain, short_code=short_code)
    if asset is None:
        return Response(status_code=404, content="File not found.")
    return await _serve_asset(asset, domain, request, background_tasks, session)


@router.get("/p/{slug}")
async def serve_page(
    slug: str,
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db_session),
):
    """Beam Pages: serve a hosted page by its editable slug (same gates and
    tracking as /f/{code}; the page's legacy /f/ URL keeps working too)."""
    host = _request_host(request)
    domain = await _resolve_domain(host, session)
    if host and domain is None and not settings.is_platform_host(host):
        return Response(status_code=404, content="Page not found.")

    asset = await _lookup_asset(session, domain, slug=slug.strip().lower())
    if asset is None or asset.kind != KIND_HTML:
        return Response(status_code=404, content="Page not found.")
    return await _serve_asset(asset, domain, request, background_tasks, session)


class _PageEvent(BaseModel):
    page: int = Field(ge=0, le=100000)
    dwell_ms: int = Field(ge=0, le=86_400_000)  # cap a single page at 24h


# A single heartbeat can never claim more than this; the snippet reports every
# 15 s, so anything larger is a stalled tab or a forged payload.
_MAX_DWELL_PER_REPORT_MS = 60_000


class PageEventsRequest(BaseModel):
    session_id: str = Field(min_length=1, max_length=64)
    visitor_id: Optional[str] = Field(default=None, max_length=32)
    events: list[_PageEvent] = Field(max_length=1000)


@router.post("/f/{short_code}/page-events", status_code=204)
async def ingest_page_events(
    short_code: str,
    request: Request,
    data: PageEventsRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """Public: the instrumented viewer reports per-page dwell time for a document.

    No auth — viewers aren't signed in; the file is identified by its short code
    (+ host namespace), same as the serve path.
    """
    host = _request_host(request)
    domain = await _resolve_domain(host, session)
    if host and domain is None and not settings.is_platform_host(host):
        return Response(status_code=404, content="File not found.")
    asset = await _lookup_asset(session, domain, short_code=short_code)
    if asset is None:
        return Response(status_code=404, content="File not found.")

    ip = ac.client_ip(request)
    sid = data.session_id[:64]
    # Trust the cookie over the body; fall back to the body for beacons sent
    # without credentials.
    visitor_id = pages_service.valid_visitor_id(
        request.cookies.get(pages_service.VISITOR_COOKIE)
    ) or pages_service.valid_visitor_id(data.visitor_id)
    for e in data.events:
        session.add(PageEngagement(
            file_id=asset.id,
            session_id=sid,
            visitor_id=visitor_id,
            page=e.page,
            dwell_ms=min(e.dwell_ms, _MAX_DWELL_PER_REPORT_MS),
            ip_address=ip,
        ))
    await session.commit()
    return Response(status_code=204)


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
    if host and domain is None and not settings.is_platform_host(host):
        return Response(status_code=404, content="File not found.")
    asset = await _lookup_asset(session, domain, short_code=short_code)
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


async def _unlock_code(
    request: Request,
    session: AsyncSession,
    *,
    short_code: Optional[str] = None,
    slug: Optional[str] = None,
    code: str = "",
):
    host = _request_host(request)
    domain = await _resolve_domain(host, session)
    if host and domain is None and not settings.is_platform_host(host):
        return Response(status_code=404, content="Page not found.")
    asset = await _lookup_asset(session, domain, short_code=short_code, slug=slug)
    if asset is None:
        return Response(status_code=404, content="Page not found.")
    brand = domain.hostname if (asset.branded and domain) else None
    back = f"/p/{asset.slug}" if asset.slug else f"/f/{asset.short_code}"
    action = f"/f/{asset.short_code}/unlock-code"

    if not asset.access_code_hash:
        return RedirectResponse(url=back, status_code=303)

    ip = ac.client_ip(request)
    if await ac.code_attempt_limited(ip, asset.id):
        return code_gate_page(action=action, brand=brand, error="too_many")

    if not ac.verify_access_code(asset, code):
        from app.models.page_state import EVENT_GATE_FAILED
        from app.services.page_state import record_page_event

        record_page_event(
            session, asset.id, EVENT_GATE_FAILED, ref="code",
            visitor_id=pages_service.valid_visitor_id(request.cookies.get(pages_service.VISITOR_COOKIE)),
            ip=ip,
        )
        await session.commit()
        return code_gate_page(action=action, brand=brand, error="wrong")

    resp = RedirectResponse(url=back, status_code=303)
    resp.set_cookie(
        ac.code_cookie_name(asset.short_code), ac.code_cookie_value(asset),
        max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax", secure=_is_https(request), path="/",
    )
    return resp


@router.post("/f/{short_code}/unlock-code")
async def unlock_code_by_code(
    short_code: str,
    request: Request,
    code: str = Form(default=""),
    session: AsyncSession = Depends(get_db_session),
):
    """Access-code gate submit (Beam Pages): verify, set cookie, re-enter the page."""
    return await _unlock_code(request, session, short_code=short_code, code=code)


@router.post("/p/{slug}/unlock-code")
async def unlock_code_by_slug(
    slug: str,
    request: Request,
    code: str = Form(default=""),
    session: AsyncSession = Depends(get_db_session),
):
    return await _unlock_code(request, session, slug=slug.strip().lower(), code=code)
