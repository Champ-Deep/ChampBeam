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
from app.core.timeutils import iso_utc
from app.db.postgres import get_db_session
from app.models.domain import (
    Domain,
    STATUS_ACTIVE,
    STATUS_FAILED,
    STATUS_PENDING_CNAME,
    STATUS_PENDING_SSL,
)
from app.models.utm import LinkClick
from app.services import cloudflare, cloudflare_registrar, domain_provisioning

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/domains", tags=["Domains"])


# ============================================================================
# Schemas
# ============================================================================


class DomainCreate(BaseModel):
    hostname: str = Field(..., min_length=3, max_length=253)


class DomainCheckRequest(BaseModel):
    domains: List[str] = Field(..., min_length=1, max_length=20)


class DomainSearchResult(BaseModel):
    name: str
    available: bool
    currency: Optional[str] = None
    registration_cost: Optional[str] = None
    renewal_cost: Optional[str] = None
    reason: Optional[str] = None


class DomainPurchaseRequest(BaseModel):
    # The domain to register, e.g. "acme.com".
    domain: str = Field(..., min_length=3, max_length=253)
    # The hostname to serve links from. Defaults to "track.<domain>". Must be the
    # domain itself or a subdomain of it.
    hostname: Optional[str] = None
    auto_renew: bool = False


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
    # Procurement metadata (NULL for bring-your-own-domain rows).
    procured: bool = False
    registrar: Optional[str] = None
    registration_status: Optional[str] = None
    auto_renew: bool = False
    registration_price: Optional[str] = None
    domain_expires_at: Optional[str] = None


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
    if settings.is_platform_host(hostname):
        raise HTTPException(
            status_code=400,
            detail="This hostname is reserved by the platform.",
        )
    # Reject things like "localhost" or single-label hosts that crept through.
    if "." not in hostname:
        raise HTTPException(status_code=400, detail="Hostname must include a domain.")


# Shared with the background provision loop (services/domain_provisioning).
_is_platform_subdomain = domain_provisioning.is_platform_subdomain


def _to_response(domain: Domain) -> DomainResponse:
    return DomainResponse(
        id=str(domain.id),
        hostname=domain.hostname,
        status=domain.status,
        ssl_status=domain.ssl_status,
        verification_errors=domain.verification_errors,
        is_primary=bool(domain.is_primary),
        created_at=iso_utc(domain.created_at) or "",
        verified_at=iso_utc(domain.verified_at),
        last_checked_at=iso_utc(domain.last_checked_at),
        cname_target=settings.cloudflare_cname_target or settings.byod_cname_target or None,
        cloudflare_managed=bool(domain.cf_custom_hostname_id),
        procured=domain.procured,
        registrar=domain.registrar,
        registration_status=domain.registration_status,
        auto_renew=bool(domain.auto_renew),
        registration_price=domain.registration_price,
        domain_expires_at=iso_utc(domain.domain_expires_at),
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


_verify_reachable = domain_provisioning.verify_reachable
_apply_local_status = domain_provisioning.apply_local_status


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
        "byod_enabled": settings.cloudflare_configured or settings.local_byod_enabled,
        "cname_target": settings.cloudflare_cname_target or settings.byod_cname_target or None,
        "procurement_enabled": settings.cloudflare_registrar_configured,
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


# ============================================================================
# Domain procurement (Cloudflare Registrar) — search, check, one-click buy
# ============================================================================


def _normalize_search_item(item: dict) -> DomainSearchResult:
    pricing = item.get("pricing") or {}
    return DomainSearchResult(
        name=item.get("name", ""),
        available=bool(item.get("registrable")),
        currency=pricing.get("currency"),
        registration_cost=pricing.get("registration_cost"),
        renewal_cost=pricing.get("renewal_cost"),
        reason=item.get("reason"),
    )


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


@router.get("/search", response_model=List[DomainSearchResult])
async def search_domains(
    q: str = Query(..., min_length=1, max_length=63, description="Keyword or name to search."),
    limit: int = Query(20, ge=1, le=40),
    user: TokenData = Depends(require_auth),
):
    """Suggest registrable domains for a keyword (Cloudflare Registrar)."""
    try:
        items = await cloudflare_registrar.search(q, limit)
    except cloudflare_registrar.RegistrarNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except cloudflare_registrar.RegistrarError as exc:
        raise HTTPException(status_code=502, detail=f"Registrar error: {exc}")
    return [_normalize_search_item(i) for i in items]


@router.post("/check", response_model=List[DomainSearchResult])
async def check_domains(
    data: DomainCheckRequest,
    user: TokenData = Depends(require_auth),
):
    """Check exact availability + price for specific domains."""
    names = [_normalize_hostname(d) for d in data.domains]
    try:
        items = await cloudflare_registrar.check(names)
    except cloudflare_registrar.RegistrarNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except cloudflare_registrar.RegistrarError as exc:
        raise HTTPException(status_code=502, detail=f"Registrar error: {exc}")
    return [_normalize_search_item(i) for i in items]


@router.post("/purchase", response_model=DomainResponse, status_code=201)
async def purchase_domain(
    data: DomainPurchaseRequest,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Register a domain and wire it up to serve links — the one-click path.

    Registers via Cloudflare Registrar, then best-effort provisions the link
    hostname: a Custom Hostname (cert) when Cloudflare-for-SaaS is configured,
    and a CNAME on the freshly created zone pointing at the platform target.
    Each wiring step degrades gracefully to a pending status with instructions
    rather than failing the purchase.
    """
    domain_name = _normalize_hostname(data.domain)
    _validate_hostname(domain_name)
    hostname = _normalize_hostname(data.hostname) if data.hostname else f"track.{domain_name}"
    _validate_hostname(hostname)
    if hostname != domain_name and not hostname.endswith("." + domain_name):
        raise HTTPException(status_code=400, detail="hostname must be the domain or a subdomain of it.")

    existing = await session.execute(select(Domain).where(Domain.hostname == hostname))
    if existing.scalar_one_or_none() is not None:
        raise HTTPException(status_code=409, detail="This hostname is already registered.")

    # 1) Register the domain (real money — only fires when configured).
    contacts = None
    if settings.cloudflare_registrant_email:
        contacts = {"registrant": {"email": settings.cloudflare_registrant_email}}
    try:
        result = await cloudflare_registrar.register(
            domain_name, auto_renew=data.auto_renew, contacts=contacts
        )
    except cloudflare_registrar.RegistrarNotConfigured as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except cloudflare_registrar.RegistrarError as exc:
        logger.exception("registrar register failed for %s", domain_name)
        raise HTTPException(status_code=502, detail=f"Registrar error: {exc}")

    reg_state = cloudflare_registrar.derive_registration_state(result)
    if reg_state in ("failed", "blocked"):
        raise HTTPException(status_code=502, detail=f"Registration {reg_state}.")
    reg_ctx = (result.get("context") or {}).get("registration") or {}

    # 2) Wire the link hostname (best-effort).
    cf_id: str | None = None
    status = STATUS_PENDING_CNAME
    ssl_status: str | None = None
    if settings.cloudflare_configured:
        try:
            ch = await cloudflare.create_custom_hostname(hostname)
            cf_id = ch.get("id")
            status, ssl_status = cloudflare.derive_status(ch)
        except cloudflare.CloudflareError:
            logger.warning("CF custom hostname wiring failed for %s", hostname, exc_info=True)

    if hostname != domain_name and settings.cloudflare_cname_target:
        try:
            zone_id = await cloudflare_registrar.find_zone_id(domain_name)
            if zone_id:
                await cloudflare_registrar.create_cname(
                    zone_id, hostname, settings.cloudflare_cname_target
                )
        except cloudflare_registrar.RegistrarError:
            logger.warning("CNAME auto-wire failed for %s", hostname, exc_info=True)

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
        registrar="cloudflare_registrar",
        registration_status=reg_ctx.get("status") or reg_state,
        auto_renew=bool(reg_ctx.get("auto_renew", data.auto_renew)),
        registration_price=str(reg_ctx.get("price")) if reg_ctx.get("price") is not None else None,
        domain_expires_at=_parse_dt(reg_ctx.get("expires_at")),
    )
    session.add(domain)
    await session.commit()
    await session.refresh(domain)
    return _to_response(domain)
