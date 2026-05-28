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

    The click counter increment and the ``click_events`` row insert are
    performed against independent sessions so a failure in one (e.g. a
    legacy DB missing a column on ``click_events``) cannot prevent the
    other from committing. The redirect itself always returns 302 — sending
    the user to the right page is the contract of this endpoint; analytics
    are a bonus.
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

    ip_address = request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
    if not ip_address:
        ip_address = request.client.host if request.client else None
    user_agent = request.headers.get("User-Agent")
    referrer = request.headers.get("Referer")
    link_id = link.id

    # Step 1: bump counters via a fresh session + raw UPDATE on link_clicks.
    # This commits independently of any click_events trouble, so analytics
    # (clicks / unique clicks) keep working even when the events table is
    # broken.
    try:
        await utm_service.bump_click_counter(link_id, ip_address)
    except Exception:
        logger.exception(
            "redirect: counter bump failed for short_code=%s link_id=%s",
            short_code, link_id,
        )

    # Step 2: best-effort event insert in its own session. Failures here
    # don't roll back the counter increment above.
    try:
        event_id = await utm_service.insert_click_event(
            link_id=link_id,
            ip_address=ip_address,
            user_agent_str=user_agent,
            referrer=referrer,
        )
        if event_id and ip_address:
            background_tasks.add_task(
                utm_service.resolve_geo_for_event, event_id, ip_address,
            )
    except Exception:
        logger.exception(
            "redirect: click event insert failed for short_code=%s link_id=%s",
            short_code, link_id,
        )

    return RedirectResponse(url=destination, status_code=302)
