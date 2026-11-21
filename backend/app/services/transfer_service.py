from __future__ import annotations

import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Optional
from uuid import UUID

from sqlalchemy import and_, case, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import access_control as ac
from app.core.config import settings
from app.models.file_asset import (
    STATUS_ACTIVE,
    STATUS_DELETED,
    STATUS_FAILED,
    STATUS_PENDING_UPLOAD,
    FileAsset,
)
from app.models.intranet import (
    ACTOR_AGENT,
    ACTOR_HUMAN,
    ACTOR_SYSTEM,
    EVENT_ACCESS_CODE_FAILED,
    EVENT_APPROVED,
    EVENT_CHECK_FAILED,
    EVENT_OVERTURNED,
    EVENT_REMINDER_SENT,
    EVENT_SCANNED,
    EVENT_WITHDRAWN,
    SCAN_INFECTED,
    STATE_CHECK_FAILED,
    STATE_SCANNING,
    STATE_WITHDRAWN,
    WITHDRAWABLE_STATES,
    EVENT_CONSUMED,
    EVENT_EXPIRED,
    EVENT_INVITE_EXPIRED,
    EVENT_OPENED_BY_RECIPIENT,
    EVENT_OPENED_FOR_REVIEW,
    EVENT_REJECTED,
    EVENT_RELEASED,
    EVENT_REVOKED,
    PENDING_STATES,
    REVOCABLE_STATES,
    STATE_CONSUMED,
    STATE_EXPIRED,
    STATE_IN_REVIEW,
    STATE_REJECTED,
    STATE_RELEASED,
    STATE_REVOKED,
    STATE_SUBMITTED,
    OrgInvite,
    OrgReviewSettings,
    Transfer,
)
from app.models.org import Organization, OrganizationMembership
from app.models.user import User
from app.services import decision_log, storage

logger = logging.getLogger(__name__)

SWEEPER_ACTOR = "sweeper"
ABANDONED_UPLOAD_SECONDS = 24 * 3600
INTRANET_KEY_PREFIX = "intranet/"


class TransferError(Exception):
    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


@dataclass
class DownloadClaim:
    transfer_id: UUID
    token: Optional[str]
    one_time: bool


async def get_review_settings(session: AsyncSession, organization_id: UUID) -> OrgReviewSettings:
    row = await session.get(OrgReviewSettings, organization_id)
    if row is None:
        row = OrgReviewSettings(organization_id=organization_id)
        session.add(row)
        await session.flush()
    return row


def hard_check_failures(filename: str, size_bytes: int) -> list[str]:
    failures: list[str] = []
    if size_bytes <= 0:
        failures.append("File is empty.")
    if size_bytes > settings.intranet_max_file_bytes:
        cap_mb = settings.intranet_max_file_bytes // (1024 * 1024)
        failures.append(f"File exceeds the {cap_mb} MB limit.")
    name = filename.lower().rstrip(". ")
    parts = name.split(".")[1:]
    blocked = settings.intranet_blocked_extension_set
    hits = sorted({p for p in parts if p in blocked})
    if hits:
        failures.append("Blocked file type: ." + ", .".join(hits))
    return failures


def effective_requested_days(transfer: Transfer, review: OrgReviewSettings) -> int:
    return transfer.requested_expires_in_days or review.default_expiry_days


async def _delete_blob_for(session: AsyncSession, file_id: UUID) -> Optional[str]:
    asset = await session.get(FileAsset, file_id)
    if asset is None or asset.status == STATUS_DELETED:
        return None
    asset.status = STATUS_DELETED
    return asset.storage_key


async def delete_blob(storage_key: Optional[str]) -> None:
    if not storage_key:
        return
    try:
        await storage.delete_object(storage_key)
    except storage.StorageError:
        logger.exception("intranet: blob delete failed for key=%s", storage_key)
    except storage.StorageNotConfigured:
        pass


async def _transition(
    session: AsyncSession, transfer: Transfer, from_states: tuple[str, ...], values: dict
) -> None:
    result = await session.execute(
        update(Transfer)
        .where(Transfer.id == transfer.id, Transfer.state.in_(from_states))
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.refresh(transfer)
        raise TransferError(f"Transfer is {transfer.state}; this action is no longer possible.", 409)
    await session.refresh(transfer)


async def open_for_review(session: AsyncSession, transfer: Transfer, reviewer_id: str) -> None:
    if transfer.state == STATE_SUBMITTED:
        await _transition(session, transfer, (STATE_SUBMITTED,), {"state": STATE_IN_REVIEW})
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_OPENED_FOR_REVIEW,
        actor_type=ACTOR_HUMAN,
        actor_id=reviewer_id,
    )


async def approve(
    session: AsyncSession,
    transfer: Transfer,
    reviewer_id: str,
    review: OrgReviewSettings,
    expires_in_days: Optional[int],
    one_time: Optional[bool],
    reason: Optional[str],
    actor_type: str = ACTOR_HUMAN,
    agent: Optional[dict] = None,
    access_code: Optional[str] = None,
) -> None:
    if str(transfer.submitter_user_id) == reviewer_id:
        raise TransferError("You cannot decide your own submission.", 403)
    allowed_days = effective_requested_days(transfer, review)
    days = allowed_days if expires_in_days is None else expires_in_days
    if days > allowed_days:
        raise TransferError(
            f"Expiry can only be tightened: the requested limit is {allowed_days} days.", 422
        )
    final_one_time = bool(transfer.requested_one_time or one_time)
    if transfer.requested_one_time and one_time is False:
        raise TransferError("One-time access was requested and cannot be loosened.", 422)
    code = (access_code or "").strip()
    if code and not ac.ACCESS_CODE_RE.match(code):
        raise TransferError("The access code must be 4 to 8 digits.", 422)
    now = datetime.utcnow()
    await _transition(
        session,
        transfer,
        PENDING_STATES,
        {
            "state": STATE_RELEASED,
            "decided_at": now,
            "decided_by_type": actor_type,
            "decided_by_id": reviewer_id,
            "released_at": now,
            "expires_at": now + timedelta(days=days),
            "one_time": final_one_time,
            "access_code_hash": ac.hash_access_code(transfer.id, code) if code else None,
            "access_code_attempts": 0,
            "access_code_window_at": None,
        },
    )
    limits: dict = {"expires_in_days": days, "one_time": final_one_time}
    if code:
        limits["access_code"] = True
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_APPROVED,
        actor_type=actor_type,
        actor_id=reviewer_id,
        reason=reason,
        detail=limits,
        agent=agent,
    )
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_RELEASED,
        actor_type=actor_type,
        actor_id=reviewer_id,
        detail=limits,
    )


async def reject(session: AsyncSession, transfer: Transfer, reviewer_id: str, reason: str) -> Optional[str]:
    if str(transfer.submitter_user_id) == reviewer_id:
        raise TransferError("You cannot decide your own submission.", 403)
    reason = (reason or "").strip()
    if not reason:
        raise TransferError("A reason is required to reject.", 422)
    now = datetime.utcnow()
    await _transition(
        session,
        transfer,
        PENDING_STATES,
        {
            "state": STATE_REJECTED,
            "decided_at": now,
            "decided_by_type": ACTOR_HUMAN,
            "decided_by_id": reviewer_id,
            "reject_reason": reason,
        },
    )
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_REJECTED,
        actor_type=ACTOR_HUMAN,
        actor_id=reviewer_id,
        reason=reason,
    )
    return await _delete_blob_for(session, transfer.file_id)


async def revoke(session: AsyncSession, transfer: Transfer, actor_id: str, reason: Optional[str]) -> Optional[str]:
    now = datetime.utcnow()
    await _transition(
        session,
        transfer,
        REVOCABLE_STATES,
        {"state": STATE_REVOKED, "revoked_at": now, "revoked_by_id": actor_id},
    )
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_REVOKED,
        actor_type=ACTOR_HUMAN,
        actor_id=actor_id,
        reason=reason,
    )
    return await _delete_blob_for(session, transfer.file_id)


async def withdraw(session: AsyncSession, transfer: Transfer, actor_id: str, reason: Optional[str]) -> Optional[str]:
    if str(transfer.submitter_user_id) != actor_id:
        raise TransferError("Only the submitter can withdraw a submission.", 403)
    now = datetime.utcnow()
    await _transition(
        session,
        transfer,
        WITHDRAWABLE_STATES,
        {"state": STATE_WITHDRAWN, "withdrawn_at": now},
    )
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_WITHDRAWN,
        actor_type=ACTOR_HUMAN,
        actor_id=actor_id,
        reason=reason,
    )
    return await _delete_blob_for(session, transfer.file_id)


async def overturn(session: AsyncSession, transfer: Transfer, reviewer_id: str, reason: str) -> Optional[str]:
    reason = (reason or "").strip()
    if not reason:
        raise TransferError("A reason is required to overturn.", 422)
    if transfer.decided_by_type != ACTOR_AGENT:
        raise TransferError("Only agent approvals can be overturned.", 409)
    if str(transfer.submitter_user_id) == reviewer_id:
        raise TransferError("You cannot decide your own submission.", 403)
    now = datetime.utcnow()
    result = await session.execute(
        update(Transfer)
        .where(
            Transfer.id == transfer.id,
            Transfer.state == STATE_RELEASED,
            Transfer.decided_by_type == ACTOR_AGENT,
            Transfer.first_opened_at.is_(None),
            Transfer.download_claim_token.is_(None),
        )
        .values(
            state=STATE_REJECTED,
            decided_at=now,
            decided_by_type=ACTOR_HUMAN,
            decided_by_id=reviewer_id,
            reject_reason=reason,
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.refresh(transfer)
        raise TransferError("The recipient has already opened this file, so it cannot be overturned.", 409)
    await session.refresh(transfer)
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_OVERTURNED,
        actor_type=ACTOR_HUMAN,
        actor_id=reviewer_id,
        reason=reason,
    )
    return await _delete_blob_for(session, transfer.file_id)


async def apply_scan_result(session: AsyncSession, transfer_id: UUID, status: str, detail: Optional[str]) -> Optional[str]:
    transfer = await session.get(Transfer, transfer_id, populate_existing=True)
    if transfer is None or transfer.state != STATE_SCANNING:
        return None
    now = datetime.utcnow()
    transfer.scan_status = status
    transfer.scan_detail = detail
    transfer.scanned_at = now
    checks = dict(transfer.check_results or {})
    checks["malware_scan"] = status
    transfer.check_results = checks
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_SCANNED,
        actor_type=ACTOR_SYSTEM,
        actor_id="scanner",
        detail={"status": status},
    )
    if status == SCAN_INFECTED:
        transfer.state = STATE_CHECK_FAILED
        await decision_log.append(
            session,
            organization_id=transfer.organization_id,
            transfer_id=transfer.id,
            event=EVENT_CHECK_FAILED,
            actor_type=ACTOR_SYSTEM,
            actor_id="scanner",
            reason=f"Malware detected ({detail or 'unknown signature'}).",
        )
        key = await _delete_blob_for(session, transfer.file_id)
        await session.commit()
        return key
    transfer.state = STATE_SUBMITTED
    await session.commit()
    return None


def _live_release_clause(now: datetime):
    return and_(
        Transfer.state == STATE_RELEASED,
        Transfer.revoked_at.is_(None),
        Transfer.consumed_at.is_(None),
        or_(Transfer.expires_at.is_(None), Transfer.expires_at > now),
    )


async def _classify_refusal(session: AsyncSession, transfer_id: UUID, now: datetime) -> TransferError:
    row = await session.get(Transfer, transfer_id, populate_existing=True)
    if row is None:
        return TransferError("File not found.", 404)
    if row.state == STATE_REVOKED or row.revoked_at is not None:
        return TransferError("This file was revoked.", 410)
    if row.state == STATE_CONSUMED or row.consumed_at is not None:
        return TransferError("This one-time file has already been downloaded.", 410)
    if row.state == STATE_EXPIRED or (row.expires_at is not None and row.expires_at <= now):
        return TransferError("This file has expired.", 410)
    if row.state == STATE_RELEASED and row.one_time:
        return TransferError("This one-time file is being downloaded in another session.", 409)
    return TransferError("This file has not been released.", 403)


async def check_access_code(session: AsyncSession, transfer: Transfer, user_id: str, code: Optional[str]) -> None:
    if not transfer.access_code_hash:
        return
    code = (code or "").strip()
    if not code:
        raise TransferError("This file needs the access code the Reviewer gave you.", 403)
    now = datetime.utcnow()
    fresh = or_(
        Transfer.access_code_window_at.is_(None),
        Transfer.access_code_window_at <= now - timedelta(seconds=ac.CODE_WINDOW_SECONDS),
    )
    result = await session.execute(
        update(Transfer)
        .where(Transfer.id == transfer.id, or_(fresh, Transfer.access_code_attempts < ac.CODE_ATTEMPTS_PER_WINDOW))
        .values(
            access_code_attempts=case((fresh, 1), else_=Transfer.access_code_attempts + 1),
            access_code_window_at=case((fresh, now), else_=Transfer.access_code_window_at),
        )
        .execution_options(synchronize_session=False)
    )
    if result.rowcount != 1:
        await session.commit()
        raise TransferError(
            f"Too many wrong access codes. Try again in {ac.CODE_WINDOW_SECONDS // 60} minutes.", 429
        )
    if ac.verify_access_code(transfer, code):
        await session.execute(
            update(Transfer)
            .where(Transfer.id == transfer.id)
            .values(access_code_attempts=0, access_code_window_at=None)
            .execution_options(synchronize_session=False)
        )
        await session.commit()
        return
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_ACCESS_CODE_FAILED,
        actor_type=ACTOR_HUMAN,
        actor_id=user_id,
    )
    await session.commit()
    raise TransferError("That access code is wrong.", 403)


async def claim_download(session: AsyncSession, transfer: Transfer, recipient_id: str) -> DownloadClaim:
    now = datetime.utcnow()
    if str(transfer.recipient_user_id) != recipient_id:
        raise TransferError("File not found.", 404)
    if not transfer.one_time:
        result = await session.execute(
            select(Transfer.id).where(Transfer.id == transfer.id, _live_release_clause(now))
        )
        if result.scalar_one_or_none() is None:
            raise await _classify_refusal(session, transfer.id, now)
        return DownloadClaim(transfer.id, None, False)

    token = secrets.token_hex(16)
    stale = now - timedelta(seconds=settings.intranet_download_lease_seconds)
    result = await session.execute(
        update(Transfer)
        .where(
            Transfer.id == transfer.id,
            Transfer.recipient_user_id == transfer.recipient_user_id,
            _live_release_clause(now),
            or_(Transfer.download_claim_at.is_(None), Transfer.download_claim_at < stale),
        )
        .values(download_claim_token=token, download_claim_at=now)
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    if result.rowcount != 1:
        raise await _classify_refusal(session, transfer.id, now)
    return DownloadClaim(transfer.id, token, True)


async def heartbeat_claim(session: AsyncSession, claim: DownloadClaim) -> bool:
    if not claim.one_time:
        return True
    result = await session.execute(
        update(Transfer)
        .where(
            Transfer.id == claim.transfer_id,
            Transfer.download_claim_token == claim.token,
            Transfer.state == STATE_RELEASED,
            Transfer.revoked_at.is_(None),
        )
        .values(download_claim_at=datetime.utcnow())
        .execution_options(synchronize_session=False)
    )
    await session.commit()
    return result.rowcount == 1


async def release_claim(session: AsyncSession, claim: DownloadClaim) -> None:
    if not claim.one_time:
        return
    await session.execute(
        update(Transfer)
        .where(Transfer.id == claim.transfer_id, Transfer.download_claim_token == claim.token)
        .values(download_claim_token=None, download_claim_at=None)
        .execution_options(synchronize_session=False)
    )
    await session.commit()


async def complete_download(session: AsyncSession, claim: DownloadClaim, recipient_id: str) -> Optional[str]:
    now = datetime.utcnow()
    transfer = await session.get(Transfer, claim.transfer_id, populate_existing=True)
    if transfer is None:
        return None
    first_open = transfer.first_opened_at is None
    storage_key: Optional[str] = None
    if claim.one_time:
        result = await session.execute(
            update(Transfer)
            .where(
                Transfer.id == claim.transfer_id,
                Transfer.download_claim_token == claim.token,
                Transfer.state == STATE_RELEASED,
            )
            .values(
                state=STATE_CONSUMED,
                consumed_at=now,
                first_opened_at=transfer.first_opened_at or now,
                download_claim_token=None,
                download_claim_at=None,
            )
            .execution_options(synchronize_session=False)
        )
        if result.rowcount != 1:
            await session.rollback()
            return None
    elif first_open:
        transfer.first_opened_at = now
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_OPENED_BY_RECIPIENT,
        actor_type=ACTOR_HUMAN,
        actor_id=recipient_id,
    )
    if claim.one_time:
        await decision_log.append(
            session,
            organization_id=transfer.organization_id,
            transfer_id=transfer.id,
            event=EVENT_CONSUMED,
            actor_type=ACTOR_HUMAN,
            actor_id=recipient_id,
        )
        storage_key = await _delete_blob_for(session, transfer.file_id)
    await session.commit()
    return storage_key


async def sweep(session: AsyncSession, limit: int = 200) -> list[str]:
    now = datetime.utcnow()
    released_expired = (
        await session.execute(
            select(Transfer)
            .where(
                Transfer.state == STATE_RELEASED,
                Transfer.expires_at.is_not(None),
                Transfer.expires_at <= now,
            )
            .limit(limit)
        )
    ).scalars().all()
    undecided_expired = (
        await session.execute(
            select(Transfer)
            .where(
                Transfer.state.in_((STATE_SCANNING, *PENDING_STATES)),
                Transfer.hard_expires_at.is_not(None),
                Transfer.hard_expires_at <= now,
            )
            .limit(limit)
        )
    ).scalars().all()
    keys: list[str] = []
    for transfer in [*released_expired, *undecided_expired]:
        reason = "Access window ended." if transfer.state == STATE_RELEASED else "No decision before the hard expiry."
        result = await session.execute(
            update(Transfer)
            .where(Transfer.id == transfer.id, Transfer.state == transfer.state)
            .values(state=STATE_EXPIRED, expired_at=now)
            .execution_options(synchronize_session=False)
        )
        if result.rowcount != 1:
            continue
        await decision_log.append(
            session,
            organization_id=transfer.organization_id,
            transfer_id=transfer.id,
            event=EVENT_EXPIRED,
            actor_type=ACTOR_SYSTEM,
            actor_id=SWEEPER_ACTOR,
            reason=reason,
        )
        key = await _delete_blob_for(session, transfer.file_id)
        if key:
            keys.append(key)

    stale_invites = (
        await session.execute(
            select(OrgInvite, Organization.clerk_org_id)
            .join(Organization, Organization.id == OrgInvite.organization_id)
            .where(OrgInvite.revoked_at.is_(None), OrgInvite.expires_at <= now)
            .limit(limit)
        )
    ).all()
    expired_invites: list[tuple[str, str]] = []
    for invite, clerk_org_id in stale_invites:
        invite.revoked_at = now
        accepted = (
            await session.execute(
                select(User.id)
                .join(OrganizationMembership, OrganizationMembership.user_id == User.id)
                .where(
                    OrganizationMembership.organization_id == invite.organization_id,
                    func.lower(User.email) == invite.email.lower(),
                )
                .limit(1)
            )
        ).first()
        if accepted is not None:
            continue
        await decision_log.append(
            session,
            organization_id=invite.organization_id,
            event=EVENT_INVITE_EXPIRED,
            actor_type=ACTOR_SYSTEM,
            actor_id=SWEEPER_ACTOR,
            detail={"invite_id": str(invite.id)},
        )
        if invite.clerk_invitation_id:
            expired_invites.append((clerk_org_id, invite.clerk_invitation_id))
    reminder_rows = (
        await session.execute(
            select(Transfer, OrgReviewSettings.reminder_hours)
            .join(OrgReviewSettings, OrgReviewSettings.organization_id == Transfer.organization_id)
            .where(
                Transfer.state.in_(PENDING_STATES),
                Transfer.reminded_at.is_(None),
                OrgReviewSettings.reminder_hours.is_not(None),
            )
            .order_by(Transfer.submitted_at.asc())
            .limit(limit)
        )
    ).all()
    for transfer, hours in reminder_rows:
        if transfer.submitted_at > now - timedelta(hours=hours):
            continue
        transfer.reminded_at = now
        await decision_log.append(
            session,
            organization_id=transfer.organization_id,
            transfer_id=transfer.id,
            event=EVENT_REMINDER_SENT,
            actor_type=ACTOR_SYSTEM,
            actor_id=SWEEPER_ACTOR,
            reason=f"Waiting for review longer than {hours} hours.",
        )

    abandoned_before = now - timedelta(seconds=ABANDONED_UPLOAD_SECONDS)
    abandoned = (
        await session.execute(
            select(FileAsset)
            .outerjoin(Transfer, Transfer.file_id == FileAsset.id)
            .where(
                Transfer.id.is_(None),
                FileAsset.status.in_((STATUS_PENDING_UPLOAD, STATUS_FAILED, STATUS_ACTIVE)),
                FileAsset.created_at < abandoned_before,
                FileAsset.storage_key.like(INTRANET_KEY_PREFIX + "%"),
            )
            .limit(limit)
        )
    ).scalars().all()
    for asset in abandoned:
        asset.status = STATUS_DELETED
        keys.append(asset.storage_key)
    await session.commit()

    if expired_invites:
        from app.services import clerk_client

        for clerk_org_id, invitation_id in expired_invites:
            try:
                await clerk_client.revoke_org_invitation(clerk_org_id, invitation_id, None)
            except clerk_client.ClerkAdminError:
                logger.warning("intranet: Clerk invite revoke failed for %s", invitation_id)
    return keys


async def scan_transfer(transfer_id: UUID) -> None:
    from app.db import postgres
    from app.services import malware_scan

    async with postgres.async_session_maker() as session:
        transfer = await session.get(Transfer, transfer_id)
        if transfer is None or transfer.state != STATE_SCANNING:
            return
        asset = await session.get(FileAsset, transfer.file_id)
        if asset is None:
            return
        key, size = asset.storage_key, asset.size_bytes
    result = await malware_scan.scan_object(key, size)
    async with postgres.async_session_maker() as session:
        blob = await apply_scan_result(session, transfer_id, result.status, result.detail)
    await delete_blob(blob)


async def retry_stuck_scans(limit: int = 20) -> int:
    from app.db import postgres

    cutoff = datetime.utcnow() - timedelta(seconds=settings.intranet_scan_retry_seconds)
    async with postgres.async_session_maker() as session:
        ids = (
            await session.execute(
                select(Transfer.id)
                .where(Transfer.state == STATE_SCANNING, Transfer.submitted_at < cutoff)
                .limit(limit)
            )
        ).scalars().all()
    for tid in ids:
        await scan_transfer(tid)
    return len(ids)
