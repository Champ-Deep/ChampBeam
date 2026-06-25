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
    if not host or settings.is_platform_host(host):
        return None
    result = await session.execute(
        select(Domain).where(Domain.hostname == host, Domain.status == STATUS_ACTIVE)
    )
    return result.scalar_one_or_none()


async def _resolve_destination(link: LinkClick) -> str | None:
    """Where this link should send the visitor.

    For a ChampVault-backed beam, re-mint a fresh (short-lived) delivery URL on
    each open so the link never dies when a previously-minted URL expires; fall
    back to the last-known ``tracked_url`` if ChampVault is unreachable. The
    ``champvault://`` pseudo original_url is never a valid destination.
    """
    destination = link.tracked_url or link.original_url
    if link.champvault_asset_id:
        if settings.champvault_configured:
            try:
                from app.integrations.champvault_client import (
                    ChampVault,
                    ChampVaultError,
                    delivery_target,
                )

                delivered = await ChampVault(timeout=6.0).deliver(
                    link.champvault_asset_id, expires_in_s=3600
                )
                fresh = delivery_target(delivered)
                if fresh:
                    destination = fresh
            except Exception:
                logger.warning(
                    "champvault re-mint failed for asset=%s; using last-known URL",
                    link.champvault_asset_id,
                    exc_info=True,
                )
        if destination and destination.startswith("champvault://"):
            destination = None
    return destination


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

    if host and domain is None and not settings.is_platform_host(host):
        # Custom hostname that isn't registered or isn't active, refuse rather
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

    destination = await _resolve_destination(link)
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
            domain_id=domain.id if domain else None,
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
