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

import asyncio
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from sqlalchemy import delete as sql_delete, select
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
from app.models.favorite import Favorite
from app.services import content_service, org_service
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
    session: AsyncSession = Depends(get_db_session),
):
    """List published ChampVault assets (BD-facing → published only).

    Each asset is annotated with ``favorited`` for the caller so the library can
    render the star state without a second round-trip.
    """
    try:
        assets = await _client().list_assets(
            type=type, tag=tag, q=q, collection=collection, status="published"
        )
    except (ChampVaultNotConfigured, ChampVaultError) as exc:
        raise _unavailable(exc)
    fav_ids = await _favorite_ids(session, user.user_id, [a.id for a in assets])
    out = []
    for a in assets:
        d = a.to_dict()
        d["favorited"] = a.id in fav_ids
        out.append(d)
    return out


async def _favorite_ids(session: AsyncSession, user_id: str, asset_ids: list[str]) -> set[str]:
    """Which of ``asset_ids`` the user has favorited (empty set if none given)."""
    if not asset_ids:
        return set()
    rows = (await session.execute(
        select(Favorite.champvault_asset_id).where(
            Favorite.user_id == user_id,
            Favorite.champvault_asset_id.in_(asset_ids),
        )
    )).scalars().all()
    return set(rows)


@router.get("/favorites")
async def list_favorites(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """The caller's favorited assets (newest first) resolved to full details.

    This is the My Favorites shelf — it works regardless of the current search.
    Assets that no longer resolve (deleted/unpublished on the ChampVault side)
    are skipped so a stale favorite never breaks the shelf; an unconfigured hub
    returns 503 like the rest of the ChampVault endpoints.
    """
    asset_ids = (await session.execute(
        select(Favorite.champvault_asset_id)
        .where(Favorite.user_id == user.user_id)
        .order_by(Favorite.created_at.desc())
    )).scalars().all()
    if not asset_ids:
        return []

    client = _client()

    async def _resolve(aid: str):
        # ChampVaultNotConfigured propagates (whole hub is down/misconfigured);
        # a per-asset ChampVaultError just drops that one favorite.
        try:
            return await client.get_asset(aid)
        except ChampVaultError:
            return None

    try:
        resolved = await asyncio.gather(*[_resolve(aid) for aid in asset_ids])
    except ChampVaultNotConfigured as exc:
        raise _unavailable(exc)

    out = []
    for asset in resolved:
        if asset is None:
            continue
        d = asset.to_dict()
        d["favorited"] = True
        out.append(d)
    return out


@router.put("/assets/{asset_id}/favorite", status_code=204)
async def add_favorite(
    asset_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Favorite an asset (idempotent — favoriting twice is a no-op)."""
    exists = (await session.execute(
        select(Favorite.id).where(
            Favorite.user_id == user.user_id,
            Favorite.champvault_asset_id == asset_id,
        )
    )).scalar_one_or_none()
    if exists is None:
        session.add(Favorite(user_id=user.user_id, champvault_asset_id=asset_id))
        await session.commit()


@router.delete("/assets/{asset_id}/favorite", status_code=204)
async def remove_favorite(
    asset_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Un-favorite an asset (idempotent)."""
    await session.execute(
        sql_delete(Favorite).where(
            Favorite.user_id == user.user_id,
            Favorite.champvault_asset_id == asset_id,
        )
    )
    await session.commit()


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

    # Org members: route the send through a shadow Content + ContentShare so it
    # rolls up in the org's team analytics like any other library sendout. Signed
    # -in-without-an-org (personal) users get a plain tracked beam (below).
    if user.org_id:
        return await _beam_for_org(client, user, session, asset_id, target, delivered, data.domain_id)

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


async def _beam_for_org(
    client: ChampVault,
    user: TokenData,
    session: AsyncSession,
    asset_id: str,
    target: str,
    delivered: dict,
    domain_id: Optional[str],
) -> dict:
    """Org-scoped beam: upsert the org's shadow Content for the asset, then mint
    the member's tracked share of it (idempotent per member+domain)."""
    org_uuid = await org_service.resolve_org_uuid(session, user.org_id)
    if org_uuid is None:
        raise HTTPException(status_code=409, detail="Organization is not provisioned yet. Retry shortly.")

    content = await content_service.get_champvault_content(session, org_uuid, asset_id)
    if content is None:
        # First send of this asset in the org: fetch its details for a human title.
        try:
            asset = await client.get_asset(asset_id)
        except (ChampVaultNotConfigured, ChampVaultError) as exc:
            raise _unavailable(exc)
        content = await content_service.get_or_create_champvault_content(
            session, org_uuid, asset_id,
            title=asset.title, description=asset.description,
            created_by_user_id=user.user_id,
        )

    share, beam_url = await content_service.mint_share(
        session, content, user.user_id, domain_id, champvault_delivery_url=target
    )
    await session.commit()
    return {
        "asset_id": asset_id,
        "content_id": str(content.id),
        "link_id": str(share.link_id) if share.link_id else None,
        "beam_url": beam_url,
        "kind": delivered.get("kind"),
        "expires_at": delivered.get("expiresAt"),
    }
