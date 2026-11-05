"""Redacted read-only inventory of files/pages for the page-disappearance investigation.

Input is a SQLite copy of ONE source (a D1 export, or the standby loaded into
SQLite). The file is opened read-only; nothing is written to any source.
Output is a manifest of COUNTS only: owners and orgs appear as salted-hash
tags, never as ids, emails, filenames, slugs, short codes or storage keys.

    python page_inventory.py d1.sqlite --source d1 --blobs r2-keys.txt > d1.json
    python page_inventory.py standby.sqlite --source standby > standby.json

--blobs is a text file with one object key per line (an R2/S3 listing). Run it
once per source (Railway, D1, standby) and diff the manifests; a source that
ends early (the standby stops 7 Sep) must never be treated as the full set.
Missing-blob counts are reported per bucket, so "row exists, blob missing"
(a 404 on serve) is separate from "row missing" (an empty list).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import secrets
import sqlite3
import sys
from collections import Counter

# Mirrors worker/src/routes/_files.ts outputKind(): explicit intent wins, else a slug means page.
OUTPUT_KIND = "CASE WHEN share_intent IS NOT NULL THEN CASE share_intent WHEN 'host' THEN 'page' ELSE 'file' END WHEN slug IS NOT NULL THEN 'page' ELSE 'file' END"


def build(db: sqlite3.Connection, blobs: set[str] | None, salt: str) -> dict:
    cols = {r[1] for r in db.execute("PRAGMA table_info(file_assets)")}
    sel = lambda c, d="NULL": c if c in cols else d  # older sources lack the newer columns
    q = f"""SELECT user_id, {sel('organization_id')} AS org, status, kind, storage_key, created_at,
                   {sel('share_intent')} AS share_intent, {sel('slug')} AS slug FROM file_assets"""
    db.create_function("tag", 1, lambda v: None if v is None else hashlib.sha256((salt + str(v)).encode()).hexdigest()[:8])
    rows = db.execute(q).fetchall()
    versions = {r[0] for r in db.execute("SELECT DISTINCT file_id FROM file_versions")} if _has(db, "file_versions") else set()
    ids = {r[0]: r for r in db.execute("SELECT id, storage_key FROM file_assets")}

    by_owner: Counter = Counter()
    summary: Counter = Counter()
    for user_id, org, status, kind, key, created, intent, slug in rows:
        okind = ("page" if intent == "host" else "file") if intent else ("page" if slug else "file")
        owner = hashlib.sha256((salt + str(user_id)).encode()).hexdigest()[:8]
        orgtag = hashlib.sha256((salt + str(org)).encode()).hexdigest()[:8] if org else "personal"
        by_owner[(owner, orgtag, okind, status)] += 1
        summary["rows"] += 1
        summary[f"status:{status}"] += 1
        summary[f"output:{okind}"] += 1
        if kind == "html" and okind == "file":
            summary["legacy_html_under_files"] += 1  # the 'HTML appears in Files' screenshot
        if status == "active" and blobs is not None and key not in blobs:
            summary["active_rows_missing_blob"] += 1
    if versions is not None:
        summary["html_without_version_row"] = sum(1 for r in db.execute("SELECT id FROM file_assets WHERE kind='html'") if r[0] not in versions)
    created_vals = [r[5] for r in rows if r[5]]
    return {
        "source_rows_span": [min(created_vals, default=None), max(created_vals, default=None)],
        "summary": dict(summary),
        "blob_listing_given": blobs is not None,
        "buckets": [
            {"owner": o, "org": g, "output": k, "status": s, "count": n}
            for (o, g, k, s), n in sorted(by_owner.items())
        ],
        "orphan_blob_keys": (len(blobs - {r[1] for r in ids.values()}) if blobs is not None else None),
    }


def _has(db: sqlite3.Connection, table: str) -> bool:
    return db.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone() is not None


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sqlite_path")
    ap.add_argument("--source", required=True, help="label only: railway | d1 | standby")
    ap.add_argument("--blobs", help="file of object keys, one per line")
    ap.add_argument("--salt", default=secrets.token_hex(8), help="same salt across sources lets owner tags be compared")
    a = ap.parse_args(argv)
    db = sqlite3.connect(f"file:{a.sqlite_path}?mode=ro", uri=True)
    blobs = {l.strip() for l in open(a.blobs) if l.strip()} if a.blobs else None
    out = {"source": a.source, "salt_note": "owner/org tags are sha256(salt+id)[:8]", **build(db, blobs, a.salt)}
    json.dump(out, sys.stdout, indent=2)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
