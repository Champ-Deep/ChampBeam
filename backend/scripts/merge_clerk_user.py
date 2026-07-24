"""Re-link / merge a local user's data from one Clerk identity to another.

Why this exists: Clerk's *development* and *production* instances are separate,
so the same person has a DIFFERENT Clerk user id in each. The backend keys local
rows on ``clerk_id``, so after you switch the app to the production instance a
returning user authenticates as a brand-new local user and their existing links,
files, domains, presets, and org memberships look like they belong to someone
else ("I see my old files but they don't work / aren't mine"). This script
reassigns ownership of everything from the old (source) user row to the new
(target) user row, then retires the source row.

Resolve a user by email, Clerk id (``user_...``), or local UUID.

Usage (run inside the backend container / venv):

    # preview only — no writes
    python scripts/merge_clerk_user.py --from you@example.com --into user_PRODxxx --dry-run

    # perform the merge
    python scripts/merge_clerk_user.py --from user_DEVxxx --into user_PRODxxx

``--into`` is the identity you want to KEEP (your production login).
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
import uuid as _uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logging.basicConfig(level=logging.INFO, format="merge_clerk_user: %(message)s")
log = logging.getLogger(__name__)

# (table, owner column) pairs that carry per-user ownership.
OWNERSHIP = [
    ("utm_presets", "user_id"),
    ("projects", "user_id"),
    ("link_clicks", "user_id"),
    ("link_tags", "user_id"),
    ("file_assets", "user_id"),
    ("domains", "user_id"),
    ("content_items", "created_by_user_id"),
    ("content_shares", "shared_by_user_id"),
    ("organization_memberships", "user_id"),
]


def _placeholder(email: str | None) -> bool:
    return bool(email) and email.endswith("@clerk.placeholder")


async def _resolve_user(session: AsyncSession, value: str) -> dict | None:
    value = value.strip()
    if value.startswith("user_"):
        col, param = "clerk_id", value
    elif "@" in value:
        col, param = "email", value
    else:
        try:
            param = str(_uuid.UUID(value))
        except ValueError:
            raise SystemExit(f"Could not interpret '{value}' as an email, clerk id, or UUID.")
        col = "id"
    row = (await session.execute(
        text(f"SELECT id, clerk_id, email, full_name FROM users WHERE {col} = :v"),
        {"v": param},
    )).mappings().first()
    return dict(row) if row else None


async def _table_has_rows(session: AsyncSession, table: str, column: str, user_id: str) -> int:
    return int((await session.execute(
        text(f"SELECT count(*) FROM {table} WHERE {column} = :u"), {"u": user_id}
    )).scalar() or 0)


async def merge(from_value: str, into_value: str, dry_run: bool) -> None:
    from app.db.postgres import async_session_maker

    async with async_session_maker() as session:
        src = await _resolve_user(session, from_value)
        dst = await _resolve_user(session, into_value)
        if not src:
            raise SystemExit(f"Source user not found: {from_value}")
        if not dst:
            raise SystemExit(f"Target user not found: {into_value}")
        if src["id"] == dst["id"]:
            raise SystemExit("Source and target are the same user; nothing to do.")

        log.info("Source : %s  (clerk_id=%s, email=%s)", src["id"], src["clerk_id"], src["email"])
        log.info("Target : %s  (clerk_id=%s, email=%s)", dst["id"], dst["clerk_id"], dst["email"])

        total = 0
        for table, column in OWNERSHIP:
            n = await _table_has_rows(session, table, column, src["id"])
            total += n
            if n:
                log.info("  %-26s %-18s %d row(s)", table, column, n)
            if n and not dry_run:
                await session.execute(
                    text(f"UPDATE {table} SET {column} = :dst WHERE {column} = :src"),
                    {"dst": dst["id"], "src": src["id"]},
                )

        log.info("Total rows to reassign: %d", total)

        if dry_run:
            log.info("[dry-run] no changes written. Re-run without --dry-run to apply.")
            return

        # Promote the source's real identity onto the target if the target is
        # still on the first-auth placeholder, then retire the source row so it
        # can't authenticate or clash on the unique email.
        if _placeholder(dst["email"]) and not _placeholder(src["email"]):
            # Free the source's email FIRST so the unique(email) constraint isn't
            # momentarily violated, then promote it onto the target.
            await session.execute(
                text("UPDATE users SET email = :tomb WHERE id = :id"),
                {"tomb": f"merged+{src['id']}@clerk.placeholder", "id": src["id"]},
            )
            await session.execute(
                text("UPDATE users SET email = :e, full_name = COALESCE(full_name, :n) WHERE id = :id"),
                {"e": src["email"], "n": src["full_name"], "id": dst["id"]},
            )

        await session.execute(
            text("UPDATE users SET clerk_id = NULL, is_active = false WHERE id = :id"),
            {"id": src["id"]},
        )
        await session.commit()
        log.info("Merge complete. '%s' now owns the data; source row retired.", into_value)


def main() -> None:
    parser = argparse.ArgumentParser(description="Re-link a user's data to a new Clerk identity.")
    parser.add_argument("--from", dest="from_value", required=True, help="Source (email | user_... | UUID)")
    parser.add_argument("--into", dest="into_value", required=True, help="Target to KEEP (email | user_... | UUID)")
    parser.add_argument("--dry-run", action="store_true", help="Preview counts without writing.")
    args = parser.parse_args()
    asyncio.run(merge(args.from_value, args.into_value, args.dry_run))


if __name__ == "__main__":
    try:
        main()
    except SystemExit as exc:
        log.error("%s", exc)
        sys.exit(1)
