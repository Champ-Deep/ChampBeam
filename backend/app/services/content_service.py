"""Shared-content-library orchestration.

The interesting bit is :func:`mint_share`: when a member shares a library item
we give them their *own* trackable link/file (own short code, optionally on
their own domain) and record a ``ContentShare`` stamping the canonical
``content_id``. Different members sharing the same content thus produce distinct
links/files that still roll up to one content item in the admin's analytics.
"""

from __future__ import annotations

import secrets
import string
from typing import Optional
from uuid import UUID, uuid4

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.content import CONTENT_KIND_FILE, CONTENT_KIND_LINK, Content, ContentShare
from app.models.domain import STATUS_ACTIVE as DOMAIN_ACTIVE, Domain
from app.models.file_asset import STATUS_ACTIVE as FILE_ACTIVE, FileAsset
from app.models.utm import LinkClick
from app.services.utm_service import utm_service


def _short_code(n: int = 8) -> str:
    alphabet = string.ascii_letters + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(n))


def _scheme_for(host: str) -> str:
    return "http" if host.startswith(("localhost", "127.")) else "https"


def _safe_slug(filename: str) -> str:
    return "".join(c if c.isalnum() or c in ".-_" else "_" for c in filename)[:80]


async def _resolve_member_domain(
    session: AsyncSession, user_id: str, domain_id: Optional[str]
) -> Optional[Domain]:
    """A member's chosen active domain, or None (platform default). 400 if bad."""
    if not domain_id:
        return None
    try:
        did = UUID(domain_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid domain_id.")
    result = await session.execute(
        select(Domain).where(
            Domain.id == did,
            Domain.user_id == user_id,
            Domain.status == DOMAIN_ACTIVE,
        )
    )
    domain = result.scalar_one_or_none()
    if domain is None:
        raise HTTPException(status_code=400, detail="Domain not found, not yours, or not active.")
    return domain


async def _allocate_file_short_code(session: AsyncSession, domain_id: Optional[UUID]) -> str:
    for _ in range(8):
        code = _short_code()
        stmt = select(FileAsset.id).where(FileAsset.short_code == code)
        stmt = stmt.where(FileAsset.domain_id.is_(None)) if domain_id is None else stmt.where(
            FileAsset.domain_id == domain_id
        )
        if (await session.execute(stmt)).scalar_one_or_none() is None:
            return code
    raise HTTPException(status_code=503, detail="Could not allocate a unique short code.")


def _platform_host() -> str:
    return settings.resolved_platform_redirect_host or "localhost:8000"


def build_share_url(*, link: Optional[LinkClick], file: Optional[FileAsset], hostname: str) -> str:
    host = hostname or _platform_host()
    scheme = _scheme_for(host)
    if link is not None:
        return f"{scheme}://{host}/r/{link.short_code}"
    assert file is not None
    return f"{scheme}://{host}/f/{file.short_code}/{_safe_slug(file.filename)}"


async def mint_share(
    session: AsyncSession,
    content: Content,
    member_user_id: str,
    domain_id: Optional[str] = None,
) -> tuple[ContentShare, str]:
    """Create (or reuse) a member's link/file for ``content`` and record a share.

    Returns ``(content_share, share_url)``. Re-sharing the same item on the same
    domain reuses the existing link/file so a member ends up with one stable URL
    per item rather than a new one each click of "Share".
    """
    domain = await _resolve_member_domain(session, member_user_id, domain_id)
    domain_uuid = domain.id if domain else None
    hostname = domain.hostname if domain else _platform_host()

    # Idempotent: one share per (content, member, domain). Re-sharing returns the
    # member's existing link/file so they keep one stable URL per item.
    existing = await _existing_share(session, content, member_user_id, domain_uuid)
    if existing is not None:
        link = await session.get(LinkClick, existing.link_id) if existing.link_id else None
        file = await session.get(FileAsset, existing.file_id) if existing.file_id else None
        return existing, build_share_url(link=link, file=file, hostname=hostname)

    if content.kind == CONTENT_KIND_LINK:
        if not content.canonical_url:
            raise HTTPException(status_code=400, detail="This content has no link to share.")
        link = await utm_service.record_link(
            user_id=member_user_id,
            original_url=content.canonical_url,
            tracked_url=content.canonical_url,
            utm_params={},
            domain_id=domain_uuid,
            session=session,
        )
        share = await _record_share(session, content, member_user_id, link_id=link.id, domain_uuid=domain_uuid)
        return share, build_share_url(link=link, file=None, hostname=hostname)

    if content.kind == CONTENT_KIND_FILE:
        master = await _load_master_file(session, content)
        code = await _allocate_file_short_code(session, domain_uuid)
        copy = FileAsset(
            id=uuid4(),
            user_id=UUID(member_user_id),
            domain_id=domain_uuid,
            short_code=code,
            filename=master.filename,
            kind=master.kind,
            mime_type=master.mime_type,
            size_bytes=master.size_bytes,
            sha256=master.sha256,
            storage_key=master.storage_key,  # share the bytes; no re-upload
            status=FILE_ACTIVE,
            serve_mode=master.serve_mode,
            view_count=0,
        )
        session.add(copy)
        await session.flush()
        share = await _record_share(session, content, member_user_id, file_id=copy.id, domain_uuid=domain_uuid)
        return share, build_share_url(link=None, file=copy, hostname=hostname)

    raise HTTPException(status_code=400, detail=f"Unsupported content kind '{content.kind}'.")


async def _load_master_file(session: AsyncSession, content: Content) -> FileAsset:
    if not content.file_id:
        raise HTTPException(status_code=400, detail="This content has no file to share.")
    master = await session.get(FileAsset, content.file_id)
    if master is None or master.status != FILE_ACTIVE:
        raise HTTPException(status_code=409, detail="The source file is not available.")
    return master


async def _existing_share(
    session: AsyncSession, content: Content, member_user_id: str, domain_uuid: Optional[UUID]
) -> Optional[ContentShare]:
    """The member's existing share of this content on this domain, if any."""
    stmt = select(ContentShare).where(
        ContentShare.content_id == content.id,
        ContentShare.shared_by_user_id == member_user_id,
    )
    stmt = stmt.where(ContentShare.domain_id.is_(None)) if domain_uuid is None else stmt.where(
        ContentShare.domain_id == domain_uuid
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _record_share(
    session: AsyncSession,
    content: Content,
    member_user_id: str,
    *,
    link_id: Optional[UUID] = None,
    file_id: Optional[UUID] = None,
    domain_uuid: Optional[UUID] = None,
) -> ContentShare:
    share = ContentShare(
        id=uuid4(),
        content_id=content.id,
        organization_id=content.organization_id,
        shared_by_user_id=UUID(member_user_id),
        link_id=link_id,
        file_id=file_id,
        domain_id=domain_uuid,
    )
    session.add(share)
    await session.flush()
    return share
