"""File hosting endpoints — upload + manage assets served on /f/{code}."""

from __future__ import annotations

import hashlib
import logging
import secrets
import string
from datetime import datetime
from typing import List, Optional
from urllib.parse import urlparse
from uuid import UUID as _UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import TokenData, require_auth
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

_KIND_CAP_BYTES = {
    KIND_PDF: 50 * 1024 * 1024,
    KIND_HTML: 1 * 1024 * 1024,
    KIND_IMAGE: 10 * 1024 * 1024,
    KIND_VIDEO: 500 * 1024 * 1024,
    KIND_OTHER: 50 * 1024 * 1024,
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
    presigned_put_url: str
    headers: dict
    serve_mode: str


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


class FileFinalizeResponse(FileResponse):
    pass


# ============================================================================
# Helpers
# ============================================================================


def _ensure_storage() -> None:
    if not settings.storage_configured:
        raise HTTPException(
            status_code=503,
            detail=(
                "File storage is not configured on this deployment. "
                "Set SUPABASE_STORAGE_ENDPOINT, _ACCESS_KEY_ID, "
                "_SECRET_ACCESS_KEY, and _BUCKET, then redeploy."
            ),
        )


def _generate_short_code() -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


def _classify(content_type: str) -> str:
    return _MIME_KIND.get(content_type.lower().split(";", 1)[0].strip(), KIND_OTHER)


def _storage_key(user_id: str, file_id: _UUID, filename: str) -> str:
    # Sanitize to ASCII-safe slug; original filename is preserved on the row.
    safe = "".join(c if c.isalnum() or c in ".-_" else "_" for c in filename)[:80]
    return f"u/{user_id}/{file_id}/{safe}"


async def _serve_host(
    session: AsyncSession, user_id: str, domain_id: Optional[_UUID]
) -> str:
    """Pick the hostname to embed in the file's serve URL.

    Order: explicit domain_id → user's primary active domain → platform default.
    """
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


async def _to_response(
    session: AsyncSession, user_id: str, asset: FileAsset
) -> FileResponse:
    host = await _serve_host(session, user_id, asset.domain_id)
    return FileResponse(
        id=str(asset.id),
        short_code=asset.short_code,
        filename=asset.filename,
        kind=asset.kind,
        mime_type=asset.mime_type,
        size_bytes=asset.size_bytes,
        status=asset.status,
        serve_mode=asset.serve_mode,
        view_count=asset.view_count or 0,
        last_viewed_at=asset.last_viewed_at.isoformat() if asset.last_viewed_at else None,
        created_at=asset.created_at.isoformat() if asset.created_at else "",
        serve_url=_build_serve_url(host, asset.short_code, asset.filename),
        domain_id=str(asset.domain_id) if asset.domain_id else None,
    )


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
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Begin an upload: validate, allocate a short_code, return a presigned PUT.

    The browser then PUTs the bytes directly to Supabase and follows up with
    POST /api/v1/files/{file_id}/finalize.
    """
    _ensure_storage()

    kind = _classify(data.content_type)
    if kind == KIND_OTHER and data.content_type.lower() not in _MIME_KIND:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported content type: {data.content_type}",
        )

    cap = _KIND_CAP_BYTES[kind]
    if data.size_bytes > cap:
        raise HTTPException(
            status_code=413,
            detail=f"{kind.upper()} uploads are capped at {cap // (1024 * 1024)} MB.",
        )

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

    domain_uuid: Optional[_UUID] = None
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
    key = _storage_key(user.user_id, file_id, data.filename)

    try:
        presigned = storage.generate_presigned_put(key, data.content_type)
    except storage.StorageNotConfigured:
        raise HTTPException(status_code=503, detail="File storage is not configured.")
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")

    asset = FileAsset(
        id=file_id,
        user_id=user.user_id,
        domain_id=domain_uuid,
        short_code=short_code,
        filename=data.filename,
        kind=kind,
        mime_type=data.content_type,
        size_bytes=data.size_bytes,
        storage_key=key,
        status=STATUS_PENDING_UPLOAD,
        serve_mode=_KIND_SERVE_MODE[kind],
        view_count=0,
        created_at=datetime.utcnow(),
    )
    session.add(asset)
    await session.commit()

    return FileInitResponse(
        file_id=str(asset.id),
        short_code=asset.short_code,
        presigned_put_url=presigned["url"],
        headers=presigned["headers"],
        serve_mode=asset.serve_mode,
    )


@router.post("/{file_id}/finalize", response_model=FileFinalizeResponse)
async def finalize_upload(
    file_id: str,
    background_tasks: BackgroundTasks,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Verify the bytes landed in storage and flip the asset to active."""
    _ensure_storage()

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

    if asset.status == STATUS_ACTIVE:
        return await _to_response(session, user.user_id, asset)
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

    return await _to_response(session, user.user_id, asset)


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
        out.append(await _to_response(session, user.user_id, a))
    return out


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
