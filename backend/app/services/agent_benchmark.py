from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.timeutils import iso_utc
from app.models.intranet import (
    ACTOR_HUMAN,
    ACTOR_SYSTEM,
    EVENT_APPROVED,
    EVENT_BENCHMARK_RUN,
    EVENT_OVERTURNED,
    EVENT_REJECTED,
    INPUT_METADATA_ONLY,
    AgentBenchmark,
    DecisionLogEntry,
    OrgReviewSettings,
    Transfer,
)
from app.services import decision_log, review_agent

logger = logging.getLogger(__name__)

THRESHOLDS = (0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99)


async def collect_cases(session: AsyncSession, organization_id: UUID, limit: int) -> list[tuple[Transfer, int]]:
    rows = (
        await session.execute(
            select(DecisionLogEntry.transfer_id, DecisionLogEntry.event)
            .where(
                DecisionLogEntry.organization_id == organization_id,
                DecisionLogEntry.actor_type == ACTOR_HUMAN,
                DecisionLogEntry.event.in_((EVENT_APPROVED, EVENT_REJECTED, EVENT_OVERTURNED)),
                DecisionLogEntry.transfer_id.is_not(None),
            )
            .order_by(DecisionLogEntry.id.asc())
        )
    ).all()
    labels: dict[UUID, int] = {}
    for transfer_id, event in rows:
        if event == EVENT_OVERTURNED:
            labels[transfer_id] = 0
        elif transfer_id not in labels:
            labels[transfer_id] = 1 if event == EVENT_APPROVED else 0
    ids = list(labels)[-limit:]
    if not ids:
        return []
    transfers = {
        t.id: t for t in (await session.execute(select(Transfer).where(Transfer.id.in_(ids)))).scalars()
    }
    return [(transfers[i], labels[i]) for i in ids if i in transfers]


def _row(threshold: float, samples: list[tuple[int, float]]) -> dict[str, Any]:
    tp = fp = tn = fn = 0
    for label, p in samples:
        predicted = p >= threshold
        if predicted and label == 1:
            tp += 1
        elif predicted and label == 0:
            fp += 1
        elif not predicted and label == 0:
            tn += 1
        else:
            fn += 1
    n = len(samples)
    return {
        "threshold": threshold,
        "agreement": round((tp + tn) / n, 4) if n else None,
        "auto_approved": tp + fp,
        "coverage": round((tp + fp) / n, 4) if n else None,
        "false_releases": fp,
        "false_release_rate": round(fp / (fp + tn), 4) if (fp + tn) else None,
        "missed_approvals": fn,
        "tp": tp,
        "fp": fp,
        "tn": tn,
        "fn": fn,
    }


def summarize(
    provider: str,
    samples: list[tuple[int, float]],
    errors: list[str],
    cases: int,
    current_threshold: float,
    models: set[str],
) -> dict[str, Any]:
    thresholds = sorted(set(THRESHOLDS) | {round(current_threshold, 4)})
    return {
        "provider": provider,
        "models": sorted(models),
        "input_mode": INPUT_METADATA_ONLY,
        "generated_at": iso_utc(datetime.utcnow()),
        "cases": cases,
        "scored": len(samples),
        "errors": len(errors),
        "error_samples": errors[:5],
        "human_approved": sum(1 for label, _ in samples if label == 1),
        "human_rejected": sum(1 for label, _ in samples if label == 0),
        "current_threshold": current_threshold,
        "at_current_threshold": _row(current_threshold, samples),
        "sweep": [_row(t, samples) for t in thresholds],
        "note": (
            "Replays human approve/reject decisions from the decision log. Metadata only: blobs of decided "
            "files are usually deleted. No pass/fail is computed; the agreement needed to enable the agent "
            "is Deep's call."
        ),
    }


async def run(session: AsyncSession, organization_id: UUID, provider: str, limit: int) -> dict[str, Any]:
    review = await session.get(OrgReviewSettings, organization_id)
    threshold = review.agent_threshold if review else 0.95
    cases = await collect_cases(session, organization_id, limit)
    samples: list[tuple[int, float]] = []
    errors: list[str] = []
    models: set[str] = set()
    for transfer, label in cases:
        payload = await review_agent.build_input(session, transfer, INPUT_METADATA_ONLY, include_content=False)
        result, errs = await review_agent.score_with_fallback([provider], payload)
        if result is None:
            errors.extend(errs or [f"{provider}: no result"])
            continue
        models.add(f"{result.model}@{result.version}")
        samples.append((label, result.p_approve))
    return summarize(provider, samples, errors, len(cases), threshold, models)


def to_markdown(report: dict[str, Any], org_name: Optional[str] = None) -> str:
    lines = [
        f"# Review agent benchmark{f' — {org_name}' if org_name else ''}",
        "",
        f"- Provider: `{report['provider']}` ({', '.join(report['models']) or 'no model reported'})",
        f"- Generated: {report['generated_at']}",
        f"- Human decisions replayed: {report['cases']} (scored {report['scored']}, errors {report['errors']})",
        f"- Human approved / rejected: {report['human_approved']} / {report['human_rejected']}",
        f"- Input mode: {report['input_mode']}",
        "",
        "| Threshold | Agreement | Auto-approved | Coverage | False releases | False-release rate | Missed approvals |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in report["sweep"]:
        mark = " (current)" if r["threshold"] == report["current_threshold"] else ""
        lines.append(
            f"| {r['threshold']}{mark} | {r['agreement']} | {r['auto_approved']} | {r['coverage']} | "
            f"{r['false_releases']} | {r['false_release_rate']} | {r['missed_approvals']} |"
        )
    lines += ["", report["note"], ""]
    if report["error_samples"]:
        lines += ["Errors (first 5):", ""] + [f"- {e}" for e in report["error_samples"]] + [""]
    return "\n".join(lines)


async def run_job(benchmark_id: UUID) -> None:
    from app.db import postgres

    async with postgres.async_session_maker() as session:
        row = await session.get(AgentBenchmark, benchmark_id)
        if row is None:
            return
        try:
            report = await run(session, row.organization_id, row.provider, settings.review_agent_benchmark_max_rows)
            row.report = report
            row.status = "done"
        except Exception as exc:
            logger.exception("agent benchmark %s failed", benchmark_id)
            row.status = "failed"
            row.error = str(exc)[:500]
            report = None
        row.finished_at = datetime.utcnow()
        await decision_log.append(
            session,
            organization_id=row.organization_id,
            event=EVENT_BENCHMARK_RUN,
            actor_type=ACTOR_SYSTEM,
            actor_id="benchmark",
            detail={
                "benchmark_id": str(row.id),
                "provider": row.provider,
                "status": row.status,
                "scored": report["scored"] if report else 0,
                "agreement_at_current": report["at_current_threshold"]["agreement"] if report else None,
            },
        )
        await session.commit()
