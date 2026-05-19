"""
Short links redirect endpoint for ChampUTM.
"""

from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.postgres import get_db_session
from app.models.utm import LinkClick
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ShortLinks"])

@router.get("/s/{short_code}")
async def redirect_short_link(
    short_code: str,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Redirects a short code to its full UTM-tracked URL and increments click count.
    """
    result = await session.execute(
        select(LinkClick).where(LinkClick.short_code == short_code)
    )
    link = result.scalar_one_or_none()

    if not link:
        raise HTTPException(status_code=404, detail="Short link not found")

    # Increment link asynchronously.
    # We await it to ensure it happens before the redirect or rely on async background tasks,
    # but await is fine for now as it's just a single update.
    await utm_service.increment_link_click(str(link.id))

    # The redirect URL should be the tracked_url. If it doesn't exist, fallback to original_url.
    target_url = link.tracked_url or link.original_url

    return RedirectResponse(url=target_url, status_code=302)
