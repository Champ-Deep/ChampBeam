"""Redirect endpoint for tracked short links."""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.postgres import get_db_session
from app.models.domain import Domain, STATUS_ACTIVE
from app.models.utm import LinkClick
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Redirect"])


def _request_host(request: Request) -> str:
    host = (request.headers.get("host") or "").lower()
    # Strip the port for matching against stored hostnames.
    return host.split(":", 1)[0]


async def _resolve_domain(host: str, session: AsyncSession) -> Optional[Domain]:
    """Return the Domain row whose ``hostname`` matches the incoming host.

    Returns None when the request arrived on the platform-default host (so the
    caller should query in the ``domain_id IS NULL`` bucket).
    """
    if not host or host == settings.resolved_platform_redirect_host:
        return None
    result = await session.execute(
        select(Domain).where(Domain.hostname == host, Domain.status == STATUS_ACTIVE)
    )
    return result.scalar_one_or_none()


@router.get("/r/{short_code}")
async def redirect_link(
    short_code: str,
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db_session),
):
    """Redirect a short code to its destination, recording the click.

    The Host header decides which short-code namespace to look in: the
    platform default uses ``domain_id IS NULL``; a custom hostname must
    resolve to an ``active`` Domain row and then look up by
    ``(domain_id, short_code)``.
    """
    host = _request_host(request)
    domain = await _resolve_domain(host, session)

    if host and domain is None and host != settings.resolved_platform_redirect_host:
        # Custom hostname that isn't registered or isn't active — refuse rather
        # than fall through to the platform-default bucket (which would leak
        # one tenant's link onto another tenant's domain).
        return RedirectResponse(url="/", status_code=302)

    stmt = select(LinkClick).where(LinkClick.short_code == short_code)
    if domain is None:
        stmt = stmt.where(LinkClick.domain_id.is_(None))
    else:
        stmt = stmt.where(LinkClick.domain_id == domain.id)

    result = await session.execute(stmt)
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
        domain_id=domain.id if domain else None,
    )

    # Resolve GeoIP in background so the redirect is fast
    if ip_address:
        background_tasks.add_task(
            utm_service.resolve_geo_for_event, event.id, ip_address,
        )

    destination = link.tracked_url or link.original_url
    return RedirectResponse(url=destination, status_code=302)
