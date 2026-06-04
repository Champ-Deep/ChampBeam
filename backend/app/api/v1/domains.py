"""Domain management endpoints, Bring-Your-Own-Domain for short links."""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import List, Optional
from uuid import UUID as _UUID

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.db.postgres import get_db_session
from app.models.domain import (
    Domain,
    STATUS_ACTIVE,
    STATUS_FAILED,
    STATUS_PENDING_CNAME,
    STATUS_PENDING_SSL,
)
from app.models.utm import LinkClick
from app.services import cloudflare

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/domains", tags=["Domains"])


# ============================================================================
# Schemas
# ============================================================================


class DomainCreate(BaseModel):
    hostname: str = Field(..., min_length=3, max_length=253)


class DomainResponse(BaseModel):
    id: str
    hostname: str
    status: str
    ssl_status: Optional[str] = None
    verification_errors: Optional[dict] = None
    is_primary: bool
    created_at: str
    verified_at: Optional[str] = None
    last_checked_at: Optional[str] = None
    # Setup instructions, included on every response so the UI can show them
    # for any domain still in pending_cname / pending_ssl.
    cname_target: Optional[str] = None
    cloudflare_managed: bool


# ============================================================================
# Helpers
# ============================================================================


# RFC-1035-ish: labels of 1-63 chars, alphanumeric + hyphen, no leading/trailing
# hyphen, separated by dots, total length <= 253. Allows internationalized
# domain names only in their punycode form (xn--…).
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$"
)


def _normalize_hostname(raw: str) -> str:
    h = (raw or "").strip().lower()
    # Strip a trailing dot users might type out of habit.
    if h.endswith("."):
        h = h[:-1]
    return h


def _validate_hostname(hostname: str) -> None:
    if not _HOSTNAME_RE.match(hostname):
        raise HTTPException(status_code=400, detail="Invalid hostname format.")
    if hostname == settings.resolved_platform_redirect_host:
        raise HTTPException(
            status_code=400,
            detail="This hostname is reserved by the platform.",
        )
    # Reject things like "localhost" or single-label hosts that crept through.
    if "." not in hostname:
        raise HTTPException(status_code=400, detail="Hostname must include a domain.")


def _is_platform_subdomain(hostname: str) -> bool:
    """True when hostname is a single-label subdomain of the platform's wildcard
    base (for example acme.deependhq.com when the base is deependhq.com). Those
    are covered by the platform wildcard DNS + cert, so they need no per-host
    certificate provisioning (the Netlify-style path)."""
    base = (settings.platform_subdomain_base or "").lower().strip().lstrip(".")
    if not base:
        return False
    suffix = "." + base
    if hostname == base or not hostname.endswith(suffix):
        return False
    label = hostname[: -len(suffix)]
    return bool(label) and "." not in label


def _to_response(domain: Domain) -> DomainResponse:
    return DomainResponse(
        id=str(domain.id),
        hostname=domain.hostname,
        status=domain.status,
        ssl_status=domain.ssl_status,
        verification_errors=domain.verification_errors,
        is_primary=bool(domain.is_primary),
        created_at=domain.created_at.isoformat() if domain.created_at else "",
        verified_at=domain.verified_at.isoformat() if domain.verified_at else None,
        last_checked_at=domain.last_checked_at.isoformat() if domain.last_checked_at else None,
        cname_target=settings.cloudflare_cname_target or None,
        cloudflare_managed=bool(domain.cf_custom_hostname_id),
    )


async def _get_owned_domain(
    domain_id: str, user_id: str, session: AsyncSession
) -> Domain:
    try:
        uid = _UUID(domain_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid domain ID.")
    result = await session.execute(
        select(Domain).where(Domain.id == uid, Domain.user_id == user_id)
    )
    domain = result.scalar_one_or_none()
    if not domain:
        raise HTTPException(status_code=404, detail="Domain not found.")
    return domain


async def _apply_cf_status(domain: Domain) -> None:
    """Mutate ``domain`` in place with the latest status from Cloudflare.

    Best-effort: a CF failure leaves the existing local status untouched but
    records the error on ``verification_errors`` so the UI can surface it.
    """
    if not domain.cf_custom_hostname_id:
        return
    try:
        result = await cloudflare.get_custom_hostname(domain.cf_custom_hostname_id)
    except cloudflare.CloudflareNotConfigured:
        return
    except cloudflare.CloudflareError as exc:
        domain.verification_errors = {"message": str(exc)}
        domain.last_checked_at = datetime.utcnow()
        return

    new_status, ssl_status = cloudflare.derive_status(result)
    domain.status = new_status
    domain.ssl_status = ssl_status
    domain.verification_errors = None if new_status != STATUS_FAILED else {"cf": result}
    domain.last_checked_at = datetime.utcnow()
    if new_status == STATUS_ACTIVE and domain.verified_at is None:
        domain.verified_at = datetime.utcnow()


async def _verify_reachable(hostname: str) -> bool:
    """Best-effort live check that the hostname actually routes to this backend.

    Fetches https://<hostname>/health and confirms our health signature. Used so
    a domain is not marked live until DNS points here and a valid cert exists.
    """
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.get(
                f"https://{hostname}/health",
                headers={"User-Agent": "ChampUTM-DomainVerify"},
            )
    except Exception:
        return False
    if resp.status_code != 200:
        return False
    try:
        return (resp.json() or {}).get("status") == "healthy"
    except Exception:
        return False


async def _apply_local_status(domain: Domain) -> None:
    """Resolve status for non-Cloudflare domains. A platform subdomain is live
    immediately (the wildcard DNS + cert cover it); any other custom domain is
    only marked active once a live reachability check confirms it routes here."""
    domain.last_checked_at = datetime.utcnow()
    if _is_platform_subdomain(domain.hostname):
        domain.status = STATUS_ACTIVE
        domain.ssl_status = "active"
        if domain.verified_at is None:
            domain.verified_at = datetime.utcnow()
        domain.verification_errors = None
        return
    if await _verify_reachable(domain.hostname):
        domain.status = STATUS_ACTIVE
        domain.ssl_status = "active"
        if domain.verified_at is None:
            domain.verified_at = datetime.utcnow()
        domain.verification_errors = None
    else:
        domain.status = STATUS_PENDING_CNAME
        domain.verification_errors = {
            "message": "Not reachable yet. Add the CNAME record, wait for DNS and the certificate to finish, then refresh."
        }


# ============================================================================
# Endpoints
# ============================================================================


@router.get("", response_model=List[DomainResponse])
async def list_domains(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List the authenticated user's custom domains."""
    result = await session.execute(
        select(Domain).where(Domain.user_id == user.user_id).order_by(Domain.created_at.desc())
    )
    return [_to_response(d) for d in result.scalars().all()]


@router.get("/config")
async def domains_config(user: TokenData = Depends(require_auth)):
    """Which custom-domain modes the deployment offers, for the Settings UI."""
    base = (settings.platform_subdomain_base or "").strip().lstrip(".")
    return {
        "subdomain_enabled": bool(base),
        "platform_subdomain_base": base or None,
        "byod_enabled": settings.cloudflare_configured,
        "cname_target": settings.cloudflare_cname_target or None,
    }


@router.post("", response_model=DomainResponse, status_code=201)
async def create_domain(
    data: DomainCreate,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Add a custom hostname. Provisions a CF Custom Hostname when configured."""
    hostname = _normalize_hostname(data.hostname)
    _validate_hostname(hostname)

    # Global hostname uniqueness, a domain can only be owned by one account.
    existing = await session.execute(
        select(Domain).where(Domain.hostname == hostname)
    )
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="This hostname is already registered.")

    cf_id: str | None = None
    status = STATUS_PENDING_CNAME
    ssl_status: str | None = None

    if _is_platform_subdomain(hostname):
        # Netlify-style: a subdomain of our own wildcard zone. The platform
        # wildcard DNS + cert already cover it, so mark it active with no
        # per-host provisioning.
        status = STATUS_ACTIVE
        ssl_status = "active"
    elif settings.cloudflare_configured:
        try:
            result = await cloudflare.create_custom_hostname(hostname)
            cf_id = result.get("id")
            status, ssl_status = cloudflare.derive_status(result)
        except cloudflare.CloudflareError as exc:
            logger.exception("CF create_custom_hostname failed for %s", hostname)
            raise HTTPException(status_code=502, detail=f"Cloudflare error: {exc}")
    else:
        # External custom domain with no Cloudflare for SaaS configured. Do NOT
        # mark it active: it is not reachable until DNS points here and a cert is
        # issued. Keep it pending and let Refresh verify real reachability, so the
        # UI never shows a domain as live when it would not actually connect.
        status = STATUS_PENDING_CNAME

    # First domain becomes primary automatically.
    has_any = await session.execute(
        select(func.count(Domain.id)).where(Domain.user_id == user.user_id)
    )
    is_first = (has_any.scalar() or 0) == 0

    now = datetime.utcnow()
    domain = Domain(
        user_id=user.user_id,
        hostname=hostname,
        status=status,
        ssl_status=ssl_status,
        cf_custom_hostname_id=cf_id,
        is_primary=is_first,
        created_at=now,
        verified_at=now if status == STATUS_ACTIVE else None,
        last_checked_at=now if cf_id else None,
    )
    session.add(domain)
    await session.commit()
    await session.refresh(domain)
    return _to_response(domain)


@router.post("/{domain_id}/refresh", response_model=DomainResponse)
async def refresh_domain(
    domain_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Re-poll Cloudflare for the latest status of this domain."""
    domain = await _get_owned_domain(domain_id, user.user_id, session)
    if domain.cf_custom_hostname_id:
        await _apply_cf_status(domain)
    else:
        await _apply_local_status(domain)
    await session.commit()
    await session.refresh(domain)
    return _to_response(domain)


@router.post("/{domain_id}/set-primary", response_model=DomainResponse)
async def set_primary(
    domain_id: str,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Mark this domain as the user's primary (used as default for new links)."""
    domain = await _get_owned_domain(domain_id, user.user_id, session)
    if domain.status != STATUS_ACTIVE:
        raise HTTPException(
            status_code=400,
            detail="Only active domains can be set as primary.",
        )
    await session.execute(
        update(Domain).where(Domain.user_id == user.user_id).values(is_primary=False)
    )
    domain.is_primary = True
    await session.commit()
    await session.refresh(domain)
    return _to_response(domain)


@router.get("/health")
async def domains_health(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Diagnostic snapshot of the user's domains and CF provisioning state.

    For each non-active domain, re-polls Cloudflare so a stuck row can be
    diagnosed without having to refresh each one in the UI. The CF env vars
    (``CLOUDFLARE_API_TOKEN``, ``CLOUDFLARE_ZONE_ID``, ``CLOUDFLARE_CNAME_TARGET``)
    must all be set on the deployment for this to do useful work; otherwise
    each row reports ``cf_status: 'not_configured'``.
    """
    cf_configured = settings.cloudflare_configured

    result = await session.execute(
        select(Domain).where(Domain.user_id == user.user_id).order_by(Domain.created_at.desc())
    )
    rows = result.scalars().all()

    items: list[dict] = []
    for d in rows:
        item: dict = {
            "id": str(d.id),
            "hostname": d.hostname,
            "status": d.status,
            "is_primary": bool(d.is_primary),
            "cf_managed": bool(d.cf_custom_hostname_id),
            "ssl_status": d.ssl_status,
            "verification_errors": d.verification_errors,
        }
        if d.status != STATUS_ACTIVE and d.cf_custom_hostname_id and cf_configured:
            try:
                cf = await cloudflare.get_custom_hostname(d.cf_custom_hostname_id)
                item["cf_status"] = cf.get("status")
                item["cf_ssl"] = (cf.get("ssl") or {}).get("status")
            except cloudflare.CloudflareError as exc:
                item["cf_status"] = "error"
                item["cf_error"] = str(exc)
        elif not cf_configured:
            item["cf_status"] = "not_configured"
        items.append(item)

    return {
        "cloudflare_configured": cf_configured,
        "cname_target": settings.cloudflare_cname_target or None,
        "domains": items,
    }


@router.delete("/{domain_id}", status_code=204)
async def delete_domain(
    domain_id: str,
    force: bool = Query(False, description="Delete even if links reference this domain."),
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a domain. Refuses if links still reference it unless ``force=true``."""
    domain = await _get_owned_domain(domain_id, user.user_id, session)

    if not force:
        link_count = await session.execute(
            select(func.count(LinkClick.id)).where(LinkClick.domain_id == domain.id)
        )
        count = link_count.scalar() or 0
        if count > 0:
            raise HTTPException(
                status_code=409,
                detail=f"{count} link(s) still use this domain. Pass force=true to delete anyway.",
            )

    if domain.cf_custom_hostname_id:
        try:
            await cloudflare.delete_custom_hostname(domain.cf_custom_hostname_id)
        except cloudflare.CloudflareNotConfigured:
            pass
        except cloudflare.CloudflareError as exc:
            logger.warning("CF delete_custom_hostname failed for %s: %s", domain.hostname, exc)
            # Continue with local delete, CF cleanup can be done manually.

    await session.delete(domain)
    await session.commit()
