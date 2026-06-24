"""Short links redirect endpoint for Champbeam.

This is the lighter sibling of ``/r/{short_code}``, it only increments the
aggregate ``click_count`` on LinkClick rather than recording a full
``ClickEvent``. Kept primarily so the ``short_url`` field returned by the
link-generate endpoint continues to resolve; the rich-analytics path lives at
``/r/``.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.postgres import get_db_session
from app.models.domain import Domain, STATUS_ACTIVE
from app.models.utm import LinkClick
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ShortLinks"])


@router.get("/s/{short_code}")
async def redirect_short_link(
    short_code: str,
    request: Request,
    session: AsyncSession = Depends(get_db_session),
):
    """Redirect a short code to its tracked URL, scoped by Host header."""
    host = (request.headers.get("host") or "").lower().split(":", 1)[0]
    domain_id = None
    if host and not settings.is_platform_host(host):
        result = await session.execute(
            select(Domain).where(Domain.hostname == host, Domain.status == STATUS_ACTIVE)
        )
        domain = result.scalar_one_or_none()
        if domain is None:
            raise HTTPException(status_code=404, detail="Short link not found")
        domain_id = domain.id

    stmt = select(LinkClick).where(LinkClick.short_code == short_code)
    if domain_id is None:
        stmt = stmt.where(LinkClick.domain_id.is_(None))
    else:
        stmt = stmt.where(LinkClick.domain_id == domain_id)

    result = await session.execute(stmt)
    link = result.scalar_one_or_none()
    if not link:
        raise HTTPException(status_code=404, detail="Short link not found")

    await utm_service.increment_link_click(str(link.id))
    target_url = link.tracked_url or link.original_url
    return RedirectResponse(url=target_url, status_code=302)
