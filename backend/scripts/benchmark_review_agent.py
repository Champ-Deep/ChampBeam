"""Replay human review decisions from the decision log through a review-agent scorer.

Usage (inside the backend container / venv, against the intranet database):

    python scripts/benchmark_review_agent.py --org org_XXXX --provider clef --out-dir ./benchmarks

Writes benchmark-<org>-<timestamp>.json and .md. No pass/fail is computed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from datetime import datetime
from pathlib import Path

from sqlalchemy import select


async def _main(org: str, provider: str, limit: int, out_dir: Path) -> int:
    from app.db.postgres import async_session_maker
    from app.models.org import Organization
    from app.services import agent_benchmark

    async with async_session_maker() as session:
        organization = (
            await session.execute(select(Organization).where(Organization.clerk_org_id == org))
        ).scalar_one_or_none()
        if organization is None:
            print(f"No organization with Clerk id {org}", file=sys.stderr)
            return 2
        report = await agent_benchmark.run(session, organization.id, provider, limit)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
    base = out_dir / f"benchmark-{org}-{stamp}"
    base.with_suffix(".json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    base.with_suffix(".md").write_text(agent_benchmark.to_markdown(report, organization.name), encoding="utf-8")
    print(agent_benchmark.to_markdown(report, organization.name))
    print(f"Wrote {base}.json and {base}.md")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--org", required=True, help="Clerk organization id (org_...)")
    parser.add_argument("--provider", default="clef", choices=["clef", "mock"])
    parser.add_argument("--limit", type=int, default=500, help="Most recent human decisions to replay")
    parser.add_argument("--out-dir", type=Path, default=Path("benchmarks"))
    args = parser.parse_args()
    if args.provider == "mock":
        from app.core.config import settings

        settings.review_agent_allow_mock = True
    sys.exit(asyncio.run(_main(args.org, args.provider, args.limit, args.out_dir)))


if __name__ == "__main__":
    main()
