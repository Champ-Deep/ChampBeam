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
    """Redirect a short code to its destination, recording the click best-effort.

    Click tracking is wrapped so that a tracking failure (e.g. schema drift
    on a not-yet-migrated database) never blocks the redirect itself —
    sending the user to the right page is the contract of this endpoint;
    analytics are a bonus.
    """
    try:
        result = await session.execute(
            select(LinkClick).where(LinkClick.short_code == short_code)
        )
        link = result.scalar_one_or_none()
    except Exception:
        logger.exception("redirect: lookup failed for short_code=%s", short_code)
        return RedirectResponse(url="/", status_code=302)

    if not link:
        return RedirectResponse(url="/", status_code=302)

    destination = link.tracked_url or link.original_url
    if not destination:
        return RedirectResponse(url="/", status_code=302)

    # Best-effort click recording. Any failure (missing column, bad UA
    # string, etc.) is swallowed after rolling back so the response below
    # still goes out.
    try:
        ip_address = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
        if not ip_address:
            ip_address = request.client.host if request.client else None
        user_agent = request.headers.get("User-Agent")
        referrer = request.headers.get("Referer")

        event = await utm_service.record_click_event(
            link=link,
            ip_address=ip_address,
            user_agent_str=user_agent,
            referrer=referrer,
            session=session,
        )

        if ip_address:
            background_tasks.add_task(
                utm_service.resolve_geo_for_event, event.id, ip_address,
            )
    except Exception:
        logger.exception("redirect: click tracking failed for short_code=%s", short_code)
        try:
            await session.rollback()
        except Exception:
            logger.exception("redirect: rollback after tracking failure also failed")

    return RedirectResponse(url=destination, status_code=302)
