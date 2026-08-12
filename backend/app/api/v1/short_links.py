"""Short links redirect endpoint for Champbeam.

``/s/{code}`` (the path used by the ``short_url`` field) is a full alias of
``/r/{code}``: same Host-scoped lookup, same access gates (email gate, VPN
block, revoke/expiry/view caps) and the same rich click-event recording with
geo enrichment. It was historically a "light" endpoint that only bumped an
aggregate counter — which both starved analytics for links shared via
``short_url`` and skipped the access controls entirely, so the two paths were
unified.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.redirect import redirect_link
from app.db.postgres import get_db_session

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ShortLinks"])


@router.get("/s/{short_code}")
async def redirect_short_link(
    short_code: str,
    request: Request,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db_session),
):
    """Redirect a short code to its tracked URL, scoped by Host header."""
    return await redirect_link(short_code, request, background_tasks, session)
