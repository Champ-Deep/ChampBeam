"""Public Beam State API: per-page comments + key-value state for hosted pages.

Mounted at ``/api/pages`` (NOT under /api/v1) so it is same-origin with the
served page on every host — platform or BYOD — and satisfies the hosted-HTML
CSP's ``connect-src 'self'``. Auth is the page-scoped public token the serve
path injects into the page (``window.__BEAM__.token``); it only ever addresses
its own page because every lookup is page-first.

410 on every route once the page is killed (revoked / expired / view cap).
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import access_control as ac
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.models.file_asset import FileAsset
from app.models.page_state import (
    EVENT_COMMENT_ADDED,
    EVENT_STATE_CHANGED,
    PageComment,
    PageState,
)
from app.services import page_state as ps
from app.services.pages_service import VISITOR_COOKIE, valid_visitor_id

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/pages", tags=["Beam State"])


class CommentIn(BaseModel):
    author: str = Field(..., max_length=ps.MAX_AUTHOR)
    body: str = Field(..., max_length=ps.MAX_COMMENT_BODY + 1)


def _comment_out(c: PageComment) -> dict:
    return {"id": str(c.id), "author": c.author, "body": c.body, "ts": iso_utc(c.created_at)}


async def _page_for_write(request: Request, ident: str, session: AsyncSession) -> FileAsset:
    asset = await ps.resolve_public_page(request, ident, session)
    if asset is None:
        raise HTTPException(status_code=404, detail="Page not found.")
    if ps.page_killed(asset):
        raise HTTPException(status_code=410, detail="This page is no longer available.")
    ps.check_token(asset, request)
    return asset


async def _page_for_read(request: Request, ident: str, session: AsyncSession) -> FileAsset:
    # Reads need the token too: state can hold whatever the page put there.
    return await _page_for_write(request, ident, session)


def _visitor(request: Request) -> Optional[str]:
    return valid_visitor_id(request.cookies.get(VISITOR_COOKIE))


# ---------------------------------------------------------------------------
# Comments
# ---------------------------------------------------------------------------


@router.get("/{ident}/comments")
async def list_comments(
    ident: str,
    request: Request,
    after: Optional[str] = Query(default=None, description="Comment id; return newer ones"),
    limit: int = Query(default=200, ge=1, le=500),
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _page_for_read(request, ident, session)
    stmt = select(PageComment).where(PageComment.page_id == asset.id)
    if after:
        try:
            after_uuid = UUID(after)
        except ValueError:
            raise HTTPException(status_code=400, detail="after must be a comment id.")
        anchor = (
            await session.execute(
                select(PageComment).where(PageComment.id == after_uuid, PageComment.page_id == asset.id)
            )
        ).scalar_one_or_none()
        if anchor is not None:
            stmt = stmt.where(PageComment.created_at > anchor.created_at)
    rows = (await session.execute(stmt.order_by(PageComment.created_at.asc()).limit(limit))).scalars().all()
    return {
        "comments": [_comment_out(c) for c in rows],
        "next_after": str(rows[-1].id) if rows else after,
    }


@router.post("/{ident}/comments", status_code=201)
async def add_comment(
    ident: str,
    request: Request,
    data: CommentIn,
    session: AsyncSession = Depends(get_db_session),
):
    asset = await _page_for_write(request, ident, session)
    author, body = ps.validate_comment(data.author, data.body)
    ip = ac.client_ip(request)
    await ps.enforce_write_limit(ip, asset.id)
    if await ps.comment_count(session, asset.id) >= ps.MAX_COMMENTS_PER_PAGE:
        raise HTTPException(status_code=409, detail="This page has reached its comment limit.")

    visitor = _visitor(request)
    comment = PageComment(page_id=asset.id, author=author, body=body, visitor_id=visitor, ip=ip)
    session.add(comment)
    await session.flush()
    ps.record_page_event(session, asset.id, EVENT_COMMENT_ADDED, ref=str(comment.id), visitor_id=visitor, ip=ip)
    await session.commit()
    return _comment_out(comment)


# ---------------------------------------------------------------------------
# Key-value state
# ---------------------------------------------------------------------------


def _state_out(s: PageState) -> dict:
    return {"key": s.key, "value": s.value, "updated_at": iso_utc(s.updated_at)}


@router.get("/{ident}/state")
async def get_all_state(
    ident: str, request: Request, session: AsyncSession = Depends(get_db_session)
):
    asset = await _page_for_read(request, ident, session)
    rows = (
        await session.execute(select(PageState).where(PageState.page_id == asset.id).order_by(PageState.key))
    ).scalars().all()
    latest = max((r.updated_at for r in rows), default=None)
    return {"state": {r.key: r.value for r in rows}, "updated_at": iso_utc(latest)}


@router.get("/{ident}/state/{key}")
async def get_state(
    ident: str, key: str, request: Request, session: AsyncSession = Depends(get_db_session)
):
    asset = await _page_for_read(request, ident, session)
    row = (
        await session.execute(
            select(PageState).where(PageState.page_id == asset.id, PageState.key == key)
        )
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="Key not set.")
    return _state_out(row)


@router.put("/{ident}/state/{key}")
async def put_state(
    ident: str,
    key: str,
    request: Request,
    value: Any = Body(default=None),
    session: AsyncSession = Depends(get_db_session),
):
    """Last-writer-wins JSON value for ``key``. Any JSON value is accepted."""
    from datetime import datetime

    asset = await _page_for_write(request, ident, session)
    key = ps.validate_key(key)
    ps.validate_value(value)
    ip = ac.client_ip(request)
    await ps.enforce_write_limit(ip, asset.id)
    visitor = _visitor(request)

    row = (
        await session.execute(
            select(PageState).where(PageState.page_id == asset.id, PageState.key == key)
        )
    ).scalar_one_or_none()
    if row is None:
        if await ps.key_count(session, asset.id) >= ps.MAX_KEYS_PER_PAGE:
            raise HTTPException(status_code=409, detail="This page has reached its key limit.")
        row = PageState(page_id=asset.id, key=key, value=value, updated_by_visitor=visitor)
        session.add(row)
        try:
            await session.flush()
        except IntegrityError:
            # Lost a race with another writer creating the same key: fall back to update.
            await session.rollback()
            row = (
                await session.execute(
                    select(PageState).where(PageState.page_id == asset.id, PageState.key == key)
                )
            ).scalar_one()
            row.value = value
            row.updated_at = datetime.utcnow()
            row.updated_by_visitor = visitor
    else:
        row.value = value
        row.updated_at = datetime.utcnow()
        row.updated_by_visitor = visitor
    ps.record_page_event(session, asset.id, EVENT_STATE_CHANGED, ref=key, visitor_id=visitor, ip=ip)
    await session.commit()
    return _state_out(row)


@router.delete("/{ident}/state/{key}", status_code=204)
async def delete_state_key(
    ident: str, key: str, request: Request, session: AsyncSession = Depends(get_db_session)
):
    asset = await _page_for_write(request, ident, session)
    ip = ac.client_ip(request)
    await ps.enforce_write_limit(ip, asset.id)
    row = (
        await session.execute(
            select(PageState).where(PageState.page_id == asset.id, PageState.key == key)
        )
    ).scalar_one_or_none()
    if row is not None:
        await session.delete(row)
        ps.record_page_event(session, asset.id, EVENT_STATE_CHANGED, ref=key, visitor_id=_visitor(request), ip=ip)
        await session.commit()
    return Response(status_code=204)
