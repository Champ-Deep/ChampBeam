"""Beam Pages: publish, update, manage and analyse hosted single-file HTML pages.

A page is a FileAsset (kind=html) behind a permanent trackable link. Publishing
is one call (JSON ``html`` or a multipart ``.html`` upload); updates keep the
URL and QR forever; every content change is retained as a version for
rollback. Serving semantics come from the public /f and /p routes in
app/api/files.py: inline JS/localStorage untouched, a tracking snippet injected
at serve time, per-view geo/device analytics plus revisit and dwell.

Auth: Clerk session, user API key (cb_live_*), or the service-key lane on the
write routes allowlisted in app/core/service_auth.py.
"""

from __future__ import annotations

import hashlib
import logging
import statistics
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID as _UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import Integer, cast, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.files import (
    _allocate_unique_short_code,
    _delete_blob_quiet,
    _ensure_storage,
    _serve_host,
    _storage_key,
)
from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.models.domain import Domain, STATUS_ACTIVE as DOMAIN_STATUS_ACTIVE
from app.models.file_asset import (
    FileAsset,
    KIND_HTML,
    SERVE_STREAM,
    STATUS_ACTIVE,
    STATUS_DELETED,
)
from app.models.file_version import FileVersion
from app.models.page_engagement import PageEngagement
from app.models.utm import ClickEvent
from app.services import pages_service, storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pages", tags=["Pages"])

_HTML_MIME = "text/html"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PagePublish(BaseModel):
    html: str = Field(..., min_length=1)
    title: str = Field(default="Untitled page", max_length=200)
    domain_id: Optional[str] = None
    slug: Optional[str] = Field(default=None, max_length=80)


class PageUpdate(BaseModel):
    html: str = Field(..., min_length=1)
    title: Optional[str] = Field(default=None, max_length=200)


class PagePatch(BaseModel):
    title: Optional[str] = Field(default=None, max_length=200)
    slug: Optional[str] = Field(default=None, max_length=80)
    enabled: Optional[bool] = None
    domain_id: Optional[str] = None
    # 4–8 digit access code; null clears. Enforced once Part B lands.
    access_code: Optional[str] = Field(default=None, max_length=8)


class PageResponse(BaseModel):
    page_id: str
    short_code: str
    slug: Optional[str] = None
    url: str
    legacy_url: str
    title: str
    size_bytes: int
    view_count: int
    unique_visitors: int = 0
    revisits: int = 0
    total_dwell_ms: int = 0
    enabled: bool = True
    has_access_code: bool = False
    domain_id: Optional[str] = None
    created_at: str
    updated_at: str
    current_version: int = 0


class VersionResponse(BaseModel):
    version_no: int
    size_bytes: int
    sha256: Optional[str] = None
    filename: str
    created_at: str
    current: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _title_from_filename(filename: str) -> str:
    return filename.removesuffix(".html").removesuffix(".htm").replace("-", " ") or "Untitled page"


def _filename_for(title: str) -> str:
    return f"{pages_service.slugify(title)}.html"


async def _get_owned_page(page_id: str, user: TokenData, session: AsyncSession) -> FileAsset:
    try:
        pid = _UUID(page_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid page id.")
    asset = (
        await session.execute(
            select(FileAsset).where(
                FileAsset.id == pid,
                FileAsset.user_id == user.user_id,
                FileAsset.kind == KIND_HTML,
                FileAsset.status != STATUS_DELETED,
            )
        )
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    return asset


async def _resolve_domain_uuid(
    user: TokenData, domain_id: Optional[str], session: AsyncSession
) -> Optional[_UUID]:
    if not domain_id:
        return None
    try:
        domain_uuid = _UUID(domain_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid domain_id.")
    owned = (
        await session.execute(
            select(Domain).where(
                Domain.id == domain_uuid,
                Domain.user_id == user.user_id,
                Domain.status == DOMAIN_STATUS_ACTIVE,
            )
        )
    ).scalar_one_or_none()
    if owned is None:
        raise HTTPException(status_code=400, detail="Domain not found, not yours, or not active.")
    return domain_uuid


async def _write_blob(key: str, payload: bytes) -> None:
    async def _source():
        yield payload

    try:
        await storage.write_stream(key, _source(), len(payload))
    except storage.StorageNotConfigured:
        raise HTTPException(status_code=503, detail="File storage is not configured.")
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")


async def _engagement_stats(session: AsyncSession, asset: FileAsset) -> dict:
    """unique_visitors / revisits / total_dwell_ms for one page (all time)."""
    views = (
        await session.execute(
            select(
                func.count(func.distinct(ClickEvent.visitor_id)).label("uniq"),
                func.count(func.distinct(ClickEvent.ip_address)).label("uniq_ip"),
                func.coalesce(func.sum(cast(ClickEvent.is_revisit, Integer)), 0).label("revisits"),
            ).where(ClickEvent.file_id == asset.id)
        )
    ).one()
    dwell = (
        await session.execute(
            select(func.coalesce(func.sum(PageEngagement.dwell_ms), 0)).where(
                PageEngagement.file_id == asset.id
            )
        )
    ).scalar_one()
    return {
        "unique_visitors": int(views.uniq or views.uniq_ip or 0),
        "revisits": int(views.revisits or 0),
        "total_dwell_ms": int(dwell or 0),
    }


async def _page_response(session: AsyncSession, asset: FileAsset) -> PageResponse:
    host = await _serve_host(session, asset.user_id, asset.domain_id)
    stats = await _engagement_stats(session, asset)
    version_no = await pages_service.current_version_no(session, asset)
    latest_version_at = (
        await session.execute(
            select(func.max(FileVersion.created_at)).where(FileVersion.file_id == asset.id)
        )
    ).scalar_one_or_none()
    slug = asset.slug
    url = f"https://{host}/p/{slug}" if slug else f"https://{host}/f/{asset.short_code}"
    return PageResponse(
        page_id=str(asset.id),
        short_code=asset.short_code,
        slug=slug,
        url=url,
        legacy_url=f"https://{host}/f/{asset.short_code}",
        title=_title_from_filename(asset.filename),
        size_bytes=asset.size_bytes,
        view_count=asset.view_count or 0,
        enabled=asset.revoked_at is None,
        has_access_code=bool(getattr(asset, "access_code_hash", None)),
        domain_id=str(asset.domain_id) if asset.domain_id else None,
        created_at=iso_utc(asset.created_at) or "",
        updated_at=iso_utc(latest_version_at or asset.created_at) or "",
        current_version=version_no,
        **stats,
    )


async def _publish(
    *,
    user: TokenData,
    session: AsyncSession,
    payload: bytes,
    title: str,
    domain_id: Optional[str],
    slug: Optional[str],
    filename: Optional[str],
    content_type: Optional[str],
) -> FileAsset:
    _ensure_storage()
    pages_service.validate_html_upload(filename or f"{pages_service.slugify(title)}.html", content_type, payload)
    domain_uuid = await _resolve_domain_uuid(user, domain_id, session)

    if slug:
        slug = pages_service.validate_slug(slug)
        if await pages_service.slug_taken(session, slug, domain_uuid):
            raise HTTPException(status_code=409, detail="That slug is already taken.")
    else:
        slug = await pages_service.unique_slug(session, title, domain_uuid)

    short_code = await _allocate_unique_short_code(session, domain_uuid)
    file_id = uuid4()
    stored_name = _filename_for(title)
    key = _storage_key(user.user_id, file_id, stored_name)
    await _write_blob(key, payload)

    asset = FileAsset(
        id=file_id,
        user_id=user.user_id,
        domain_id=domain_uuid,
        short_code=short_code,
        slug=slug,
        filename=stored_name,
        kind=KIND_HTML,
        mime_type=_HTML_MIME,
        size_bytes=len(payload),
        sha256=hashlib.sha256(payload).hexdigest(),
        storage_key=key,
        status=STATUS_ACTIVE,
        serve_mode=SERVE_STREAM,
        view_count=0,
        created_at=datetime.utcnow(),
    )
    session.add(asset)
    try:
        await session.flush()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="That slug is already taken.")
    await pages_service.record_version(
        session, asset, storage_key=key, size_bytes=len(payload), sha256=asset.sha256, filename=stored_name
    )
    await session.commit()
    return asset


# ---------------------------------------------------------------------------
# Publish / list / read / delete
# ---------------------------------------------------------------------------


@router.post("", response_model=PageResponse, status_code=201)
async def publish_page(
    data: PagePublish,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Publish an HTML page and get its permanent trackable URL.

    One call: send the HTML, receive `url` (`/p/{slug}`). Optional `slug`
    (else derived from the title), optional `domain_id` to serve from one of
    your active custom domains.
    """
    asset = await _publish(
        user=user,
        session=session,
        payload=data.html.encode("utf-8"),
        title=data.title,
        domain_id=data.domain_id,
        slug=data.slug,
        filename=None,
        content_type=_HTML_MIME,
    )
    return await _page_response(session, asset)


@router.post("/upload", response_model=PageResponse, status_code=201)
async def upload_page(
    file: UploadFile = File(...),
    title: Optional[str] = Form(default=None),
    domain_id: Optional[str] = Form(default=None),
    slug: Optional[str] = Form(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Publish by uploading a single .html file (multipart)."""
    payload = await file.read(settings.pages_max_bytes + 1)
    asset = await _publish(
        user=user,
        session=session,
        payload=payload,
        title=(title or _title_from_filename(file.filename or "")).strip() or "Untitled page",
        domain_id=domain_id,
        slug=slug,
        filename=file.filename,
        content_type=file.content_type,
    )
    return await _page_response(session, asset)


@router.get("", response_model=list[PageResponse])
async def list_pages(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Your pages, newest first."""
    rows = (
        await session.execute(
            select(FileAsset)
            .where(
                FileAsset.user_id == user.user_id,
                FileAsset.kind == KIND_HTML,
                FileAsset.status != STATUS_DELETED,
            )
            .order_by(FileAsset.created_at.desc())
        )
    ).scalars().all()
    return [await _page_response(session, a) for a in rows]


@router.get("/{page_id}", response_model=PageResponse)
async def get_page(
    page_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    return await _page_response(session, asset)


@router.delete("/{page_id}", status_code=204)
async def delete_page(
    page_id: str,
    background_tasks: BackgroundTasks,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Kill switch + cleanup: the URL stops resolving immediately (404) and
    every retained version blob is removed."""
    asset = await _get_owned_page(page_id, user, session)
    versions = await pages_service.list_versions(session, asset)
    keys = {v.storage_key for v in versions} | {asset.storage_key}
    for v in versions:
        await session.delete(v)
    asset.status = STATUS_DELETED
    await session.commit()
    for key in keys:
        background_tasks.add_task(_delete_blob_quiet, key)


# ---------------------------------------------------------------------------
# Update in place / settings
# ---------------------------------------------------------------------------


@router.put("/{page_id}", response_model=PageResponse)
async def update_page(
    page_id: str,
    data: PageUpdate,
    background_tasks: BackgroundTasks,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Replace the page content. URL, slug, short code and QR stay identical.

    Atomic swap: the previous version keeps serving until the new bytes have
    fully landed, and is retained for rollback (last ``pages_versions_keep``).
    """
    _ensure_storage()
    asset = await _get_owned_page(page_id, user, session)
    if asset.status != STATUS_ACTIVE:
        raise HTTPException(status_code=409, detail=f"Page is in status '{asset.status}'.")

    payload = data.html.encode("utf-8")
    pages_service.validate_html_upload(asset.filename, _HTML_MIME, payload)
    filename = _filename_for(data.title) if data.title else asset.filename
    new_key = _storage_key(user.user_id, asset.id, f"{uuid4().hex[:8]}-{filename}")
    await _write_blob(new_key, payload)

    asset.storage_key = new_key
    asset.filename = filename
    asset.size_bytes = len(payload)
    asset.sha256 = hashlib.sha256(payload).hexdigest()
    await pages_service.record_version(
        session, asset, storage_key=new_key, size_bytes=len(payload), sha256=asset.sha256, filename=filename
    )
    doomed = await pages_service.prune_versions(session, asset)
    await session.commit()
    for key in doomed:
        background_tasks.add_task(_delete_blob_quiet, key)
    return await _page_response(session, asset)


@router.patch("/{page_id}", response_model=PageResponse)
async def patch_page(
    page_id: str,
    data: PagePatch,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Change settings without touching content: slug, title, enabled (kill
    switch), domain, access code."""
    asset = await _get_owned_page(page_id, user, session)
    fields = data.model_fields_set

    if "domain_id" in fields:
        asset.domain_id = await _resolve_domain_uuid(user, data.domain_id, session)

    if "slug" in fields and data.slug is not None:
        slug = pages_service.validate_slug(data.slug)
        if await pages_service.slug_taken(session, slug, asset.domain_id, exclude_id=asset.id):
            raise HTTPException(status_code=409, detail="That slug is already taken.")
        asset.slug = slug

    if "title" in fields and data.title:
        asset.filename = _filename_for(data.title)

    if "enabled" in fields and data.enabled is not None:
        asset.revoked_at = None if data.enabled else datetime.utcnow()

    if "access_code" in fields:
        from app.api import access_control as ac  # Part B; no-op until the column exists

        setter = getattr(ac, "set_access_code", None)
        if setter is None:
            raise HTTPException(status_code=501, detail="Access codes are not available yet.")
        setter(asset, data.access_code)

    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        raise HTTPException(status_code=409, detail="That slug is already taken.")
    return await _page_response(session, asset)


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------


@router.get("/{page_id}/versions", response_model=list[VersionResponse])
async def list_page_versions(
    page_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    versions = await pages_service.list_versions(session, asset)
    return [
        VersionResponse(
            version_no=v.version_no,
            size_bytes=v.size_bytes,
            sha256=v.sha256,
            filename=v.filename,
            created_at=iso_utc(v.created_at) or "",
            current=(v.storage_key == asset.storage_key),
        )
        for v in versions
    ]


@router.post("/{page_id}/versions/{version_no}/rollback", response_model=PageResponse)
async def rollback_page(
    page_id: str,
    version_no: int,
    background_tasks: BackgroundTasks,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Make an older version current. Recorded as a NEW version (so history is
    linear and the rollback itself can be rolled back)."""
    _ensure_storage()
    asset = await _get_owned_page(page_id, user, session)
    target = (
        await session.execute(
            select(FileVersion).where(
                FileVersion.file_id == asset.id, FileVersion.version_no == version_no
            )
        )
    ).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=404, detail="Version not found.")
    if target.storage_key == asset.storage_key:
        return await _page_response(session, asset)

    try:
        chunks = [c async for c in storage.stream_object(target.storage_key)]
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")
    payload = b"".join(chunks)
    new_key = _storage_key(user.user_id, asset.id, f"{uuid4().hex[:8]}-{target.filename}")
    await _write_blob(new_key, payload)

    asset.storage_key = new_key
    asset.filename = target.filename
    asset.size_bytes = len(payload)
    asset.sha256 = target.sha256 or hashlib.sha256(payload).hexdigest()
    await pages_service.record_version(
        session, asset, storage_key=new_key, size_bytes=len(payload), sha256=asset.sha256, filename=target.filename
    )
    doomed = await pages_service.prune_versions(session, asset)
    await session.commit()
    for key in doomed:
        background_tasks.add_task(_delete_blob_quiet, key)
    return await _page_response(session, asset)


# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------


def _date_range(days: int, start_date: Optional[str], end_date: Optional[str]):
    now = datetime.utcnow()
    if start_date and end_date:
        try:
            start = datetime.fromisoformat(start_date)
            end = datetime.fromisoformat(end_date).replace(hour=23, minute=59, second=59)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid date format. Use ISO 8601 (YYYY-MM-DD).")
        if start > end:
            raise HTTPException(status_code=400, detail="start_date must be before end_date.")
        return start, end
    return now - timedelta(days=days), now


@router.get("/{page_id}/analytics")
async def page_analytics(
    page_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Headline numbers for one page in a window: views, unique visitors,
    revisits, and dwell (total + median per visit session)."""
    asset = await _get_owned_page(page_id, user, session)
    start, end = _date_range(days, start_date, end_date)

    row = (
        await session.execute(
            select(
                func.count(ClickEvent.id).label("views"),
                func.count(func.distinct(ClickEvent.visitor_id)).label("uniq"),
                func.count(func.distinct(ClickEvent.ip_address)).label("uniq_ip"),
                func.coalesce(func.sum(cast(ClickEvent.is_revisit, Integer)), 0).label("revisits"),
            ).where(
                ClickEvent.file_id == asset.id,
                ClickEvent.clicked_at >= start,
                ClickEvent.clicked_at <= end,
            )
        )
    ).one()

    per_session = (
        await session.execute(
            select(PageEngagement.session_id, func.sum(PageEngagement.dwell_ms))
            .where(
                PageEngagement.file_id == asset.id,
                PageEngagement.created_at >= start,
                PageEngagement.created_at <= end,
            )
            .group_by(PageEngagement.session_id)
        )
    ).all()
    dwells = [int(d or 0) for _, d in per_session]
    total_dwell = sum(dwells)

    return {
        "page_id": str(asset.id),
        "slug": asset.slug,
        "short_code": asset.short_code,
        "title": _title_from_filename(asset.filename),
        "view_count": asset.view_count or 0,
        "views": int(row.views or 0),
        "unique_visitors": int(row.uniq or row.uniq_ip or 0),
        "revisits": int(row.revisits or 0),
        "sessions": len(dwells),
        "total_dwell_ms": total_dwell,
        "median_dwell_ms": int(statistics.median(dwells)) if dwells else 0,
        "avg_dwell_ms": int(total_dwell / len(dwells)) if dwells else 0,
        "last_viewed_at": iso_utc(asset.last_viewed_at),
        "created_at": iso_utc(asset.created_at),
    }


# ---------------------------------------------------------------------------
# Beam State — owner moderation + timeline
# ---------------------------------------------------------------------------

from app.models.page_state import PageComment, PageEvent, PageState  # noqa: E402
from app.services import page_state as _ps  # noqa: E402


@router.get("/{page_id}/comments")
async def owner_list_comments(
    page_id: str,
    limit: int = Query(default=200, ge=1, le=1000),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    rows = (
        await session.execute(
            select(PageComment)
            .where(PageComment.page_id == asset.id)
            .order_by(PageComment.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    return [
        {
            "id": str(c.id),
            "author": c.author,
            "body": c.body,
            "visitor_id": c.visitor_id,
            "ip": c.ip,
            "created_at": iso_utc(c.created_at),
        }
        for c in rows
    ]


@router.delete("/{page_id}/comments/{comment_id}", status_code=204)
async def owner_delete_comment(
    page_id: str,
    comment_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    try:
        cid = _UUID(comment_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid comment id.")
    row = (
        await session.execute(
            select(PageComment).where(PageComment.id == cid, PageComment.page_id == asset.id)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Comment not found.")
    await session.delete(row)
    await session.commit()


@router.get("/{page_id}/state")
async def owner_get_state(
    page_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    rows = (
        await session.execute(select(PageState).where(PageState.page_id == asset.id).order_by(PageState.key))
    ).scalars().all()
    return {"state": {r.key: r.value for r in rows}, "count": len(rows)}


@router.delete("/{page_id}/state", status_code=204)
async def owner_clear_state(
    page_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    rows = (await session.execute(select(PageState).where(PageState.page_id == asset.id))).scalars().all()
    for r in rows:
        await session.delete(r)
    await session.commit()


@router.delete("/{page_id}/state/{key}", status_code=204)
async def owner_delete_state_key(
    page_id: str,
    key: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _get_owned_page(page_id, user, session)
    row = (
        await session.execute(
            select(PageState).where(PageState.page_id == asset.id, PageState.key == key)
        )
    ).scalar_one_or_none()
    if row is not None:
        await session.delete(row)
        await session.commit()


@router.post("/{page_id}/state-token/rotate")
async def rotate_state_token(
    page_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Mint a new public token; the old one is rejected immediately. Open tabs
    pick the new token up on their next page load."""
    asset = await _get_owned_page(page_id, user, session)
    token = _ps.rotate_state_token(asset)
    await session.commit()
    return {"state_token": token}


@router.get("/{page_id}/events")
async def page_events_timeline(
    page_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    limit: int = Query(default=500, ge=1, le=1000),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Merged page timeline: views (with revisits flagged) plus comment, state
    and gate events, newest first."""
    asset = await _get_owned_page(page_id, user, session)
    start, end = _date_range(days, start_date, end_date)

    views = (
        await session.execute(
            select(ClickEvent)
            .where(
                ClickEvent.file_id == asset.id,
                ClickEvent.clicked_at >= start,
                ClickEvent.clicked_at <= end,
            )
            .order_by(ClickEvent.clicked_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    others = (
        await session.execute(
            select(PageEvent)
            .where(
                PageEvent.page_id == asset.id,
                PageEvent.created_at >= start,
                PageEvent.created_at <= end,
            )
            .order_by(PageEvent.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()

    timeline = [
        {
            "type": "revisit" if e.is_revisit else "view",
            "ts": iso_utc(e.clicked_at),
            "_sort": e.clicked_at,
            "ip": e.ip_address,
            "visitor_id": e.visitor_id,
            "ref": None,
            "country": e.country,
            "city": e.city,
            "device_type": e.device_type,
            "browser": e.browser,
            "os": e.os,
            "is_vpn": e.is_vpn or False,
        }
        for e in views
    ] + [
        {
            "type": p.event_type,
            "ts": iso_utc(p.created_at),
            "_sort": p.created_at,
            "ip": p.ip,
            "visitor_id": p.visitor_id,
            "ref": p.ref,
            "country": None,
            "city": None,
            "device_type": None,
            "browser": None,
            "os": None,
            "is_vpn": False,
        }
        for p in others
    ]
    timeline.sort(key=lambda x: x["_sort"] or datetime.min, reverse=True)
    for item in timeline:
        item.pop("_sort", None)
    return timeline[:limit]
