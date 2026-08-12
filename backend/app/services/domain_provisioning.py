"""Self-serve BYOD provisioning for the self-hosted (non-Cloudflare) path.

Lifecycle: pending_cname --(DNS resolves to PLATFORM_IPV4)--> pending_ssl
--(host-side provisioner issues vhost+cert, /health reachable)--> active.
Three failed provisioning attempts park the domain in `failed` with the error
surfaced on verification_errors.

The actual nginx/certbot work happens OUTSIDE the container: a systemd timer on
the VPS (deploy/provisioner/) polls the internal provisioning API for domains
in pending_ssl and reports results back. This module supplies the DNS
pre-check, the shared status logic, and a background loop that advances
domains without the user having to click Refresh.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

import httpx
from sqlalchemy import select

from app.core.config import settings
from app.models.domain import (
    Domain,
    STATUS_ACTIVE,
    STATUS_PENDING_CNAME,
    STATUS_PENDING_SSL,
)

logger = logging.getLogger(__name__)

MAX_PROVISION_ATTEMPTS = 3
PROVISION_LOOP_INTERVAL_SECONDS = 60
# Stop auto-polling DNS for domains the user abandoned (they can still Refresh).
AUTO_POLL_MAX_AGE = timedelta(days=7)

CNAME_INSTRUCTIONS = (
    "Not reachable yet. Add the CNAME record, wait for DNS to propagate, then "
    "refresh (or just wait — we re-check every minute)."
)
PROVISIONING_MESSAGE = (
    "DNS verified. Issuing your SSL certificate — usually under 2 minutes."
)


def is_platform_subdomain(hostname: str) -> bool:
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


async def verify_reachable(hostname: str) -> bool:
    """Best-effort live check that the hostname actually routes to this backend.

    Fetches https://<hostname>/health and confirms our health signature. Used so
    a domain is not marked live until DNS points here and a valid cert exists.
    """
    try:
        async with httpx.AsyncClient(timeout=6.0, follow_redirects=True) as client:
            resp = await client.get(
                f"https://{hostname}/health",
                headers={"User-Agent": "Champbeam-DomainVerify"},
            )
    except Exception:
        return False
    if resp.status_code != 200:
        return False
    try:
        return (resp.json() or {}).get("status") == "healthy"
    except Exception:
        return False


async def dns_points_here(hostname: str) -> bool:
    """True when the hostname's A resolution (following CNAMEs) includes the
    platform's IPv4. Queried against public resolvers for a customer's-eye view
    rather than whatever resolver/caches the container happens to have."""
    if not settings.platform_ipv4:
        return False
    try:
        import dns.asyncresolver

        resolver = dns.asyncresolver.Resolver(configure=False)
        resolver.nameservers = ["1.1.1.1", "8.8.8.8"]
        resolver.lifetime = 5.0
        answer = await resolver.resolve(hostname, "A")
        return settings.platform_ipv4 in {rr.address for rr in answer}
    except Exception:
        return False


async def apply_local_status(domain: Domain) -> None:
    """Resolve status for non-Cloudflare domains (mutates ``domain`` in place).

    Platform subdomains are live immediately (wildcard DNS + cert cover them).
    Other domains advance pending_cname -> pending_ssl once their DNS points at
    the platform, and only turn active once reachable over valid HTTPS.
    """
    domain.last_checked_at = datetime.utcnow()
    if is_platform_subdomain(domain.hostname):
        domain.status = STATUS_ACTIVE
        domain.ssl_status = "active"
        if domain.verified_at is None:
            domain.verified_at = datetime.utcnow()
        domain.verification_errors = None
        return
    if await verify_reachable(domain.hostname):
        domain.status = STATUS_ACTIVE
        domain.ssl_status = "active"
        if domain.verified_at is None:
            domain.verified_at = datetime.utcnow()
        domain.verification_errors = None
        return
    if settings.local_byod_enabled and await dns_points_here(domain.hostname):
        domain.status = STATUS_PENDING_SSL
        domain.ssl_status = "provisioning"
        if domain.provision_requested_at is None:
            domain.provision_requested_at = datetime.utcnow()
        domain.verification_errors = {"message": PROVISIONING_MESSAGE}
        return
    domain.status = STATUS_PENDING_CNAME
    domain.verification_errors = {"message": CNAME_INSTRUCTIONS}


async def _sweep_once() -> None:
    from app.db.postgres import async_session_maker

    cutoff = datetime.utcnow() - AUTO_POLL_MAX_AGE
    async with async_session_maker() as session:
        result = await session.execute(
            select(Domain).where(
                Domain.status.in_([STATUS_PENDING_CNAME, STATUS_PENDING_SSL]),
                Domain.cf_custom_hostname_id.is_(None),
                Domain.created_at >= cutoff,
            )
        )
        domains = result.scalars().all()
        for domain in domains:
            previous = domain.status
            await apply_local_status(domain)
            if domain.status != previous:
                logger.info(
                    "domain %s advanced %s -> %s", domain.hostname, previous, domain.status
                )
        if domains:
            await session.commit()


async def domain_provision_loop() -> None:
    """Background task: auto-advance pending BYOD domains every minute so the
    customer flow is add domain -> point DNS -> wait, with no manual refresh."""
    if not settings.local_byod_enabled:
        logger.info("domain provision loop disabled (PLATFORM_IPV4/BYOD_CNAME_TARGET unset)")
        return
    logger.info(
        "domain provision loop started (interval=%ss)", PROVISION_LOOP_INTERVAL_SECONDS
    )
    while True:
        try:
            await asyncio.sleep(PROVISION_LOOP_INTERVAL_SECONDS)
            await _sweep_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("domain provision loop iteration failed")
