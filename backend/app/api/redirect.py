"""Redirect endpoint for tracked short links."""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.postgres import get_db_session
from app.models.utm import LinkClick
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Redirect"])


@router.get("/r/{short_code}")
async def redirect_link(
    short_code: str,
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db_session),
):
    """Redirect a short code to its destination, recording the click."""
    result = await session.execute(
        select(LinkClick).where(LinkClick.short_code == short_code)
    )
    link = result.scalar_one_or_none()

    if not link:
        return RedirectResponse(url="/", status_code=302)

    # Extract visitor info
    ip_address = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not ip_address:
        ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("User-Agent")
    referrer = request.headers.get("Referer")

    # Record click event (UA parsed inline, geo resolved in background)
    event = await utm_service.record_click_event(
        link=link,
        ip_address=ip_address,
        user_agent_str=user_agent,
        referrer=referrer,
        session=session,
    )

    # Resolve GeoIP in background so the redirect is fast
    if ip_address:
        background_tasks.add_task(
            utm_service.resolve_geo_for_event, event.id, ip_address,
        )

    destination = link.tracked_url or link.original_url
    return RedirectResponse(url=destination, status_code=302)
