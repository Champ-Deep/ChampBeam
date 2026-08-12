"""Internal API for the host-side BYOD provisioner.

Consumed only by deploy/provisioner/champbeam-provisioner.sh, which runs on the
VPS host (where nginx + certbot live), polls for domains awaiting a vhost +
certificate, runs the provisioning script, and reports back.

Auth is a shared secret (X-Provisioner-Token) compared in constant time; the
routes 404 when the token is unconfigured so the surface simply doesn't exist
on deployments that don't use the self-hosted path.

Abuse gate: only domains a user registered (hostname-validated, platform hosts
rejected at create) that ALSO passed the DNS pre-check (resolution reaches
this platform's IP) ever appear in the work list, and each domain gets at most
MAX_PROVISION_ATTEMPTS certificate attempts — the daemon can never be steered
into issuing certs for arbitrary hostnames.
"""

from __future__ import annotations

import hmac
import logging
from datetime import datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.db.postgres import get_db_session
from app.models.domain import (
    Domain,
    STATUS_ACTIVE,
    STATUS_FAILED,
    STATUS_PENDING_SSL,
)
from app.services import domain_provisioning

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/internal/provisioning", tags=["Internal"], include_in_schema=False)


def _require_provisioner_token(
    x_provisioner_token: Optional[str] = Header(default=None, alias="X-Provisioner-Token"),
) -> None:
    configured = settings.provisioner_token
    if not configured:
        raise HTTPException(status_code=404, detail="Not found")
    if not x_provisioner_token or not hmac.compare_digest(x_provisioner_token, configured):
        raise HTTPException(status_code=401, detail="Invalid provisioner token")


class ProvisionJob(BaseModel):
    id: str
    hostname: str
    attempts: int


class ProvisionResult(BaseModel):
    ok: bool
    error: Optional[str] = None


@router.get("/domains", response_model=List[ProvisionJob])
async def list_pending_domains(
    _: None = Depends(_require_provisioner_token),
    session: AsyncSession = Depends(get_db_session),
):
    """Domains awaiting a vhost + certificate on the host."""
    result = await session.execute(
        select(Domain).where(
            Domain.status == STATUS_PENDING_SSL,
            Domain.cf_custom_hostname_id.is_(None),
            Domain.provision_attempts < domain_provisioning.MAX_PROVISION_ATTEMPTS,
        )
    )
    return [
        ProvisionJob(id=str(d.id), hostname=d.hostname, attempts=d.provision_attempts or 0)
        for d in result.scalars().all()
    ]


@router.post("/domains/{domain_id}/result")
async def report_provision_result(
    domain_id: str,
    data: ProvisionResult,
    _: None = Depends(_require_provisioner_token),
    session: AsyncSession = Depends(get_db_session),
):
    try:
        uid = UUID(domain_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid domain ID")
    result = await session.execute(select(Domain).where(Domain.id == uid))
    domain = result.scalar_one_or_none()
    if domain is None:
        raise HTTPException(status_code=404, detail="Domain not found")

    domain.provision_attempts = (domain.provision_attempts or 0) + 1
    domain.last_checked_at = datetime.utcnow()

    if data.ok and await domain_provisioning.verify_reachable(domain.hostname):
        domain.status = STATUS_ACTIVE
        domain.ssl_status = "active"
        if domain.verified_at is None:
            domain.verified_at = datetime.utcnow()
        domain.verification_errors = None
        logger.info("domain %s provisioned and live", domain.hostname)
    elif data.ok:
        # Cert issued but not reachable yet (e.g. propagation); stay pending and
        # let the provision loop's re-verify flip it, up to the attempt cap.
        domain.verification_errors = {
            "message": "Certificate issued; waiting for the hostname to become reachable."
        }
        logger.info("domain %s provisioned but not yet reachable", domain.hostname)
    else:
        domain.verification_errors = {
            "message": f"Certificate provisioning failed: {data.error or 'unknown error'}"
        }
        logger.warning(
            "domain %s provisioning failed (attempt %d): %s",
            domain.hostname,
            domain.provision_attempts,
            data.error,
        )

    if (
        domain.status == STATUS_PENDING_SSL
        and domain.provision_attempts >= domain_provisioning.MAX_PROVISION_ATTEMPTS
    ):
        domain.status = STATUS_FAILED

    await session.commit()
    return {"status": domain.status, "attempts": domain.provision_attempts}
