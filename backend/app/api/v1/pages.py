"""Beam Pages: publish and update persistent hosted HTML pages in one call.

A page is a hosted single-file HTML asset (checklist, dashboard, campaign plan)
behind a permanent trackable link. This router is a thin ergonomic wrapper over
the file-hosting pipeline: one POST publishes (no init/blob/finalize dance), one
PUT updates in place — the URL and QR never change across revisions.

Serving semantics come from the /f/ pipeline: inline <script>/<style> and
localStorage work untouched (CSP allows inline + Google Fonts), and every open
is recorded with geo + device analytics.

Auth: Clerk session, user API key (cb_live_*), or the service-key lane
(publish/update only, per the allowlist in app/core/service_auth.py).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional
from uuid import UUID as _UUID, uuid4

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.files import (
    _allocate_unique_short_code,
    _delete_blob_quiet,
    _ensure_storage,
    _KIND_CAP_BYTES,
    _serve_host,
    _storage_key,
)
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
from app.services import storage

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pages", tags=["Pages"])

_HTML_MIME = "text/html"


class PagePublish(BaseModel):
    html: str = Field(..., min_length=1)
    title: str = Field(default="Untitled page", max_length=200)
    domain_id: Optional[str] = None


class PageUpdate(BaseModel):
    html: str = Field(..., min_length=1)
    title: Optional[str] = Field(default=None, max_length=200)


class PageResponse(BaseModel):
    page_id: str
    short_code: str
    url: str
    title: str
    size_bytes: int
    view_count: int
    created_at: str


def _slug_filename(title: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_" else "-" for c in title.strip().lower())
    safe = "-".join(filter(None, safe.split("-")))[:60] or "page"
    return f"{safe}.html"


async def _page_response(session: AsyncSession, asset: FileAsset) -> PageResponse:
    host = await _serve_host(session, asset.user_id, asset.domain_id)
    return PageResponse(
        page_id=str(asset.id),
        short_code=asset.short_code,
        url=f"https://{host}/f/{asset.short_code}",
        title=asset.filename.removesuffix(".html").replace("-", " "),
        size_bytes=asset.size_bytes,
        view_count=asset.view_count or 0,
        created_at=iso_utc(asset.created_at) or "",
    )


def _html_bytes_or_413(html: str) -> bytes:
    payload = html.encode("utf-8")
    cap = _KIND_CAP_BYTES[KIND_HTML]
    if len(payload) > cap:
        raise HTTPException(
            status_code=413,
            detail=f"Page exceeds the {cap // (1024 * 1024)} MB HTML limit.",
        )
    return payload


async def _write_blob(key: str, payload: bytes) -> None:
    async def _source():
        yield payload

    try:
        await storage.write_stream(key, _source(), len(payload))
    except storage.StorageNotConfigured:
        raise HTTPException(status_code=503, detail="File storage is not configured.")
    except storage.StorageError as exc:
        raise HTTPException(status_code=502, detail=f"Storage error: {exc}")


@router.post("", response_model=PageResponse, status_code=201)
async def publish_page(
    data: PagePublish,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Publish an HTML page and get its permanent trackable URL.

    One call: send the HTML, receive `url`. Optional `domain_id` serves the
    page from one of your active custom domains.
    """
    _ensure_storage()
    payload = _html_bytes_or_413(data.html)

    domain_uuid: Optional[_UUID] = None
    if data.domain_id:
        try:
            domain_uuid = _UUID(data.domain_id)
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
            raise HTTPException(
                status_code=400, detail="Domain not found, not yours, or not active."
            )

    short_code = await _allocate_unique_short_code(session, domain_uuid)
    file_id = uuid4()
    filename = _slug_filename(data.title)
    key = _storage_key(user.user_id, file_id, filename)

    await _write_blob(key, payload)

    asset = FileAsset(
        id=file_id,
        user_id=user.user_id,
        domain_id=domain_uuid,
        short_code=short_code,
        filename=filename,
        kind=KIND_HTML,
        mime_type=_HTML_MIME,
        size_bytes=len(payload),
        storage_key=key,
        status=STATUS_ACTIVE,
        serve_mode=SERVE_STREAM,
        view_count=0,
        created_at=datetime.utcnow(),
    )
    session.add(asset)
    await session.commit()
    return await _page_response(session, asset)


@router.put("/{page_id}", response_model=PageResponse)
async def update_page(
    page_id: str,
    data: PageUpdate,
    background_tasks: BackgroundTasks,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a page in place. The URL, short code and QR stay identical.

    Atomic swap: the previous version keeps serving until the new bytes have
    fully landed. View history is preserved.
    """
    _ensure_storage()
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
            )
        )
    ).scalar_one_or_none()
    if asset is None or asset.status == STATUS_DELETED:
        raise HTTPException(status_code=404, detail="Page not found.")
    if asset.status != STATUS_ACTIVE:
        raise HTTPException(status_code=409, detail=f"Page is in status '{asset.status}'.")

    payload = _html_bytes_or_413(data.html)
    filename = _slug_filename(data.title) if data.title else asset.filename
    new_key = _storage_key(user.user_id, asset.id, f"{uuid4().hex[:8]}-{filename}")

    await _write_blob(new_key, payload)

    old_key = asset.storage_key
    asset.storage_key = new_key
    asset.filename = filename
    asset.size_bytes = len(payload)
    asset.sha256 = None
    await session.commit()

    if old_key != new_key:
        background_tasks.add_task(_delete_blob_quiet, old_key)
    return await _page_response(session, asset)
