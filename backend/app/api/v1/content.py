"""Shared content library endpoints (org-scoped).

Admins curate canonical content; members browse and share it. Every endpoint is
scoped to the caller's active organization (from the Clerk session token), and
write/admin operations are gated by the org role.
"""

from __future__ import annotations

import logging
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_org_admin, require_org_member
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.models.content import CONTENT_KIND_FILE, CONTENT_KIND_LINK, Content, ContentShare
from app.models.domain import Domain
from app.models.file_asset import STATUS_ACTIVE as FILE_ACTIVE, FileAsset
from app.models.utm import ClickEvent, LinkClick
from app.integrations.champvault_client import (
    ChampVault,
    ChampVaultError,
    ChampVaultNotConfigured,
)
from app.services import content_service, org_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/content", tags=["Content"])


# ============================================================================
# Schemas
# ============================================================================


class ContentCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    kind: str = Field(..., pattern="^(file|link)$")
    canonical_url: Optional[str] = None
    file_id: Optional[str] = None


class ContentUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None
    is_archived: Optional[bool] = None


class MyShare(BaseModel):
    share_id: str
    share_url: str
    opens: int


class ContentResponse(BaseModel):
    id: str
    title: str
    description: Optional[str]
    kind: str
    canonical_url: Optional[str]
    # Set when this library item is a live reference to an external ChampVault
    # asset (member shares re-mint a fresh delivery URL on each open). The UI uses
    # this to badge the item and hide the internal ``champvault://`` marker URL.
    champvault_asset_id: Optional[str] = None
    file_id: Optional[str]
    is_archived: bool
    created_at: str
    share_count: int
    my_share: Optional[MyShare] = None


class ChampVaultAddRequest(BaseModel):
    asset_id: str = Field(..., min_length=1, max_length=64)
    # Optional overrides; when omitted we resolve title/description from ChampVault.
    title: Optional[str] = Field(default=None, max_length=255)
    description: Optional[str] = None


class ShareRequest(BaseModel):
    domain_id: Optional[str] = None


class ShareResponse(BaseModel):
    share_id: str
    content_id: str
    share_url: str


# ============================================================================
# Helpers
# ============================================================================


async def _org_uuid(session: AsyncSession, user: TokenData) -> UUID:
    org_uuid = await org_service.resolve_org_uuid(session, user.org_id)
    if org_uuid is None:
        # sync_from_token on auth should have created it; this is a safety net.
        raise HTTPException(status_code=409, detail="Organization is not provisioned yet. Retry shortly.")
    return org_uuid


async def _get_org_content(session: AsyncSession, content_id: str, org_uuid: UUID) -> Content:
    try:
        cid = UUID(content_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid content id.")
    result = await session.execute(
        select(Content).where(Content.id == cid, Content.organization_id == org_uuid)
    )
    content = result.scalar_one_or_none()
    if content is None:
        raise HTTPException(status_code=404, detail="Content not found.")
    return content


async def _opens_for_share(session: AsyncSession, share: ContentShare) -> int:
    if share.link_id is not None:
        col = ClickEvent.link_id == share.link_id
    elif share.file_id is not None:
        col = ClickEvent.file_id == share.file_id
    else:
        return 0
    return int((await session.execute(select(func.count(ClickEvent.id)).where(col))).scalar() or 0)


async def _hostname_for_share(session: AsyncSession, share: ContentShare) -> str:
    if share.domain_id is not None:
        host = (await session.execute(
            select(Domain.hostname).where(Domain.id == share.domain_id)
        )).scalar_one_or_none()
        if host:
            return host
    return content_service._platform_host()


def _content_response(
    content: Content, *, share_count: int, my_share: Optional[MyShare]
) -> ContentResponse:
    return ContentResponse(
        id=str(content.id),
        title=content.title,
        description=content.description,
        kind=content.kind,
        canonical_url=content.canonical_url,
        champvault_asset_id=content.champvault_asset_id,
        file_id=str(content.file_id) if content.file_id else None,
        is_archived=content.is_archived,
        created_at=iso_utc(content.created_at) or "",
        share_count=share_count,
        my_share=my_share,
    )


async def _share_count(session: AsyncSession, content_id: UUID) -> int:
    return int((await session.execute(
        select(func.count(ContentShare.id)).where(ContentShare.content_id == content_id)
    )).scalar() or 0)


async def _build_my_share(session: AsyncSession, share: ContentShare) -> MyShare:
    link = await session.get(LinkClick, share.link_id) if share.link_id else None
    file = await session.get(FileAsset, share.file_id) if share.file_id else None
    host = await _hostname_for_share(session, share)
    return MyShare(
        share_id=str(share.id),
        share_url=content_service.build_share_url(link=link, file=file, hostname=host),
        opens=await _opens_for_share(session, share),
    )


# ============================================================================
# Endpoints
# ============================================================================


@router.get("", response_model=List[ContentResponse])
async def list_content(
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """List the org's (non-archived) library, annotated with the caller's share."""
    org_uuid = await _org_uuid(session, user)
    rows = (await session.execute(
        select(Content)
        .where(Content.organization_id == org_uuid, Content.is_archived.is_(False))
        .order_by(Content.created_at.desc())
    )).scalars().all()

    out: list[ContentResponse] = []
    for c in rows:
        mine = (await session.execute(
            select(ContentShare).where(
                ContentShare.content_id == c.id,
                ContentShare.shared_by_user_id == user.user_id,
            ).limit(1)
        )).scalar_one_or_none()
        out.append(_content_response(
            c,
            share_count=await _share_count(session, c.id),
            my_share=await _build_my_share(session, mine) if mine else None,
        ))
    return out


@router.post("", response_model=ContentResponse, status_code=201)
async def create_content(
    data: ContentCreate,
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Add an item to the library (admin only)."""
    org_uuid = await _org_uuid(session, user)

    file_uuid: Optional[UUID] = None
    if data.kind == CONTENT_KIND_LINK:
        if not data.canonical_url:
            raise HTTPException(status_code=400, detail="Link content needs a canonical_url.")
    elif data.kind == CONTENT_KIND_FILE:
        if not data.file_id:
            raise HTTPException(status_code=400, detail="File content needs a file_id.")
        try:
            file_uuid = UUID(data.file_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid file_id.")
        owned = (await session.execute(
            select(FileAsset).where(
                FileAsset.id == file_uuid,
                FileAsset.user_id == user.user_id,
                FileAsset.status == FILE_ACTIVE,
            )
        )).scalar_one_or_none()
        if owned is None:
            raise HTTPException(status_code=400, detail="File not found, not yours, or not active.")

    content = Content(
        organization_id=org_uuid,
        created_by_user_id=UUID(user.user_id),
        title=data.title,
        description=data.description,
        kind=data.kind,
        canonical_url=data.canonical_url,
        file_id=file_uuid,
    )
    session.add(content)
    await session.commit()
    await session.refresh(content)
    return _content_response(content, share_count=0, my_share=None)


@router.post("/from-champvault", response_model=ContentResponse, status_code=201)
async def add_champvault_content(
    data: ChampVaultAddRequest,
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Add a ChampVault asset to the library as a live reference (admin only).

    Idempotent per (org, asset): re-adding the same asset returns the existing
    library item. The item shares like any other content, and each member share
    re-mints a fresh ChampVault delivery URL on open (perpetual beams).
    """
    org_uuid = await _org_uuid(session, user)

    title = (data.title or "").strip()
    description = data.description
    # Resolve title/description from ChampVault when the admin didn't supply them.
    if not title:
        try:
            asset = await ChampVault().get_asset(data.asset_id)
        except ChampVaultNotConfigured:
            raise HTTPException(status_code=503, detail="ChampVault is not configured.")
        except ChampVaultError as exc:
            raise HTTPException(status_code=502, detail=f"ChampVault error: {exc}")
        title = asset.title or f"ChampVault asset {data.asset_id}"
        if description is None:
            description = asset.description

    content = await content_service.get_or_create_champvault_content(
        session,
        org_uuid,
        data.asset_id,
        title=title,
        description=description,
        created_by_user_id=user.user_id,
    )
    await session.commit()
    await session.refresh(content)
    return _content_response(
        content, share_count=await _share_count(session, content.id), my_share=None
    )


@router.patch("/{content_id}", response_model=ContentResponse)
async def update_content(
    content_id: str,
    data: ContentUpdate,
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    org_uuid = await _org_uuid(session, user)
    content = await _get_org_content(session, content_id, org_uuid)
    if data.title is not None:
        content.title = data.title
    if data.description is not None:
        content.description = data.description
    if data.is_archived is not None:
        content.is_archived = data.is_archived
    await session.commit()
    await session.refresh(content)
    return _content_response(
        content, share_count=await _share_count(session, content.id), my_share=None
    )


@router.delete("/{content_id}", status_code=204)
async def delete_content(
    content_id: str,
    user: TokenData = Depends(require_org_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a library item and its share records (members' links/files remain)."""
    org_uuid = await _org_uuid(session, user)
    content = await _get_org_content(session, content_id, org_uuid)
    await session.delete(content)
    await session.commit()


@router.post("/{content_id}/share", response_model=ShareResponse, status_code=201)
async def share_content(
    content_id: str,
    data: Optional[ShareRequest] = None,
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """Share a library item: mints the caller's own link/file and records it.

    The body is optional (integration clients often POST an empty body).
    """
    org_uuid = await _org_uuid(session, user)
    content = await _get_org_content(session, content_id, org_uuid)
    if content.is_archived:
        raise HTTPException(status_code=409, detail="This content is archived.")
    domain_id = data.domain_id if data else None
    share, url = await content_service.mint_share(session, content, user.user_id, domain_id)
    await session.commit()
    return ShareResponse(share_id=str(share.id), content_id=str(content.id), share_url=url)


@router.get("/mine/shares", response_model=List[ContentResponse])
async def my_shares(
    user: TokenData = Depends(require_org_member),
    session: AsyncSession = Depends(get_db_session),
):
    """The caller's shares across the org library, with each share's open count."""
    org_uuid = await _org_uuid(session, user)
    rows = (await session.execute(
        select(Content, ContentShare)
        .join(ContentShare, ContentShare.content_id == Content.id)
        .where(
            Content.organization_id == org_uuid,
            ContentShare.shared_by_user_id == user.user_id,
        )
        .order_by(ContentShare.created_at.desc())
    )).all()

    out: list[ContentResponse] = []
    for content, share in rows:
        out.append(_content_response(
            content, share_count=0, my_share=await _build_my_share(session, share)
        ))
    return out
