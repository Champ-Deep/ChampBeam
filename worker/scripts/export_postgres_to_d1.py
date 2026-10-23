"""Export the ChampBeam Postgres database as SQL that D1 can import.

One-time migration for the move to Cloudflare. Reads every table the D1 schema
(worker/migrations/0001_init.sql) defines, converts values to the D1 storage
conventions, and writes INSERT statements into numbered .sql files:

  UUID       -> canonical lowercase text
  timestamp  -> ISO-8601 UTC "YYYY-MM-DDTHH:MM:SS.sssZ" (naive values are UTC)
  date       -> "YYYY-MM-DD"
  boolean    -> 0 / 1
  json/jsonb -> JSON text

Only columns present in BOTH databases are copied, so a schema that drifted on
either side still exports cleanly (the column lists are reported).

Usage (from the repo root, with the backend's Python deps installed):

    python worker/scripts/export_postgres_to_d1.py "$DATABASE_URL" --out d1-export
    # then, for each file in order:
    npx wrangler d1 execute champbeam --remote --file d1-export/0001.sql

Railway rotates its proxy credentials — re-read DATABASE_URL right before the
final export, and take it while writes are paused (or immediately before the
DNS flip) so nothing lands in Postgres after the snapshot.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

import asyncpg

SCHEMA_SQL = Path(__file__).resolve().parent.parent / "migrations" / "0001_init.sql"

# Parent tables before children so foreign keys resolve (D1 also gets
# PRAGMA defer_foreign_keys as a safety net).
TABLE_ORDER = [
    "users",
    "organizations",
    "organization_memberships",
    "api_keys",
    "utm_presets",
    "projects",
    "domains",
    "link_clicks",
    "file_assets",
    "file_versions",
    "click_events",
    "link_tags",
    "link_tag_associations",
    "content_items",
    "content_shares",
    "assignments",
    "champvault_favorites",
    "access_leads",
    "rooms",
    "room_recipients",
    "room_links",
    "room_events",
    "page_engagements",
    "page_comments",
    "page_state",
    "page_events",
    "maxmind_usage",
]

ROWS_PER_INSERT = 50
MAX_FILE_BYTES = 4 * 1024 * 1024


def d1_columns() -> dict[str, list[str]]:
    """Table -> column names, parsed from the D1 schema file."""
    sql = SCHEMA_SQL.read_text(encoding="utf-8")
    out: dict[str, list[str]] = {}
    for m in re.finditer(r"CREATE TABLE (\w+) \((.*?)\n\);", sql, re.S):
        cols = []
        for line in m.group(2).splitlines():
            line = line.strip()
            if not line or line.startswith(("PRIMARY KEY", "--")):
                continue
            cols.append(line.split()[0])
        out[m.group(1)] = cols
    return out


def to_sql_literal(value) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, uuid.UUID):
        return f"'{value}'"
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc).replace(tzinfo=None)
        text = value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"
        return f"'{text}'"
    if isinstance(value, date):
        return f"'{value.isoformat()}'"
    if isinstance(value, (dict, list)):
        value = json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return f"X'{bytes(value).hex()}'"
    text = str(value).replace("'", "''")
    return f"'{text}'"


async def export(dsn: str, out_dir: Path) -> None:
    targets = d1_columns()
    conn = await asyncpg.connect(dsn)
    # Decode json/jsonb into Python objects so they are re-serialized compactly.
    for typ in ("json", "jsonb"):
        await conn.set_type_codec(typ, encoder=json.dumps, decoder=json.loads, schema="pg_catalog")

    out_dir.mkdir(parents=True, exist_ok=True)
    file_no = 0
    buf: list[str] = []
    size = 0

    def flush() -> None:
        nonlocal file_no, buf, size
        if not buf:
            return
        file_no += 1
        path = out_dir / f"{file_no:04d}.sql"
        path.write_text("PRAGMA defer_foreign_keys = true;\n" + "".join(buf), encoding="utf-8")
        buf, size = [], 0

    try:
        for table in TABLE_ORDER:
            pg_cols = [
                r["column_name"]
                for r in await conn.fetch(
                    "SELECT column_name FROM information_schema.columns "
                    "WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position",
                    table,
                )
            ]
            if not pg_cols:
                print(f"{table}: not in Postgres, skipped")
                continue
            cols = [c for c in targets[table] if c in pg_cols]
            dropped = [c for c in pg_cols if c not in targets[table]]
            missing = [c for c in targets[table] if c not in pg_cols]
            col_sql = ", ".join(f'"{c}"' for c in cols)
            rows = await conn.fetch(f'SELECT {col_sql} FROM "{table}"')
            print(
                f"{table}: {len(rows)} rows"
                + (f" | not copied (Postgres-only): {dropped}" if dropped else "")
                + (f" | defaulted (D1-only): {missing}" if missing else "")
            )
            for i in range(0, len(rows), ROWS_PER_INSERT):
                values = ",\n".join(
                    "(" + ", ".join(to_sql_literal(row[c]) for c in cols) + ")"
                    for row in rows[i : i + ROWS_PER_INSERT]
                )
                stmt = f'INSERT INTO "{table}" ({col_sql}) VALUES\n{values};\n'
                if size + len(stmt) > MAX_FILE_BYTES:
                    flush()
                buf.append(stmt)
                size += len(stmt)
        flush()
    finally:
        await conn.close()
    print(f"wrote {file_no} file(s) to {out_dir}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("database_url", help="Postgres URL (postgres:// or postgresql://)")
    parser.add_argument("--out", default="d1-export", help="output directory for the .sql files")
    args = parser.parse_args()
    dsn = re.sub(r"^postgresql\+\w+://", "postgresql://", args.database_url)
    asyncio.run(export(dsn, Path(args.out)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
