from __future__ import annotations

import hashlib
import json
import logging
import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional, Protocol
from uuid import UUID

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.file_asset import FileAsset
from app.models.intranet import (
    ACTOR_AGENT,
    AGENT_JEV,
    AGENT_LOCAL,
    AGENT_OFF,
    EVENT_ESCALATED,
    INPUT_CONTENT_EXCERPT,
    INPUT_METADATA_ONLY,
    PENDING_STATES,
    SCAN_CLEAN,
    OrgReviewSettings,
    Transfer,
)
from app.models.user import User
from app.services import decision_log, storage

logger = logging.getLogger(__name__)

PROVIDER_CLEF = "clef"
PROVIDER_JEV = "jev"
PROVIDER_MOCK = "mock"

CRITERIA = [
    {
        "name": "business_purpose",
        "question": "Does the purpose note describe a plausible internal business reason for this transfer?",
    },
    {
        "name": "file_matches_purpose",
        "question": "Do the file name, type and size fit the stated purpose?",
    },
    {
        "name": "recipient_fit",
        "question": "Is the recipient a sensible person to receive this file given the purpose?",
    },
    {
        "name": "no_sensitive_red_flags",
        "question": "Is there no sign of credentials, personal data dumps, or data leaving its intended team?",
    },
]
QUESTION = "Should IT release this internal file transfer without a human review?"

_TEXT_MIME_PREFIXES = ("text/",)
_TEXT_MIMES = {"application/json", "application/xml", "application/csv", "application/x-ndjson"}


class ScorerError(Exception):
    pass


@dataclass
class ScoreResult:
    p_approve: float
    reasons: list[str]
    model: str
    version: str
    provider: str


class Scorer(Protocol):
    name: str

    async def score(self, payload: dict[str, Any]) -> ScoreResult: ...


def _validate(data: Any, provider: str) -> ScoreResult:
    if not isinstance(data, dict):
        raise ScorerError("scorer returned a non-object response")
    p = data.get("p_approve")
    if isinstance(p, bool) or not isinstance(p, (int, float)) or math.isnan(float(p)) or not 0.0 <= float(p) <= 1.0:
        raise ScorerError("scorer returned an invalid p_approve")
    reasons = data.get("reasons") or []
    if not isinstance(reasons, list):
        reasons = [str(reasons)]
    return ScoreResult(
        p_approve=float(p),
        reasons=[str(r)[:500] for r in reasons][:10],
        model=str(data.get("model") or "unknown")[:120],
        version=str(data.get("version") or "unknown")[:60],
        provider=provider,
    )


class ClefScorer:
    name = PROVIDER_CLEF

    async def score(self, payload: dict[str, Any]) -> ScoreResult:
        if not settings.clef_configured:
            raise ScorerError("Clef is not configured")
        headers = {"Content-Type": "application/json"}
        if settings.clef_token:
            headers["Authorization"] = f"Bearer {settings.clef_token}"
        body = {"question": QUESTION, "criteria": CRITERIA, "input": payload}
        try:
            async with httpx.AsyncClient(timeout=settings.clef_timeout_s) as client:
                resp = await client.post(settings.clef_url, json=body, headers=headers)
        except httpx.HTTPError as exc:
            raise ScorerError(f"Clef request failed: {exc.__class__.__name__}") from exc
        if resp.status_code != 200:
            raise ScorerError(f"Clef returned HTTP {resp.status_code}")
        try:
            data = resp.json()
        except ValueError as exc:
            raise ScorerError("Clef returned invalid JSON") from exc
        return _validate(data, self.name)


class MockScorer:
    name = PROVIDER_MOCK

    async def score(self, payload: dict[str, Any]) -> ScoreResult:
        purpose = str(payload.get("purpose") or "")
        p = 0.97 if len(purpose.strip()) >= 12 else 0.4
        if "reject" in purpose.lower():
            p = 0.1
        return ScoreResult(p, [f"purpose length {len(purpose)}"], "mock-rules", "1", self.name)


def get_scorer(provider: str) -> Scorer:
    if provider == PROVIDER_CLEF:
        return ClefScorer()
    if provider == PROVIDER_MOCK and settings.review_agent_allow_mock:
        return MockScorer()
    raise ScorerError(f"Provider '{provider}' is not available")


def provider_chain(agent_mode: str) -> list[str]:
    if agent_mode == AGENT_JEV:
        return [PROVIDER_JEV, PROVIDER_CLEF]
    if agent_mode == AGENT_LOCAL:
        chain = [PROVIDER_CLEF]
        if settings.review_agent_allow_mock and not settings.clef_configured:
            chain = [PROVIDER_MOCK]
        return chain
    return []


def available_modes() -> list[str]:
    modes = [AGENT_OFF]
    if settings.clef_configured or settings.review_agent_allow_mock:
        modes.append(AGENT_LOCAL)
    return modes


def canonical_sha256(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


async def _excerpt(asset: FileAsset) -> Optional[str]:
    mime = (asset.mime_type or "").lower().split(";", 1)[0].strip()
    name = (asset.filename or "").lower()
    texty = mime.startswith(_TEXT_MIME_PREFIXES) or mime in _TEXT_MIMES or name.endswith((".csv", ".tsv", ".txt", ".json", ".md"))
    if not texty:
        return None
    limit = settings.review_agent_excerpt_bytes
    buf = bytearray()
    try:
        async for chunk in storage.stream_object(asset.storage_key):
            buf.extend(chunk)
            if len(buf) >= limit:
                break
    except (storage.StorageError, storage.StorageNotConfigured):
        return None
    return bytes(buf[:limit]).decode("utf-8", errors="replace")


async def build_input(
    session: AsyncSession, transfer: Transfer, input_mode: str, include_content: bool = True
) -> dict[str, Any]:
    asset = await session.get(FileAsset, transfer.file_id)
    people = {
        u.id: u
        for u in (
            await session.execute(
                select(User).where(User.id.in_([transfer.submitter_user_id, transfer.recipient_user_id]))
            )
        ).scalars()
    }

    def who(uid: UUID) -> dict[str, Optional[str]]:
        u = people.get(uid)
        return {"name": u.full_name if u else None, "email": u.email if u else None}

    payload: dict[str, Any] = {
        "filename": asset.filename if asset else None,
        "size_bytes": asset.size_bytes if asset else None,
        "mime_type": asset.mime_type if asset else None,
        "submitter": who(transfer.submitter_user_id),
        "recipient": who(transfer.recipient_user_id),
        "purpose": transfer.purpose,
        "requested_expires_in_days": transfer.requested_expires_in_days,
        "requested_one_time": bool(transfer.requested_one_time),
        "hard_checks": transfer.check_results or {},
        "malware_scan": transfer.scan_status,
        "input_mode": input_mode,
    }
    if input_mode == INPUT_CONTENT_EXCERPT and include_content and asset is not None:
        payload["content_excerpt"] = await _excerpt(asset)
    return payload


async def deterministic_failures(session: AsyncSession, transfer: Transfer) -> list[str]:
    failures: list[str] = []
    if transfer.scan_status != SCAN_CLEAN:
        failures.append(f"malware scan is '{transfer.scan_status or 'missing'}', not clean")
    checks = transfer.check_results or {}
    for key in ("size", "type"):
        if checks.get(key) != "ok":
            failures.append(f"{key} check did not pass")
    asset = await session.get(FileAsset, transfer.file_id)
    if asset is None or not asset.sha256:
        failures.append("integrity hash not available")
    else:
        dup = (
            await session.execute(
                select(Transfer.id)
                .join(FileAsset, FileAsset.id == Transfer.file_id)
                .where(
                    Transfer.organization_id == transfer.organization_id,
                    Transfer.id != transfer.id,
                    FileAsset.sha256 == asset.sha256,
                )
                .limit(1)
            )
        ).first()
        if dup is not None:
            failures.append("the same file (sha256) was submitted before")
    return failures


async def score_with_fallback(chain: list[str], payload: dict[str, Any]) -> tuple[Optional[ScoreResult], list[str]]:
    errors: list[str] = []
    for provider in chain:
        try:
            scorer = get_scorer(provider)
            return await scorer.score(payload), errors
        except ScorerError as exc:
            errors.append(f"{provider}: {exc}")
        except Exception as exc:
            logger.exception("review agent: scorer %s crashed", provider)
            errors.append(f"{provider}: {exc.__class__.__name__}")
    return None, errors


@dataclass
class PassStats:
    approved: int = 0
    escalated: int = 0
    skipped: int = 0
    ids: list[str] = field(default_factory=list)


async def _escalate(
    session: AsyncSession,
    transfer: Transfer,
    review: OrgReviewSettings,
    reason: str,
    result: Optional[ScoreResult],
    input_sha: Optional[str],
) -> None:
    now = datetime.utcnow()
    transfer.escalated_at = now
    transfer.agent_evaluated_at = now
    transfer.escalation_reason = reason
    transfer.agent_result = (
        {"p_approve": result.p_approve, "reasons": result.reasons, "provider": result.provider, "model": result.model}
        if result
        else None
    )
    await decision_log.append(
        session,
        organization_id=transfer.organization_id,
        transfer_id=transfer.id,
        event=EVENT_ESCALATED,
        actor_type=ACTOR_AGENT,
        actor_id=f"agent:{result.provider}" if result else "agent",
        reason=reason,
        agent={
            "provider": result.provider if result else None,
            "model": result.model if result else None,
            "input_mode": review.agent_input_mode,
            "p_approve": result.p_approve if result else None,
            "threshold": review.agent_threshold,
            "input_sha256": input_sha,
        },
    )


async def evaluate_transfer(session: AsyncSession, transfer: Transfer, review: OrgReviewSettings) -> str:
    from app.services import transfer_service

    failures = await deterministic_failures(session, transfer)
    if failures:
        await _escalate(session, transfer, review, "Deterministic checks: " + "; ".join(failures), None, None)
        return "escalated"

    chain = provider_chain(review.agent_mode)
    input_mode = review.agent_input_mode
    results: Optional[ScoreResult] = None
    errors: list[str] = []
    payload: dict[str, Any] = {}
    for provider in chain:
        mode = input_mode if provider != PROVIDER_JEV else INPUT_METADATA_ONLY
        payload = await build_input(session, transfer, mode)
        results, errs = await score_with_fallback([provider], payload)
        errors.extend(errs)
        if results is not None:
            break
    input_sha = canonical_sha256(payload) if payload else None
    if results is None:
        await _escalate(session, transfer, review, "Scorer unavailable: " + "; ".join(errors or ["no provider"]), None, input_sha)
        return "escalated"
    if results.p_approve < review.agent_threshold:
        await _escalate(
            session,
            transfer,
            review,
            f"Confidence {results.p_approve:.2f} is below the {review.agent_threshold:.2f} threshold.",
            results,
            input_sha,
        )
        return "escalated"

    transfer.agent_evaluated_at = datetime.utcnow()
    transfer.agent_result = {
        "p_approve": results.p_approve,
        "reasons": results.reasons,
        "provider": results.provider,
        "model": results.model,
    }
    await transfer_service.approve(
        session,
        transfer,
        f"agent:{results.provider}",
        review,
        None,
        None,
        "; ".join(results.reasons)[:1000] or None,
        actor_type=ACTOR_AGENT,
        agent={
            "provider": results.provider,
            "model": f"{results.model}@{results.version}",
            "input_mode": payload.get("input_mode"),
            "p_approve": results.p_approve,
            "threshold": review.agent_threshold,
            "input_sha256": input_sha,
        },
    )
    return "approved"


async def run_pass(session: AsyncSession, limit: int = 50) -> PassStats:
    stats = PassStats()
    now = datetime.utcnow()
    orgs = (
        await session.execute(select(OrgReviewSettings).where(OrgReviewSettings.agent_mode != AGENT_OFF))
    ).scalars().all()
    for review in orgs:
        due = (
            await session.execute(
                select(Transfer)
                .where(
                    Transfer.organization_id == review.organization_id,
                    Transfer.state.in_(PENDING_STATES),
                    Transfer.agent_evaluated_at.is_(None),
                    Transfer.agent_window_ends_at.is_not(None),
                    Transfer.agent_window_ends_at <= now,
                )
                .order_by(Transfer.submitted_at.asc())
                .limit(limit)
            )
        ).scalars().all()
        for transfer in due:
            try:
                outcome = await evaluate_transfer(session, transfer, review)
                await session.commit()
            except Exception:
                logger.exception("review agent: evaluating %s failed", transfer.id)
                await session.rollback()
                stats.skipped += 1
                continue
            stats.ids.append(str(transfer.id))
            if outcome == "approved":
                stats.approved += 1
            else:
                stats.escalated += 1
    return stats
