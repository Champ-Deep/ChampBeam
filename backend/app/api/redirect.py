"""Redirect endpoint for tracked short links."""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, Form, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import access_control as ac
from app.api.access_pages import blocked_page, email_gate_page
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

    ip_address = ac.client_ip(request)
    # Branded pages carry the sender's custom domain when they have one.
    brand = domain.hostname if (link.branded and domain) else None

    # --- Access gates (before counting a view) ---------------------------
    # 1. Email gate: capture a lead before granting access.
    if link.require_email and not ac.has_gate_cookie(request, short_code):
        return email_gate_page(action=f"/r/{short_code}/unlock", brand=brand)
    # 2. VPN/proxy block.
    if link.block_vpn and await ac.is_vpn_ip(ip_address):
        return blocked_page("vpn", brand=brand)
    # 3. In-memory self-destruct checks on the already-loaded row — enforced even
    #    if the DB counter write below fails (the redirect must survive tracking
    #    outages, but revoked/expired links must still be blocked).
    now = datetime.utcnow()
    if link.revoked_at is not None:
        return blocked_page("revoked", brand=brand)
    if link.expires_at is not None and link.expires_at <= now:
        return blocked_page("expired", brand=brand)
    # 4. Atomic view cap + count. Tolerate a DB/tracking failure by failing open
    #    (the cap needs the DB; revoke/expiry above are already enforced).
    try:
        status = await utm_service.consume_link_view(link.id, ip_address)
    except Exception:
        logger.exception("redirect: view gate failed for short_code=%s", short_code)
        status = "ok"
    if status != "ok":
        return blocked_page(status, brand=brand)

    destination = await _resolve_destination(link)
    if not destination:
        return RedirectResponse(url="/", status_code=302)

    user_agent = request.headers.get("User-Agent")
    referrer = request.headers.get("Referer")
    link_id = link.id

    # Best-effort event insert in its own session (the view was already counted
    # atomically by consume_link_view above).
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


@router.post("/r/{short_code}/unlock")
async def unlock_link(
    short_code: str,
    request: Request,
    email: str = Form(default=""),
    session: AsyncSession = Depends(get_db_session),
):
    """Email-gate submit: capture the lead, set the gate cookie, re-enter /r."""
    host = _request_host(request)
    domain = await _resolve_domain(host, session)
    stmt = select(LinkClick).where(LinkClick.short_code == short_code)
    stmt = stmt.where(LinkClick.domain_id.is_(None)) if domain is None else stmt.where(
        LinkClick.domain_id == domain.id
    )
    link = (await session.execute(stmt)).scalar_one_or_none()
    if not link:
        return RedirectResponse(url="/", status_code=302)

    brand = domain.hostname if (link.branded and domain) else None
    if not ac.valid_email(email):
        return email_gate_page(action=f"/r/{short_code}/unlock", brand=brand, error=True)

    await ac.capture_lead(session, email, ip=ac.client_ip(request), link_id=link.id)
    await session.commit()

    resp = RedirectResponse(url=f"/r/{short_code}", status_code=303)
    resp.set_cookie(
        ac.gate_cookie_name(short_code), "1",
        max_age=60 * 60 * 24 * 30, httponly=True, samesite="lax",
    )
    return resp
