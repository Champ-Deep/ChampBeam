#!/usr/bin/env python3
"""Give migrated Clerk password users a Better Auth credential row carrying their old bcrypt hash.

The worker already verifies "$2..." hashes with bcrypt (src/auth/betterAuth.ts), so this is data only.
Dry run by default: prints counts, writes the SQL to --out (mode 600), executes nothing.
Never prints an email or a hash. Idempotent: a user who already has a credential row is skipped.

  python3 import_clerk_passwords.py ~/.hermes/secrets/clerk-prod-users-YYYYMMDD.csv [--db champbeam] [--apply]
  python3 import_clerk_passwords.py --selftest
"""
import argparse
import csv
import json
import os
import re
import subprocess
import sys
import time
import uuid

# The digest is spliced into SQL, so this pattern is the trust boundary for the CSV.
BCRYPT = re.compile(r"^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$")
UUID = re.compile(r"^[0-9a-fA-F-]{36}$")


def plan(rows, users, have_cred, now_ms):
    """rows: CSV dicts. users: {lowercased email: users.id} for active users. have_cred: user ids with a credential row."""
    counts = dict(csv_rows=0, matched=0, unmatched=0, no_password=0, not_bcrypt=0, already=0, to_insert=0)
    have_cred, sql = set(have_cred), []
    for r in rows:
        counts["csv_rows"] += 1
        emails = [r.get("primary_email_address") or ""] + re.split(r"[|,;]", r.get("verified_email_addresses") or "")
        uid = next((users[e.strip().lower()] for e in emails if e.strip().lower() in users), None)
        if not uid:
            counts["unmatched"] += 1
            continue
        counts["matched"] += 1
        digest = (r.get("password_digest") or "").strip()
        if not digest:
            counts["no_password"] += 1  # Google-only users link on their first Google sign-in
        elif not BCRYPT.match(digest):
            counts["not_bcrypt"] += 1
        elif uid in have_cred:
            counts["already"] += 1
        else:
            assert UUID.match(uid), "unexpected users.id shape"
            have_cred.add(uid)
            counts["to_insert"] += 1
            sql.append(
                "INSERT INTO account (id, account_id, provider_id, user_id, password, created_at, updated_at) "
                f"SELECT '{uuid.uuid4()}', '{uid}', 'credential', '{uid}', '{digest}', {now_ms}, {now_ms} "
                f"WHERE NOT EXISTS (SELECT 1 FROM account WHERE user_id = '{uid}' AND provider_id = 'credential');"
            )
    return counts, sql


def d1(db, *args):
    out = subprocess.run(["npx", "wrangler", "d1", "execute", db, "--remote", "--json", *args],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)[0]["results"]


def selftest():
    h = "$2a$10$" + "a" * 53
    u = {f"u{i}@x.com": f"00000000-0000-0000-0000-00000000000{i}" for i in range(1, 6)}
    rows = [
        {"primary_email_address": "U1@x.com", "password_digest": h},  # match is case-insensitive
        {"primary_email_address": "other@x.com", "verified_email_addresses": "a@b.c|u2@x.com", "password_digest": h},
        {"primary_email_address": "u3@x.com", "password_digest": ""},  # Google only
        {"primary_email_address": "u4@x.com", "password_digest": "pbkdf2$x'; DROP TABLE users;--"},
        {"primary_email_address": "u5@x.com", "password_digest": h},  # already has a credential
        {"primary_email_address": "u1@x.com", "password_digest": h},  # duplicate CSV row
        {"primary_email_address": "nobody@x.com", "password_digest": h},
    ]
    counts, sql = plan(rows, u, {u["u5@x.com"]}, 1)
    assert counts == dict(csv_rows=7, matched=6, unmatched=1, no_password=1, not_bcrypt=1, already=2, to_insert=2), counts
    assert len(sql) == 2 and "DROP" not in "".join(sql) and "@" not in "".join(sql)
    print("selftest ok", counts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv", nargs="?")
    ap.add_argument("--db", default="champbeam")
    ap.add_argument("--out", default=os.path.expanduser("~/.hermes/secrets/clerk-password-import.sql"))
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.csv:
        ap.error("csv path required")
    with open(a.csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    if rows and "password_digest" not in rows[0]:
        sys.exit("CSV has no password_digest column: not a Clerk dashboard user export")
    users = {r["e"]: r["id"] for r in d1(a.db, "--command", "SELECT id, lower(email) e FROM users WHERE is_active = 1")}
    have = {r["user_id"] for r in d1(a.db, "--command", "SELECT user_id FROM account WHERE provider_id = 'credential'")}
    counts, sql = plan(rows, users, have, int(time.time() * 1000))
    with os.fdopen(os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
        f.write("\n".join(sql) + "\n")
    print(json.dumps(dict(db=a.db, active_users=len(users), **counts, sql_file=a.out, applied=False)))
    if a.apply and sql:
        d1(a.db, "--file", a.out)
        after = d1(a.db, "--command", "SELECT count(*) n FROM account WHERE provider_id = 'credential'")[0]["n"]
        print(json.dumps(dict(applied=True, credential_rows_now=after, expected=len(have) + counts["to_insert"])))


if __name__ == "__main__":
    main()
