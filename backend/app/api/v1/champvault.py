"""ChampVault content-hub endpoints.

BD-facing: browse the external ChampVault library and "beam" an asset — which
mints a tracked ChampBeam short link wrapping a fresh delivery URL. ChampBeam
stores only the link + telemetry, never the bytes. The link is recorded with the
asset id so the redirect handler re-mints a fresh delivery URL on each open
(perpetual beams; delivery URLs themselves expire).

Distinct from /content — that is the org's *internal* shared library. This is
the external asset hub.
"""

from __future__ import annotations

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.db.postgres import get_db_session
from app.integrations.champvault_client import (
    ChampVault,
    ChampVaultError,
    ChampVaultNotConfigured,
    delivery_target,
)
from app.services import content_service
from app.services.utm_service import utm_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/champvault", tags=["ChampVault"])


class BeamRequest(BaseModel):
    expires_in_days: int = Field(default=7, ge=1, le=30)
    domain_id: Optional[str] = None


def _client() -> ChampVault:
    return ChampVault()


def _unavailable(exc: Exception) -> HTTPException:
    if isinstance(exc, ChampVaultNotConfigured):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=502, detail=f"ChampVault error: {exc}")


@router.get("/config")
async def champvault_config(user: TokenData = Depends(require_auth)):
    """Whether this deployment is wired to a ChampVault hub (for UI gating)."""
    return {"configured": settings.champvault_configured}


@router.get("/assets")
async def list_assets(
    type: Optional[str] = None,
    tag: Optional[str] = None,
    q: Optional[str] = None,
    collection: Optional[str] = None,
    user: TokenData = Depends(require_auth),
):
    """List published ChampVault assets (BD-facing → published only)."""
    try:
        assets = await _client().list_assets(
            type=type, tag=tag, q=q, collection=collection, status="published"
        )
    except (ChampVaultNotConfigured, ChampVaultError) as exc:
        raise _unavailable(exc)
    return [a.to_dict() for a in assets]


@router.get("/collections")
async def list_collections(user: TokenData = Depends(require_auth)):
    try:
        return await _client().list_collections()
    except (ChampVaultNotConfigured, ChampVaultError) as exc:
        raise _unavailable(exc)


@router.get("/assets/{asset_id}")
async def get_asset(asset_id: str, user: TokenData = Depends(require_auth)):
    try:
        return (await _client().get_asset(asset_id)).to_dict()
    except (ChampVaultNotConfigured, ChampVaultError) as exc:
        raise _unavailable(exc)


@router.post("/assets/{asset_id}/beam", status_code=201)
async def beam_asset(
    asset_id: str,
    data: BeamRequest,
    request: Request,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Mint a tracked ChampBeam short link that wraps a ChampVault delivery URL.

    The link is owned by the caller (optionally on their own active domain) and
    stamped with the asset id, so opens are tracked here and the destination is
    re-minted fresh on each open (the delivery URL itself is short-lived).
    """
    client = _client()
    try:
        delivered = await client.deliver(asset_id, expires_in_s=data.expires_in_days * 86400)
    except (ChampVaultNotConfigured, ChampVaultError) as exc:
        raise _unavailable(exc)

    target = delivery_target(delivered)
    if not target:
        raise HTTPException(status_code=502, detail="ChampVault returned no delivery URL.")

    # Resolve the caller's chosen active domain (or platform default).
    domain = await content_service._resolve_member_domain(session, user.user_id, data.domain_id)
    domain_uuid = domain.id if domain else None
    hostname = domain.hostname if domain else content_service._platform_host()

    # One stable beam per (user, asset, domain): champvault://<id> is the dedup
    # key. Don't inject UTM into the signed delivery URL — tracking is via /r/.
    link = await utm_service.record_link(
        user_id=user.user_id,
        original_url=f"champvault://{asset_id}",
        tracked_url=target,
        utm_params={},
        domain_id=domain_uuid,
        session=session,
    )
    link.champvault_asset_id = asset_id
    link.tracked_url = target  # refresh the fallback URL
    await session.commit()
    await session.refresh(link)

    beam_url = content_service.build_share_url(link=link, file=None, hostname=hostname)
    return {
        "asset_id": asset_id,
        "link_id": str(link.id),
        "beam_url": beam_url,
        "kind": delivered.get("kind"),
        "expires_at": delivered.get("expiresAt"),
    }
