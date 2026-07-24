"""File hosting endpoints, upload + manage assets served on /f/{code}."""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import string
from datetime import datetime, timedelta
from typing import List, Optional
from urllib.parse import urlparse
from uuid import UUID as _UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import TokenData, get_current_user, require_auth
from app.core.timeutils import iso_utc
from app.db.postgres import async_session_maker, get_db_session
from app.models.domain import Domain, STATUS_ACTIVE as DOMAIN_STATUS_ACTIVE
from app.models.file_asset import (
    FileAsset,
    KIND_HTML,
    KIND_IMAGE,
    KIND_OTHER,
    KIND_PDF,
    KIND_VIDEO,
    SERVE_REDIRECT,
    SERVE_STREAM,
    STATUS_ACTIVE,
    STATUS_DELETED,
    STATUS_FAILED,
    STATUS_PENDING_UPLOAD,
)
from app.models.utm import ClickEvent, Project
from app.services import storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/files", tags=["Files"])


# ============================================================================
# MIME → kind → cap mapping
# ============================================================================
#
# Caps are per-kind. Anything above the cap is rejected at intent time.
# Anything classified as 'video' or 'other' uses redirect-serve to avoid
# routing GB-sized bodies through Railway.

_MIME_KIND = {
    "application/pdf": KIND_PDF,
    "text/html": KIND_HTML,
    "video/mp4": KIND_VIDEO,
    "video/webm": KIND_VIDEO,
    "image/png": KIND_IMAGE,
    "image/jpeg": KIND_IMAGE,
    "image/webp": KIND_IMAGE,
}

# Per-kind upload caps (authed users). Single source of truth — the Files and
# Generator upload UIs render their size hints from these same numbers, so the
# copy can't drift from what the API actually accepts. HTML is roomier than
# PDF/image because HTML one-pagers inline their assets (images/CSS/fonts).
_KIND_CAP_BYTES = {
    KIND_PDF: 50 * 1024 * 1024,
    KIND_HTML: 20 * 1024 * 1024,
    KIND_IMAGE: 10 * 1024 * 1024,
    KIND_VIDEO: 500 * 1024 * 1024,
    KIND_OTHER: 50 * 1024 * 1024,
}

# Tighter caps for anonymous (signed-out) uploads, bounds abuse and disk use
# on the shared platform-default namespace. Authed users keep _KIND_CAP_BYTES.
_GUEST_KIND_CAP_BYTES = {
    KIND_PDF: 10 * 1024 * 1024,
    KIND_HTML: 10 * 1024 * 1024,
    KIND_IMAGE: 5 * 1024 * 1024,
    KIND_VIDEO: 50 * 1024 * 1024,
    KIND_OTHER: 10 * 1024 * 1024,
}

_KIND_SERVE_MODE = {
    KIND_PDF: SERVE_STREAM,
    KIND_HTML: SERVE_STREAM,
    KIND_IMAGE: SERVE_STREAM,
    KIND_VIDEO: SERVE_REDIRECT,
    KIND_OTHER: SERVE_REDIRECT,
}


# ============================================================================
# Schemas
# ============================================================================


class FileInit(BaseModel):
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(..., min_length=1, max_length=127)
    size_bytes: int = Field(..., ge=1)
    domain_id: Optional[str] = None


class FileInitResponse(BaseModel):
    file_id: str
    short_code: str
    # For S3 this is a presigned PUT URL; for the local backend it's the API
    # path of the blob endpoint (with a signed token). The field name is kept
    # for backwards compatibility with the frontend client.
    presigned_put_url: str
    headers: dict
    serve_mode: str
    # Guest (anonymous) uploads only, returned once.
    owner_token: Optional[str] = None
    expires_at: Optional[str] = None
    # True when the browser uploads to our own backend (local) rather than S3.
    upload_via_backend: bool = False


class FileResponse(BaseModel):
    id: str
    short_code: str
    filename: str
    kind: str
    mime_type: str
    size_bytes: int
    status: str
    serve_mode: str
    view_count: int
    last_viewed_at: Optional[str] = None
    created_at: str
    serve_url: str
    domain_id: Optional[str] = None
    expires_at: Optional[str] = None
    project_id: Optional[str] = None
    # Access controls (security console).
    max_views: Optional[int] = None
    remaining_views: Optional[int] = None
    require_email: bool = False
    block_vpn: bool = False
    branded: bool = False
    revoked: bool = False
    access_status: str = "tracking"  # tracking | expiring | expired


class FileUpdateRequest(BaseModel):
    # Assign/move the file to a project (folder); send null to unfile it.
    project_id: Optional[str] = None


class FileAccessRequest(BaseModel):
    # Only fields actually sent are applied (checked via model_fields_set).
    # For the two int limits, send 0 to CLEAR, a positive number to SET.
    expires_in_hours: Optional[int] = None
    max_views: Optional[int] = None
    require_email: Optional[bool] = None
    block_vpn: Optional[bool] = None
    branded: Optional[bool] = None
    revoked: Optional[bool] = None


class LeadResponse(BaseModel):
    email: str
    ip_address: Optional[str] = None
    created_at: str


class FileFinalizeRequest(BaseModel):
    # Lets an anonymous uploader finalize their own guest file without auth.
    owner_token: Optional[str] = None


class FileFinalizeResponse(FileResponse):
    pass


class FileStatusResponse(BaseModel):
    view_count: int
    last_viewed_at: Optional[str] = None
    expires_at: Optional[str] = None
    status: str
    seen: bool


# ============================================================================
# Helpers
# ============================================================================


def _ensure_storage() -> None:
    if not settings.storage_configured:
        raise HTTPException(
            status_code=503,
            detail=(
                "File storage is not configured on this deployment. Set "
                "STORAGE_BACKEND and its credentials (local needs none; mongo "
                "needs MONGO_URL; s3 needs the SUPABASE_STORAGE_* vars), then "
                "redeploy."
            ),
        )


def _generate_short_code() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _classify(content_type: str) -> str:
    return _MIME_KIND.get(content_type.lower().split(";", 1)[0].strip(), KIND_OTHER)


def _storage_key(user_id: Optional[str], file_id: _UUID, filename: str) -> str:
    # Sanitize to ASCII-safe slug; original filename is preserved on the row.
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in filename)[:80]
    if user_id:
        return f"u/{user_id}/{file_id}/{safe}"
    return f"anon/{file_id}/{safe}"


async def _serve_host(
    session: AsyncSession, user_id, domain_id: Optional[_UUID]
) -> str:
    """Pick the hostname to embed in the file's serve URL.

    Order: explicit domain_id → user's primary active domain → platform default.
    Anonymous assets (no user_id) always use the platform-default host.
    """
    if user_id:
        if domain_id is not None:
            result = await session.execute(
                select(Domain).where(
                    Domain.id == domain_id,
                    Domain.user_id == user_id,
                    Domain.status == DOMAIN_STATUS_ACTIVE,
                )
            )
            d = result.scalar_one_or_none()
            if d:
                return d.hostname

        result = await session.execute(
            select(Domain).where(
                Domain.user_id == user_id,
                Domain.is_primary.is_(True),
                Domain.status == DOMAIN_STATUS_ACTIVE,
            )
        )
        primary = result.scalar_one_or_none()
        if primary:
            return primary.hostname

    return settings.resolved_platform_redirect_host or _host_from_base_url()


def _host_from_base_url() -> str:
    parsed = urlparse(settings.redirect_base_url)
    return parsed.netloc or "localhost:8000"


def _scheme_for(host: str) -> str:
    if host.startswith("localhost") or host.startswith("127."):
        return "http"
    return "https"


def _build_serve_url(host: str, short_code: str, filename: str) -> str:
    # Slug is purely cosmetic; the handler uses {code} for routing.
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in filename)[:80]
    return f"{_scheme_for(host)}://{host}/f/{short_code}/{safe}"


def _access_status(asset: FileAsset) -> str:
    """tracking (no self-destruct) | expiring (controls set, still live) | expired."""
    now = datetime.utcnow()
    views = asset.view_count or 0
    is_expired = (
        asset.revoked_at is not None
        or (asset.expires_at is not None and asset.expires_at < now)
        or (asset.max_views is not None and views >= asset.max_views)
    )
    if is_expired:
        return "expired"
    if asset.expires_at is not None or asset.max_views is not None or asset.revoked_at is not None:
        return "expiring"
    return "tracking"


async def _to_response(session: AsyncSession, asset: FileAsset) -> FileResponse:
    host = await _serve_host(session, asset.user_id, asset.domain_id)
    views = asset.view_count or 0
    remaining = max(0, asset.max_views - views) if asset.max_views is not None else None
    return FileResponse(
        id=str(asset.id),
        short_code=asset.short_code,
        filename=asset.filename,
        kind=asset.kind,
        mime_type=asset.mime_type,
        size_bytes=asset.size_bytes,
        status=asset.status,
        serve_mode=asset.serve_mode,
        view_count=views,
        last_viewed_at=iso_utc(asset.last_viewed_at),
        created_at=iso_utc(asset.created_at) or "",
        serve_url=_build_serve_url(host, asset.short_code, asset.filename),
        domain_id=str(asset.domain_id) if asset.domain_id else None,
        expires_at=iso_utc(asset.expires_at),
        project_id=str(asset.project_id) if asset.project_id else None,
        max_views=asset.max_views,
        remaining_views=remaining,
        require_email=bool(asset.require_email),
        block_vpn=bool(asset.block_vpn),
        branded=bool(asset.branded),
        revoked=asset.revoked_at is not None,
        access_status=_access_status(asset),
    )


def _authorize_asset(
    asset: FileAsset, user: Optional[TokenData], owner_token: Optional[str]
) -> bool:
    """True if the caller owns the asset (authed user) or holds its owner token."""
    if user is not None and asset.user_id is not None and str(asset.user_id) == user.user_id:
        return True
    if owner_token and asset.owner_token_hash:
        digest = hashlib.sha256(owner_token.encode()).hexdigest()
        return hmac.compare_digest(digest, asset.owner_token_hash)
    return False


async def _user_storage_used(session: AsyncSession, user_id: str) -> int:
    result = await session.execute(
        select(func.coalesce(func.sum(FileAsset.size_bytes), 0)).where(
            FileAsset.user_id == user_id,
            FileAsset.status.in_([STATUS_PENDING_UPLOAD, STATUS_ACTIVE]),
        )
    )
    return int(result.scalar() or 0)


async def _allocate_unique_short_code(
    session: AsyncSession, domain_id: Optional[_UUID]
) -> str:
    """Generate a short_code unique within the given (NULL = platform) namespace.

    The partial unique indexes from migration 009 are the source of truth; this
    pre-check is just to avoid an obvious collision before insert.
    """
    for _ in range(8):
        code = _generate_short_code()
        stmt = select(FileAsset.id).where(FileAsset.short_code == code)
        if domain_id is None:
            stmt = stmt.where(FileAsset.domain_id.is_(None))
        else:
            stmt = stmt.where(FileAsset.domain_id == domain_id)
        existing = (await session.execute(stmt)).scalar_one_or_none()
        if existing is None:
            return code
    raise HTTPException(status_code=503, detail="Could not allocate a unique short code.")


# ============================================================================
# Background tasks
# ============================================================================


async def _compute_sha256_async(file_id: _UUID, storage_key: str) -> None:
    """Stream the object once to compute a SHA-256. Best-effort."""
    try:
        h = hashlib.sha256()
        async for chunk in storage.stream_object(storage_key):
            h.update(chunk)
        digest = h.hexdigest()
        async with async_session_maker() as session:
            result = await session.execute(select(FileAsset).where(FileAsset.id == file_id))
            asset = result.scalar_one_or_none()
            if asset:
                asset.sha256 = digest
                await session.commit()
    except Exception:
        logger.exception("sha256 background task failed for file_id=%s", file_id)


async def _delete_storage_async(storage_key: str) -> None:
    try:
        await storage.delete_object(storage_key)
    except storage.StorageError:
        logger.exception("delete_object failed for key=%s", storage_key)
    except storage.StorageNotConfigured:
        pass


# ============================================================================
# Endpoints
# ============================================================================


@router.post("", response_model=FileInitResponse, status_code=201)
async def init_upload(
    data: FileInit,
    user: Optional[TokenData] = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Begin an upload: validate, allocate a short_code, return an upload target.

    Works signed-out: an anonymous (guest) upload gets a tighter size cap, an
    auto-expiry, and an owner_token so the uploader can later check whether the
    file has been opened. The browser then PUTs the bytes to the returned URL
    (S3 presigned URL, or our local blob endpoint) and calls
    POST /api/v1/files/{file_id}/finalize.
    """
    _ensure_storage()
    is_guest = user is None

    # Any content type is accepted. Known types (pdf, image, html, video) get
    # their specific kind and inline serving; everything else (zip, documents,
    # archives, arbitrary files) is classified KIND_OTHER and served as a safe
    # download (Content-Disposition: attachment).
    kind = _classify(data.content_type)

    caps = _GUEST_KIND_CAP_BYTES if is_guest else _KIND_CAP_BYTES
    cap = caps[kind]
    if data.size_bytes > cap:
        raise HTTPException(
            status_code=413,
            detail=f"{kind.upper()} uploads are capped at {cap // (1024 * 1024)} MB.",
        )

    domain_uuid: Optional[_UUID] = None
    if is_guest:
        # Guests share the platform-default namespace; custom domains need auth.
        if data.domain_id:
            raise HTTPException(status_code=400, detail="Custom domains require an account.")
    else:
        used = await _user_storage_used(session, user.user_id)
        if used + data.size_bytes > settings.max_bytes_per_user:
            raise HTTPException(
                status_code=402,
                detail=(
                    f"Storage quota exceeded "
                    f"({used // (1024 * 1024)} MB used of "
                    f"{settings.max_bytes_per_user // (1024 * 1024)} MB)."
                ),
            )
        if data.domain_id:
            try:
                domain_uuid = _UUID(data.domain_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid domain_id.")
            d = await session.execute(
                select(Domain).where(
                    Domain.id == domain_uuid,
                    Domain.user_id == user.user_id,
                    Domain.status == DOMAIN_STATUS_ACTIVE,
                )
            )
            if d.scalar_one_or_none() is None:
                raise HTTPException(
                    status_code=400,
                    detail="Domain not found, not yours, or not active.",
                )

    short_code = await _allocate_unique_short_code(session, domain_uuid)
    file_id = uuid4()
    owner_user_id = user.user_id if user else None
    key = _storage_key(owner_user_id, file_id, data.filename)

    # The local backend has no redirect serve mode (it streams from disk);
    # only S3 uses the per-kind redirect mode for large videos.
    serve_mode = _KIND_SERVE_MODE[kind] if storage.backend_is_s3() else SERVE_STREAM

    try:
        upload = storage.prepare_upload(str(file_id), key, data.content_type, data.size_bytes)
    except storage.StorageNotConfigured:
        raise HTTPException(status_code=503, detail="File storage is not configured.")
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")

    expires_at: Optional[datetime] = None
    owner_token_raw: Optional[str] = None
    owner_token_hash: Optional[str] = None
    if is_guest:
        expires_at = datetime.utcnow() + timedelta(seconds=settings.anon_file_ttl_seconds)
        owner_token_raw = secrets.token_urlsafe(32)
        owner_token_hash = hashlib.sha256(owner_token_raw.encode()).hexdigest()

    asset = FileAsset(
        id=file_id,
        user_id=owner_user_id,
        domain_id=domain_uuid,
        short_code=short_code,
        filename=data.filename,
        kind=kind,
        mime_type=data.content_type,
        size_bytes=data.size_bytes,
        storage_key=key,
        status=STATUS_PENDING_UPLOAD,
        serve_mode=serve_mode,
        view_count=0,
        created_at=datetime.utcnow(),
        expires_at=expires_at,
        owner_token_hash=owner_token_hash,
    )
    session.add(asset)
    await session.commit()

    return FileInitResponse(
        file_id=str(asset.id),
        short_code=asset.short_code,
        presigned_put_url=upload["url"],
        headers=upload["headers"],
        serve_mode=asset.serve_mode,
        owner_token=owner_token_raw,
        expires_at=iso_utc(expires_at),
        upload_via_backend=bool(upload.get("via_backend")),
    )


@router.post("/{file_id}/finalize", response_model=FileFinalizeResponse)
async def finalize_upload(
    file_id: str,
    background_tasks: BackgroundTasks,
    body: Optional[FileFinalizeRequest] = None,
    user: Optional[TokenData] = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Verify the bytes landed in storage and flip the asset to active.

    Callable by the owning user OR by an anonymous uploader presenting the
    owner_token returned from init_upload.
    """
    _ensure_storage()

    try:
        fid = _UUID(file_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file_id.")

    result = await session.execute(select(FileAsset).where(FileAsset.id == fid))
    asset = result.scalar_one_or_none()
    owner_token = body.owner_token if body else None
    if asset is None or not _authorize_asset(asset, user, owner_token):
        raise HTTPException(status_code=404, detail="File not found.")

    if asset.status == STATUS_ACTIVE:
        return await _to_response(session, asset)
    if asset.status not in {STATUS_PENDING_UPLOAD, STATUS_FAILED}:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot finalize from status '{asset.status}'.",
        )

    try:
        head = await storage.head_object(asset.storage_key)
    except storage.StorageNotConfigured:
        raise HTTPException(status_code=503, detail="File storage is not configured.")
    except storage.StorageError as exc:
        asset.status = STATUS_FAILED
        await session.commit()
        raise HTTPException(
            status_code=400,
            detail=f"Upload not found in storage. The PUT may have failed: {exc}",
        )

    actual_size = int(head.get("size") or 0)
    if actual_size != asset.size_bytes:
        asset.status = STATUS_FAILED
        await session.commit()
        raise HTTPException(
            status_code=400,
            detail=(
                f"Uploaded size ({actual_size} B) does not match the declared "
                f"size ({asset.size_bytes} B)."
            ),
        )

    asset.status = STATUS_ACTIVE
    await session.commit()

    background_tasks.add_task(_compute_sha256_async, asset.id, asset.storage_key)

    return await _to_response(session, asset)


@router.put("/{file_id}/blob", status_code=204)
async def upload_blob(
    file_id: str,
    request: Request,
    token: str = Query(..., description="Signed upload token from init_upload."),
    session: AsyncSession = Depends(get_db_session),
):
    """Receive raw bytes for the LOCAL storage backend (S3 uploads bypass this).

    Authorized by the HMAC token from init_upload, passed in the query string,
    not a header, so the cross-origin PUT doesn't trip CORS preflight. The body
    is streamed straight to disk and capped at the declared size.
    """
    if storage.backend_is_s3():
        raise HTTPException(status_code=404, detail="Not found.")
    try:
        fid = _UUID(file_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file_id.")
    if not storage.verify_blob_token(file_id, token):
        raise HTTPException(status_code=403, detail="Invalid or expired upload token.")

    result = await session.execute(select(FileAsset).where(FileAsset.id == fid))
    asset = result.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="File not found.")
    if asset.status != STATUS_PENDING_UPLOAD:
        raise HTTPException(status_code=409, detail="This upload was already finalized.")

    try:
        await storage.write_stream(asset.storage_key, request.stream(), asset.size_bytes)
    except storage.StorageFileTooLarge:
        asset.status = STATUS_FAILED
        await session.commit()
        raise HTTPException(status_code=413, detail="Upload exceeds the declared size.")
    except storage.StorageError as exc:
        asset.status = STATUS_FAILED
        await session.commit()
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")

    return Response(status_code=204)


@router.get("/{file_id}/status", response_model=FileStatusResponse)
async def file_status(
    file_id: str,
    owner_token: Optional[str] = Query(None),
    user: Optional[TokenData] = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Lightweight 'has it been opened?' poll for a file's owner or guest token."""
    try:
        fid = _UUID(file_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file_id.")

    result = await session.execute(select(FileAsset).where(FileAsset.id == fid))
    asset = result.scalar_one_or_none()
    if asset is None or asset.status == STATUS_DELETED:
        raise HTTPException(status_code=404, detail="File not found.")
    if not _authorize_asset(asset, user, owner_token):
        raise HTTPException(status_code=403, detail="Not authorized for this file.")

    expired = asset.expires_at is not None and asset.expires_at < datetime.utcnow()
    views = asset.view_count or 0
    return FileStatusResponse(
        view_count=views,
        last_viewed_at=iso_utc(asset.last_viewed_at),
        expires_at=iso_utc(asset.expires_at),
        status="expired" if expired else asset.status,
        seen=views > 0,
    )


@router.get("", response_model=List[FileResponse])
async def list_files(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    result = await session.execute(
        select(FileAsset)
        .where(
            FileAsset.user_id == user.user_id,
            FileAsset.status != STATUS_DELETED,
        )
        .order_by(FileAsset.created_at.desc())
    )
    rows = result.scalars().all()
    out: list[FileResponse] = []
    for a in rows:
        out.append(await _to_response(session, a))
    return out


@router.patch("/{file_id}", response_model=FileResponse)
async def update_file(
    file_id: str,
    data: FileUpdateRequest,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a file's mutable fields. Currently: assign it to a project (folder)."""
    asset = await _get_owned_file(file_id, user.user_id, session)
    if "project_id" in data.model_fields_set:
        if data.project_id:
            try:
                pid = _UUID(data.project_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid project_id.")
            owns = await session.execute(
                select(Project.id).where(
                    Project.id == pid, Project.user_id == user.user_id
                )
            )
            if owns.scalar_one_or_none() is None:
                raise HTTPException(status_code=404, detail="Project not found.")
            asset.project_id = pid
        else:
            asset.project_id = None
    await session.commit()
    await session.refresh(asset)
    return await _to_response(session, asset)


@router.put("/{file_id}/access", response_model=FileResponse)
async def set_file_access(
    file_id: str,
    data: FileAccessRequest,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Set self-destruct / access controls on a file (owner only).

    Only the fields present in the request body are changed; for the int limits
    send 0 to clear and a positive number to set.
    """
    asset = await _get_owned_file(file_id, user.user_id, session)
    fields = data.model_fields_set
    now = datetime.utcnow()
    if "expires_in_hours" in fields:
        asset.expires_at = (
            now + timedelta(hours=data.expires_in_hours) if data.expires_in_hours else None
        )
    if "max_views" in fields:
        asset.max_views = data.max_views if (data.max_views and data.max_views > 0) else None
    if "require_email" in fields:
        asset.require_email = bool(data.require_email)
    if "block_vpn" in fields:
        asset.block_vpn = bool(data.block_vpn)
    if "branded" in fields:
        asset.branded = bool(data.branded)
    if "revoked" in fields:
        asset.revoked_at = now if data.revoked else None
    await session.commit()
    await session.refresh(asset)
    return await _to_response(session, asset)


@router.get("/{file_id}/leads", response_model=List[LeadResponse])
async def file_leads(
    file_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Emails captured by this file's access gate (owner only)."""
    from app.models.access_lead import AccessLead

    asset = await _get_owned_file(file_id, user.user_id, session)
    rows = (await session.execute(
        select(AccessLead).where(AccessLead.file_id == asset.id).order_by(AccessLead.created_at.desc())
    )).scalars().all()
    return [
        LeadResponse(email=r.email, ip_address=r.ip_address, created_at=iso_utc(r.created_at) or "")
        for r in rows
    ]


@router.get("/{file_id}/pages")
async def file_page_engagement(
    file_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Per-page engagement heatmap for a document (owner only): for each page,
    average dwell (ms), total dwell, and how many view-sessions reached it."""
    from app.models.page_engagement import PageEngagement

    asset = await _get_owned_file(file_id, user.user_id, session)
    rows = (await session.execute(
        select(
            PageEngagement.page.label("page"),
            func.avg(PageEngagement.dwell_ms).label("avg_ms"),
            func.sum(PageEngagement.dwell_ms).label("total_ms"),
            func.count(func.distinct(PageEngagement.session_id)).label("sessions"),
        )
        .where(PageEngagement.file_id == asset.id)
        .group_by(PageEngagement.page)
        .order_by(PageEngagement.page)
    )).all()
    pages = [
        {
            "page": int(r.page),
            "avg_ms": int(r.avg_ms or 0),
            "total_ms": int(r.total_ms or 0),
            "sessions": int(r.sessions or 0),
        }
        for r in rows
    ]
    peak = max((p["avg_ms"] for p in pages), default=0)
    return {"pages": pages, "peak_avg_ms": peak}


# ============================================================================
# Per-file analytics (owner only). File opens are recorded as ClickEvent rows
# with file_id set, so these mirror /utm/analytics/links/{id}/*, filtered by
# file_id instead of link_id, to make every shared file individually trackable.
# ============================================================================


def _file_date_range(days: int, start_date: Optional[str], end_date: Optional[str]):
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


async def _get_owned_file(file_id: str, user_id, session: AsyncSession) -> FileAsset:
    """Fetch a non-deleted file owned by the user. 400 on bad id, 404 otherwise."""
    try:
        fid = _UUID(file_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file_id.")
    result = await session.execute(
        select(FileAsset).where(
            FileAsset.id == fid,
            FileAsset.user_id == user_id,
            FileAsset.status != STATUS_DELETED,
        )
    )
    asset = result.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="File not found.")
    return asset


@router.get("/{file_id}/summary")
async def file_analytics_summary(
    file_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Headline open stats for one file."""
    asset = await _get_owned_file(file_id, user.user_id, session)
    range_start, range_end = _file_date_range(days, start_date, end_date)
    totals = await session.execute(
        select(
            func.count(ClickEvent.id).label("opens"),
            func.count(func.distinct(ClickEvent.ip_address)).label("unique_opens"),
        ).where(
            ClickEvent.file_id == asset.id,
            ClickEvent.clicked_at >= range_start,
            ClickEvent.clicked_at <= range_end,
        )
    )
    row = totals.one()
    return {
        "file_id": str(asset.id),
        "filename": asset.filename,
        "short_code": asset.short_code,
        "view_count": asset.view_count or 0,
        "opens": row.opens or 0,
        "unique_opens": row.unique_opens or 0,
        "last_viewed_at": iso_utc(asset.last_viewed_at),
        "created_at": iso_utc(asset.created_at),
    }


@router.get("/{file_id}/events")
async def file_view_events(
    file_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Individual opens for one file (most recent 500)."""
    asset = await _get_owned_file(file_id, user.user_id, session)
    range_start, range_end = _file_date_range(days, start_date, end_date)
    events = await session.execute(
        select(ClickEvent)
        .where(
            ClickEvent.file_id == asset.id,
            ClickEvent.clicked_at >= range_start,
            ClickEvent.clicked_at <= range_end,
        )
        .order_by(ClickEvent.clicked_at.desc())
        .limit(500)
    )
    return [
        {
            "id": str(e.id),
            "ip_address": e.ip_address,
            "device_type": e.device_type,
            "browser": e.browser,
            "os": e.os,
            "country": e.country,
            "country_code": e.country_code,
            "region": e.region,
            "city": e.city,
            "referrer": e.referrer,
            "is_vpn": e.is_vpn or False,
            "asn_org": e.asn_org,
            "clicked_at": iso_utc(e.clicked_at),
        }
        for e in events.scalars().all()
    ]


@router.get("/{file_id}/geo")
async def file_geo_breakdown(
    file_id: str,
    level: str = Query(default="country", description="country, region, or city"),
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Geographic breakdown of opens for one file."""
    asset = await _get_owned_file(file_id, user.user_id, session)
    range_start, range_end = _file_date_range(days, start_date, end_date)
    where = (
        ClickEvent.file_id == asset.id,
        ClickEvent.clicked_at >= range_start,
        ClickEvent.clicked_at <= range_end,
    )
    if level == "region":
        result = await session.execute(
            select(ClickEvent.country, ClickEvent.country_code, ClickEvent.region,
                   func.count(ClickEvent.id).label("clicks"))
            .where(*where)
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [{"country": r.country, "country_code": r.country_code, "region": r.region, "clicks": r.clicks} for r in result.all()]
    if level == "city":
        result = await session.execute(
            select(ClickEvent.country, ClickEvent.country_code, ClickEvent.region, ClickEvent.city,
                   func.count(ClickEvent.id).label("clicks"))
            .where(*where)
            .group_by(ClickEvent.country, ClickEvent.country_code, ClickEvent.region, ClickEvent.city)
            .order_by(func.count(ClickEvent.id).desc())
        )
        return [{"country": r.country, "country_code": r.country_code, "region": r.region, "city": r.city, "clicks": r.clicks} for r in result.all()]
    result = await session.execute(
        select(ClickEvent.country, ClickEvent.country_code,
               func.count(ClickEvent.id).label("clicks"))
        .where(*where)
        .group_by(ClickEvent.country, ClickEvent.country_code)
        .order_by(func.count(ClickEvent.id).desc())
    )
    return [{"country": r.country, "country_code": r.country_code, "clicks": r.clicks} for r in result.all()]


@router.get("/{file_id}/devices")
async def file_device_breakdown(
    file_id: str,
    days: int = Query(default=30, ge=1, le=365),
    start_date: Optional[str] = Query(default=None),
    end_date: Optional[str] = Query(default=None),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Device + browser breakdown of opens for one file."""
    asset = await _get_owned_file(file_id, user.user_id, session)
    range_start, range_end = _file_date_range(days, start_date, end_date)
    where = (
        ClickEvent.file_id == asset.id,
        ClickEvent.clicked_at >= range_start,
        ClickEvent.clicked_at <= range_end,
    )
    device_result = await session.execute(
        select(ClickEvent.device_type, func.count(ClickEvent.id).label("clicks"))
        .where(*where).group_by(ClickEvent.device_type).order_by(func.count(ClickEvent.id).desc())
    )
    browser_result = await session.execute(
        select(ClickEvent.browser, func.count(ClickEvent.id).label("clicks"))
        .where(*where).group_by(ClickEvent.browser).order_by(func.count(ClickEvent.id).desc())
    )
    return {
        "devices": [{"device_type": r.device_type, "clicks": r.clicks} for r in device_result.all()],
        "browsers": [{"browser": r.browser, "clicks": r.clicks} for r in browser_result.all()],
    }


@router.delete("/{file_id}", status_code=204)
async def delete_file(
    file_id: str,
    background_tasks: BackgroundTasks,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        fid = _UUID(file_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid file_id.")

    result = await session.execute(
        select(FileAsset).where(
            FileAsset.id == fid,
            FileAsset.user_id == user.user_id,
        )
    )
    asset = result.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="File not found.")

    asset.status = STATUS_DELETED
    await session.commit()
    background_tasks.add_task(_delete_storage_async, asset.storage_key)
