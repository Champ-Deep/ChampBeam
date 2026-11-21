from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.timeutils import iso_utc
from app.models.intranet import ACTOR_HUMAN, DecisionLogEntry

_HASHED_FIELDS = (
    "at",
    "organization_id",
    "transfer_id",
    "event",
    "actor_type",
    "actor_id",
    "reason",
    "detail",
    "agent_provider",
    "agent_model",
    "agent_input_mode",
    "agent_p_approve",
    "agent_threshold",
    "agent_input_sha256",
)


def _canonical(value: Any) -> Any:
    if isinstance(value, datetime):
        return iso_utc(value)
    if isinstance(value, UUID):
        return str(value)
    return value


def compute_hash(entry: DecisionLogEntry) -> str:
    body = {f: _canonical(getattr(entry, f)) for f in _HASHED_FIELDS}
    payload = (entry.prev_hash or "") + json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


async def _lock_org_chain(session: AsyncSession, organization_id: UUID) -> None:
    bind = session.get_bind()
    if bind.dialect.name == "postgresql":
        await session.execute(
            text("SELECT pg_advisory_xact_lock(hashtext(:k))"),
            {"k": f"decision_log:{organization_id}"},
        )


async def append(
    session: AsyncSession,
    *,
    organization_id: UUID,
    event: str,
    actor_type: str = ACTOR_HUMAN,
    actor_id: Optional[str] = None,
    transfer_id: Optional[UUID] = None,
    reason: Optional[str] = None,
    detail: Optional[dict[str, Any]] = None,
    agent: Optional[dict[str, Any]] = None,
) -> DecisionLogEntry:
    await _lock_org_chain(session, organization_id)
    prev = (
        await session.execute(
            select(DecisionLogEntry.row_hash)
            .where(DecisionLogEntry.organization_id == organization_id)
            .order_by(DecisionLogEntry.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    agent = agent or {}
    entry = DecisionLogEntry(
        at=datetime.utcnow().replace(microsecond=0),
        organization_id=organization_id,
        transfer_id=transfer_id,
        event=event,
        actor_type=actor_type,
        actor_id=actor_id,
        reason=reason,
        detail=detail,
        agent_provider=agent.get("provider"),
        agent_model=agent.get("model"),
        agent_input_mode=agent.get("input_mode"),
        agent_p_approve=agent.get("p_approve"),
        agent_threshold=agent.get("threshold"),
        agent_input_sha256=agent.get("input_sha256"),
        prev_hash=prev,
    )
    entry.row_hash = compute_hash(entry)
    session.add(entry)
    await session.flush()
    return entry


async def verify_chain(session: AsyncSession, organization_id: UUID) -> dict[str, Any]:
    rows = (
        await session.execute(
            select(DecisionLogEntry)
            .where(DecisionLogEntry.organization_id == organization_id)
            .order_by(DecisionLogEntry.id.asc())
        )
    ).scalars()
    prev: Optional[str] = None
    count = 0
    for row in rows:
        count += 1
        if row.prev_hash != prev or compute_hash(row) != row.row_hash:
            return {"ok": False, "rows": count, "first_bad_id": row.id}
        prev = row.row_hash
    return {"ok": True, "rows": count, "first_bad_id": None}
