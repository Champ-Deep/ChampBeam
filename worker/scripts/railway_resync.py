#!/usr/bin/env python3
"""Final Railway -> Cloudflare resync for ChampBeam: Postgres -> D1 rows, GridFS -> R2 blobs.

ADDITIVE MERGE, never TRUNCATE. The old runbook (deploy/DNS_RUNBOOK.md) wiped and reloaded the app
tables. That is wrong now: the production Worker has taken writes since the first import (it holds rows
Railway has never seen), so a reload would destroy them. This script only

  * inserts Railway rows whose primary key is missing in D1 (INSERT OR IGNORE),
  * raises the counters view_count / click_count / unique_clicks (and last_*_at) when Railway's are
    higher (MAX wins; shortcut: no baseline exists to add the two sides, so a hit that landed on both
    sides in the same window counts once),
  * copies GridFS files that are missing from R2 or have another size.

It never touches api_keys, the service identity user or anything else already in D1, so the identity
re-provision step of the old runbook is gone. It checks the identity afterwards instead.

Needs only the `railway` CLI (logged in) and `wrangler` (logged in); no Postgres/Mongo driver and no
proxy credentials. Railway's Postgres and MongoDB have no public TCP proxy, so reads go through
`railway ssh` and the container's own environment: no password ever reaches this process or the
terminal. Cloudflare access is wrangler's OAuth login (D1 via `wrangler d1 execute`, R2 via the REST API
with `wrangler auth token`), or CLOUDFLARE_API_TOKEN when set.

Default is a dry plan (read only). `--apply` writes. `--target production` needs `--confirm-production`.

    python3 worker/scripts/railway_resync.py --target staging                  # plan
    python3 worker/scripts/railway_resync.py --target staging --apply --report staging.json
    python3 worker/scripts/railway_resync.py --target staging --undo staging.json   # remove what --apply added
"""

from __future__ import annotations

import argparse
import atexit
import base64
import concurrent.futures as cf
import hashlib
import json
import mimetypes
import os
import re
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_postgres_to_d1 as ex  # TABLE_ORDER, to_sql_literal

WORKER_DIR = Path(__file__).resolve().parent.parent
ACCOUNT_ID = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "ae03bce34fb2cd34756be0003196572f")
TARGETS = {
    "staging": {"db": "champbeam-staging", "d1_id": "c924f4d4-85ea-4671-8c96-478ae229fe4a", "env": ["--env", "staging"], "bucket": "champbeam-files-staging"},
    "production": {"db": "champbeam", "d1_id": "f4adff8c-771e-4e18-b792-dc9f8f3dbd99", "env": [], "bucket": "champbeam-files"},
}
SERVICE_IDENTITY = "service+champ-workspace@championsmail.com"
# Counters that keep moving on Railway while it still serves share.lakeb2b.com.
COUNTERS = {"file_assets": ("view_count", "last_viewed_at"), "link_clicks": ("click_count", "unique_clicks", "last_clicked_at")}
GRIDFS_DB = "champbeam_files"
MAX_FILE_BYTES = 4 * 1024 * 1024


# ---------------------------------------------------------------- pure helpers (unit tested)

def ts_text(value: datetime) -> str:
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def convert(value, pgtype: str):
    """One row_to_json value -> the Python value export_postgres_to_d1.to_sql_literal expects."""
    if value is None:
        return None
    if pgtype in ("json", "jsonb"):
        return json.dumps(value, separators=(",", ":"), ensure_ascii=False)
    if pgtype.startswith("timestamp"):
        return datetime.fromisoformat(value)
    if pgtype == "bytea":
        return bytes.fromhex(value[2:])
    if pgtype == "uuid":
        return value.lower()
    return value


def norm(value):
    """Comparable form of a source (converted) or D1 (raw JSON) value."""
    if isinstance(value, datetime):
        return ts_text(value)
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, (bytes, bytearray)):
        return bytes(value).hex()
    return value


def pk_of(row: dict, pk: list[str]):
    return tuple(norm(row[c]) for c in pk)


def plan_table(src_rows: list[dict], d1_rows: list[dict], cols: list[str], pk: list[str], table: str) -> dict:
    """What a merge would do for one table. d1_rows must carry at least pk + counter columns."""
    d1_by = {pk_of(r, pk): r for r in d1_rows}
    new, bumps, diff_cols, owners = [], [], Counter(), Counter()
    counter_cols = [c for c in COUNTERS.get(table, ()) if c in cols]
    for r in src_rows:
        d = d1_by.get(pk_of(r, pk))
        if d is None:
            new.append(r)
            continue
        for c in cols:
            if c in d and norm(r[c]) != norm(d[c]):
                diff_cols[c] += 1
        if r.get("user_id") and d.get("user_id") and r["user_id"] != d["user_id"]:
            owners[(r["user_id"], d["user_id"])] += 1
        if counter_cols and any(c in d and r[c] is not None and (d[c] is None or norm(r[c]) > norm(d[c])) for c in counter_cols):
            bumps.append(r)
    return {"new": new, "bumps": bumps, "diff_cols": dict(diff_cols), "owners": owners}


def owner_remap(pairs: Counter) -> tuple[dict, list]:
    """Railway user id -> the D1 user id that now owns its rows (placeholder users merged into real ones
    on the Worker side). Ambiguous ids are left out and returned so the operator sees them."""
    targets: dict[str, set] = {}
    for (src_uid, d1_uid) in pairs:
        targets.setdefault(src_uid, set()).add(d1_uid)
    return {k: next(iter(v)) for k, v in targets.items() if len(v) == 1}, sorted(k for k, v in targets.items() if len(v) > 1)


def remap_owners(rows: list[dict], remap: dict) -> int:
    n = 0
    for r in rows:
        if r.get("user_id") in remap:
            r["user_id"] = remap[r["user_id"]]
            n += 1
    return n


def insert_sql(table: str, cols: list[str], rows: list[dict], per_stmt: int = 50) -> list[str]:
    col_sql = ", ".join(f'"{c}"' for c in cols)
    out = []
    for i in range(0, len(rows), per_stmt):
        values = ",\n".join("(" + ", ".join(ex.to_sql_literal(r[c]) for c in cols) + ")" for r in rows[i : i + per_stmt])
        out.append(f'INSERT OR IGNORE INTO "{table}" ({col_sql}) VALUES\n{values};\n')
    return out


def bump_sql(table: str, pk: list[str], row: dict) -> str:
    sets = []
    for c in COUNTERS[table]:
        if c not in row or row[c] is None:
            continue
        lit = ex.to_sql_literal(row[c])
        # last_*_at are text: NULL-safe max. counters: MAX(col, n).
        sets.append(f'"{c}" = MAX(COALESCE("{c}", {lit}), {lit})')
    where = " AND ".join(f'"{c}" = {ex.to_sql_literal(row[c])}' for c in pk)
    return f'UPDATE "{table}" SET {", ".join(sets)} WHERE {where};\n'


def delete_sql(table: str, pk: list[str], keys: list[tuple]) -> list[str]:
    out = []
    for i in range(0, len(keys), 80):
        if len(pk) == 1:
            ids = ", ".join(ex.to_sql_literal(k[0]) for k in keys[i : i + 80])
            out.append(f'DELETE FROM "{table}" WHERE "{pk[0]}" IN ({ids});\n')
        else:
            out += [f'DELETE FROM "{table}" WHERE ' + " AND ".join(f'"{c}" = {ex.to_sql_literal(v)}' for c, v in zip(pk, k)) + ";\n" for k in keys[i : i + 80]]
    return out


def blobs_to_copy(src: list[dict], r2: dict[str, int]) -> list[dict]:
    """GridFS files missing in R2 or stored with another size. Latest upload wins on a repeated filename."""
    latest: dict[str, dict] = {}
    for f in src:
        cur = latest.get(f["filename"])
        if cur is None or f["uploadDate"] > cur["uploadDate"]:
            latest[f["filename"]] = f
    return [f for f in latest.values() if r2.get(f["filename"]) != f["length"]]


def chunk_files(statements: list[str]) -> list[str]:
    """Pack statements into <=4 MB SQL files, each with the FK deferral the exporter uses."""
    files, buf, size = [], [], 0
    for s in statements:
        if buf and size + len(s) > MAX_FILE_BYTES:
            files.append("PRAGMA defer_foreign_keys = true;\n" + "".join(buf))
            buf, size = [], 0
        buf.append(s)
        size += len(s)
    if buf:
        files.append("PRAGMA defer_foreign_keys = true;\n" + "".join(buf))
    return files


# ---------------------------------------------------------------- Railway source (via railway ssh)

CHILDREN: list[subprocess.Popen] = []


@atexit.register
def _reap_children() -> None:
    # An ssh stream left behind keeps reading GridFS into a dead pipe and eats Railway's session limit.
    for p in CHILDREN:
        try:
            os.killpg(p.pid, signal.SIGKILL)  # the wrapper spawns a real `ssh` child that a plain kill() leaves behind
        except ProcessLookupError:
            pass


class Railway:
    def __init__(self, project: str, environment: str):
        if not re.fullmatch(r"[0-9a-f-]{36}", project):  # `railway ssh --project` wants the id, not the name
            listing = json.loads(subprocess.run(["railway", "list", "--json"], capture_output=True, text=True, check=True).stdout)
            project = next(p["id"] for p in listing if p["name"] == project)
        self.base = ["railway", "ssh", "--project", project, "--environment", environment]

    def popen(self, service: str, remote_cmd: str) -> subprocess.Popen:
        # stderr carries only the "Using SSH key from file ..." banner.
        errf = tempfile.TemporaryFile()
        p = subprocess.Popen(self.base + ["--service", service, "--", remote_cmd], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=errf, start_new_session=True)
        p.errf = errf  # type: ignore[attr-defined]
        CHILDREN.append(p)
        return p

    @staticmethod
    def why(p: subprocess.Popen) -> str:
        """Last lines of the session's stderr, for the failure message (the banner and a deprecation warning are noise)."""
        p.errf.seek(0)  # type: ignore[attr-defined]
        lines = [l for l in p.errf.read().decode(errors="replace").splitlines() if l.strip() and not l.startswith(("Using SSH", "warning:", "  "))]
        return f"exit {p.returncode}: " + " | ".join(lines[-2:])[:200]

    def run(self, service: str, remote_cmd: str) -> str:
        for attempt in range(4):  # railway ssh sometimes exits 1 on start-up
            p = self.popen(service, remote_cmd)
            out = p.stdout.read().decode("utf-8")
            if p.wait() == 0:
                return out.replace("\r\n", "\n")
            time.sleep(4 * (attempt + 1))
        raise RuntimeError(f"railway ssh {service} failed four times, last {self.why(p)}")

    def postgres(self, wanted: list[str]) -> tuple[dict, dict, dict]:
        """(types[table][col], rows[table] -> [dict], counts of tables we do not migrate)."""
        script = (
            "unset PGHOST; q() { psql -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -v ON_ERROR_STOP=1 -At -c \"$1\"; }; "
            f"WANT=' {' '.join(wanted)} '; "
            "echo '@@TYPES'; q \"select table_name||'|'||column_name||'|'||data_type from information_schema.columns where table_schema='public'\"; "
            "for t in $(q \"select tablename from pg_tables where schemaname='public' order by 1\"); do "
            "case \"$WANT\" in *\" $t \"*) echo \"@@T $t\"; q \"select row_to_json(x) from (select * from \\\"$t\\\") x\";; "
            "*) echo \"@@C $t $(q \"select count(*) from \\\"$t\\\"\")\";; esac; done; echo @@END"
        )
        out = self.run("Postgres", script)
        types: dict[str, dict[str, str]] = {}
        rows: dict[str, list[dict]] = {}
        skipped: dict[str, int] = {}
        mode, table, ended = None, None, False
        for line in out.splitlines():
            if line == "@@TYPES":
                mode = "types"
            elif line.startswith("@@T "):
                mode, table = "rows", line[4:]
                rows[table] = []
            elif line.startswith("@@C "):
                _, t, n = line.split(" ")
                skipped[t] = int(n)
                mode = None
            elif line == "@@END":
                ended = True
            elif mode == "types" and line.count("|") == 2:
                t, c, ty = line.split("|")
                types.setdefault(t, {})[c] = ty
            elif mode == "rows" and line:
                rows[table].append(json.loads(line))
        if not ended:
            raise RuntimeError("Postgres read ended early (no @@END marker)")
        return types, rows, skipped

    def gridfs_list(self) -> list[dict]:
        js = (
            'db.fs.files.find().sort({_id:1}).forEach(f => print(JSON.stringify({id: f._id.toString(), filename: f.filename,'
            " length: Number(f.length), uploadDate: f.uploadDate.toISOString()})));"
        )
        out = self.run("MongoDB", f'mongosh --quiet "$MONGO_URL/{GRIDFS_DB}?authSource=admin" --eval {shlex.quote(js)}')
        files = [json.loads(l) for l in out.splitlines() if l.startswith("{")]
        for f in files:
            if not re.fullmatch(r"[0-9a-f]{24}", f["id"]):
                raise RuntimeError(f"unexpected GridFS _id format: {f['id'][:30]}")
        return files

    def gridfs_stream(self, ids: list[str]):
        # Measured 22 Nov: a session whose command line carries 30 or more ids (about 1.1 KB) is cut after ~15 MB
        # with exit 0 and no error, 16 ids (0.7 KB) stream fine. Keep the batches small and verify every file.
        for i in range(0, len(ids), 12):
            yield from self._gridfs_stream(ids[i : i + 12])

    def _gridfs_stream(self, ids: list[str], attempts: int = 4):
        """Yield (id, bytes) for each file id, streamed as base64 lines over one ssh session. A session that
        dies (Railway refuses some concurrent sessions with exit 1) is restarted for the files not yet seen."""
        pending = list(ids)
        for attempt in range(attempts):
            js = (
                f"for (const h of {json.dumps(pending)}) {{ const f = db.fs.files.findOne({{_id: ObjectId(h)}});"
                ' print("@@F\\t" + h); db.fs.chunks.find({files_id: f._id}).sort({n: 1}).forEach(c => print(c.data.toString("base64"))); print("@@E"); }'
            )
            p = self.popen("MongoDB", f'mongosh --quiet "$MONGO_URL/{GRIDFS_DB}?authSource=admin" --eval {shlex.quote(js)}')
            cur, parts = None, []
            for raw in p.stdout:
                line = raw.rstrip(b"\r\n")
                if line.startswith(b"@@F\t"):
                    cur, parts = line[4:].decode(), []
                elif line == b"@@E":
                    yield cur, b"".join(parts)
                    pending.remove(cur)
                    cur = None
                elif cur is not None and line:
                    parts.append(base64.b64decode(line))
            if p.wait() == 0 and not pending:
                return
            last = self.why(p)
            time.sleep(5 * (attempt + 1))
        raise RuntimeError(f"GridFS stream ended early: {len(pending)}/{len(ids)} files left after {attempts} sessions, last {last}")


# ---------------------------------------------------------------- Cloudflare target

HELPER_JS = """export default { async fetch(req, env) {
  if (req.headers.get("x-token") !== env.TOKEN) return new Response("no", { status: 403 });
  const key = new TextDecoder().decode(Uint8Array.from(atob(req.headers.get("x-key")), c => c.charCodeAt(0)));
  if (req.method === "DELETE") { await env.B.delete(key); return new Response("ok"); }
  const o = await env.B.put(key, req.body, { httpMetadata: { contentType: req.headers.get("content-type") || "application/octet-stream" } });
  return Response.json({ etag: o.etag });
} };"""


class BindingHelper:
    def __init__(self, bucket: str):
        self.token = base64.b16encode(os.urandom(12)).decode()
        self.dir = tempfile.mkdtemp(prefix="r2helper-")
        Path(self.dir, "worker.js").write_text(HELPER_JS)
        Path(self.dir, "wrangler.jsonc").write_text(json.dumps({
            "name": "champbeam-resync-helper", "main": "worker.js", "compatibility_date": "2026-10-01",
            "r2_buckets": [{"binding": "B", "bucket_name": bucket}], "vars": {"TOKEN": self.token}}))
        self.port = 38000 + os.getpid() % 1000
        self.proc = subprocess.Popen(["npx", "wrangler", "dev", "--remote", "--port", str(self.port), "--ip", "127.0.0.1"], cwd=self.dir,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        deadline = time.time() + 120
        for line in self.proc.stdout:
            if "Ready on" in line:
                threading.Thread(target=lambda: [None for _ in self.proc.stdout], daemon=True).start()  # drain so the pipe never fills
                return
            if time.time() > deadline or self.proc.poll() is not None:
                break
        self.stop()
        raise RuntimeError("wrangler dev --remote helper did not start")

    def put(self, key: str, body: bytes, content_type: str) -> str:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/", data=body, method="PUT",
                                     headers={"x-token": self.token, "x-key": base64.b64encode(key.encode()).decode(), "Content-Type": content_type, "User-Agent": "champbeam-resync/1"})
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)["etag"]

    def delete(self, key: str) -> None:
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/", method="DELETE", headers={"x-token": self.token, "x-key": base64.b64encode(key.encode()).decode(), "User-Agent": "champbeam-resync/1"})
        urllib.request.urlopen(req, timeout=60).read()

    def stop(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.proc.kill()

class Cloudflare:
    def __init__(self, target: dict):
        self.t = target
        self._tok, self._tok_at = None, 0.0
        self._helper, self._helper_lock = None, threading.Lock()

    # D1 through wrangler (OAuth login)
    def _wrangler(self, *args: str) -> str:
        p = subprocess.run(["npx", "wrangler", "d1", "execute", self.t["db"], "--remote", *args, *self.t["env"]], cwd=WORKER_DIR, capture_output=True, text=True)
        if p.returncode != 0 or '"error"' in p.stdout[:80]:
            raise RuntimeError(f"wrangler d1 execute failed: {(p.stdout + p.stderr)[:500]}")
        return p.stdout

    def query(self, sql: str) -> list[dict]:
        # REST instead of `wrangler d1 execute --json`: no npx start-up per call (about 4 s each).
        url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/d1/database/{self.t['d1_id']}/query"
        req = urllib.request.Request(url, data=json.dumps({"sql": sql}).encode(), method="POST", headers={"Authorization": f"Bearer {self.token()}", "Content-Type": "application/json"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)["result"][0]["results"]
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt < 3:
                    self._tok = None
                    req.headers["Authorization"] = f"Bearer {self.token()}"
                    continue
                if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"D1 query failed {e.code}: {e.read()[:300]!r}") from None

    def query_all(self, table: str, cols: list[str], page: int = 5000) -> list[dict]:
        col_sql = ", ".join(f'"{c}"' for c in cols)
        rows: list[dict] = []
        while True:
            got = self.query(f'SELECT {col_sql} FROM "{table}" ORDER BY rowid LIMIT {page} OFFSET {len(rows)}')
            rows += got
            if len(got) < page:
                return rows

    def counts(self, tables: list[str]) -> dict[str, int]:
        # one query: D1 rejects a compound SELECT of more than a handful of terms, scalar subqueries are fine
        row = self.query("SELECT " + ", ".join(f'(SELECT count(*) FROM "{t}") AS "{t}"' for t in tables))[0]
        return {t: row[t] for t in tables}

    def execute_sql(self, statements: list[str], workdir: Path) -> int:
        n = 0
        for i, body in enumerate(chunk_files(statements), 1):
            path = workdir / f"resync-{os.getpid()}-{i:04d}.sql"
            path.write_text(body, encoding="utf-8")
            try:
                self._wrangler("--file", str(path))
            finally:
                path.unlink(missing_ok=True)
            n += 1
        return n

    def schema(self) -> dict[str, dict]:
        rows = self.query(
            "SELECT m.name AS t, p.name AS c, p.pk AS pk FROM sqlite_master m JOIN pragma_table_info(m.name) p "
            "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '_cf_%' ORDER BY m.name, p.cid"
        )
        out: dict[str, dict] = {}
        for r in rows:
            e = out.setdefault(r["t"], {"cols": [], "pk": []})
            e["cols"].append(r["c"])
            if r["pk"]:
                e["pk"].append((r["pk"], r["c"]))
        for e in out.values():
            e["pk"] = [c for _, c in sorted(e["pk"])]
        return out

    # R2 through the REST API
    def token(self) -> str:
        if os.environ.get("CLOUDFLARE_API_TOKEN"):
            return os.environ["CLOUDFLARE_API_TOKEN"]
        if self._tok is None or time.time() - self._tok_at > 600:
            p = subprocess.run(["npx", "wrangler", "auth", "token"], cwd=WORKER_DIR, capture_output=True, text=True, check=True)
            self._tok, self._tok_at = p.stdout.strip().splitlines()[-1], time.time()
        return self._tok

    def r2(self, method: str, path: str, data: bytes | None = None, content_type: str | None = None):
        url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/r2/buckets/{self.t['bucket']}/{path}"
        headers = {"Authorization": f"Bearer {self.token()}"}
        if content_type:
            headers["Content-Type"] = content_type
        for attempt in range(7):
            headers["Authorization"] = f"Bearer {self.token()}"
            try:
                with urllib.request.urlopen(urllib.request.Request(url, data=data, method=method, headers=headers), timeout=300) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                if e.code == 401 and attempt < 6:  # wrangler's OAuth token expired mid-run (seen after about 20 minutes)
                    self._tok = None
                    continue
                if e.code in (429, 500, 502, 503, 504) and attempt < 6:
                    time.sleep(min(60, float(e.headers.get("Retry-After") or 2 ** (attempt + 1))))
                    continue
                raise RuntimeError(f"R2 {method} {path[:60]} -> {e.code}") from None
            except (urllib.error.URLError, TimeoutError):
                if attempt == 6:
                    raise
                time.sleep(2 ** attempt)

    def r2_list(self) -> dict[str, int]:
        out: dict[str, int] = {}
        cursor = None
        while True:
            q = "objects?per_page=1000" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
            d = self.r2("GET", q)
            for o in d["result"]:
                out[o["key"]] = int(o["size"])
            cursor = (d.get("result_info") or {}).get("cursor")
            if not cursor or not d["result"]:
                return out

    def r2_put(self, key: str, body: bytes, content_type: str) -> str:
        if ".." in key:  # the REST API's edge refuses ".." in the path with 403 (keys like "deck.pptx...pptx" exist)
            return self.binding_put(key, body, content_type)
        d = self.r2("PUT", "objects/" + urllib.parse.quote(key, safe=""), body, content_type)
        return d["result"]["etag"]

    def binding_put(self, key: str, body: bytes, content_type: str) -> str:
        """Write through a throwaway `wrangler dev --remote` Worker bound to the target bucket. Lives only for this run."""
        with self._helper_lock:
            if self._helper is None:
                self._helper = BindingHelper(self.t["bucket"])
        return self._helper.put(key, body, content_type)

    def binding_delete(self, key: str) -> None:
        with self._helper_lock:
            if self._helper is None:
                self._helper = BindingHelper(self.t["bucket"])
        self._helper.delete(key)

    def close(self) -> None:
        if self._helper:
            self._helper.stop()

    def r2_delete(self, key: str) -> None:
        self.r2("DELETE", "objects/" + urllib.parse.quote(key, safe=""))


# ---------------------------------------------------------------- phases

def read_source(rw: Railway, schema: dict) -> tuple[dict, dict, dict]:
    """rows[table] converted for D1, plus the Postgres-only table counts."""
    wanted = [t for t in ex.TABLE_ORDER if t in schema]
    types, raw, skipped = rw.postgres(wanted)
    rows: dict[str, list[dict]] = {}
    cols_by: dict[str, list[str]] = {}
    for t in wanted:
        if t not in raw:
            continue
        cols = [c for c in schema[t]["cols"] if c in types[t]]
        cols_by[t] = cols
        rows[t] = [{c: convert(r.get(c), types[t][c]) for c in cols} for r in raw[t]]
    return rows, cols_by, skipped


def mime_by_key(rows: dict) -> dict[str, str]:
    out = {r["storage_key"]: r["mime_type"] for r in rows.get("file_assets", []) if r.get("storage_key") and r.get("mime_type")}
    for v in rows.get("file_versions", []):
        parent = next((a for a in rows.get("file_assets", []) if a["id"] == v["file_id"]), None)
        if v.get("storage_key") and parent and parent.get("mime_type"):
            out.setdefault(v["storage_key"], parent["mime_type"])
    return out


def copy_blobs(cf_: Cloudflare, rw: Railway, todo: list[dict], mimes: dict[str, str], parallel: int, log) -> dict:
    by_id = {f["id"]: f for f in todo}
    ids = sorted(by_id, key=lambda i: -by_id[i]["length"])
    lanes = [ids[i::parallel] for i in range(parallel)]
    done, bad = [], []

    def lane(lane_ids: list[str]):
        if not lane_ids:
            return
        time.sleep(3 * lanes.index(lane_ids))  # stagger session start-up
        try:
            for fid, data in rw.gridfs_stream(lane_ids):
                f = by_id[fid]
                try:
                    if len(data) != f["length"]:
                        raise RuntimeError(f"streamed {len(data)} bytes, fs.files says {f['length']}")
                    ctype = mimes.get(f["filename"]) or mimetypes.guess_type(f["filename"])[0] or "application/octet-stream"
                    etag = cf_.r2_put(f["filename"], data, ctype)
                    if etag.strip('"') != hashlib.md5(data).hexdigest():
                        raise RuntimeError("R2 etag differs from local md5")
                except Exception as e:  # one bad file must not abort the run: it is reported and the next run retries it
                    bad.append({"key": f["filename"], "why": str(e)[:200]})
                    continue
                done.append({"key": f["filename"], "bytes": len(data)})
                log(f"  copied {len(done)}/{len(todo)} {len(data)} B")
        except Exception as e:  # the ssh stream broke: files not yet seen stay un-copied, a re-run picks them up
            bad.append({"key": f"lane of {len(lane_ids)} files", "why": str(e)[:200]})

    with cf.ThreadPoolExecutor(max_workers=parallel) as pool:
        for fut in [pool.submit(lane, l) for l in lanes]:
            fut.result()
    return {"copied": done, "bad": bad}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--target", choices=TARGETS, required=True)
    ap.add_argument("--apply", action="store_true", help="write to D1 and R2 (default: read-only plan)")
    ap.add_argument("--confirm-production", action="store_true", help="required for --apply on production")
    ap.add_argument("--skip-blobs", action="store_true")
    ap.add_argument("--skip-rows", action="store_true")
    ap.add_argument("--deep-diff", action="store_true", help="also fetch every D1 column to report which columns differ on overlapping rows (slower)")
    ap.add_argument("--parallel", type=int, default=3, help="concurrent GridFS streams")
    ap.add_argument("--project", default="ChampBeam")
    ap.add_argument("--environment", default="production")
    ap.add_argument("--report", help="write the JSON report here")
    ap.add_argument("--undo", metavar="REPORT", help="staging only: delete the rows and objects a previous --apply report added")
    a = ap.parse_args()

    if a.apply and a.target == "production" and not a.confirm_production:
        sys.exit("refusing to write to production without --confirm-production")
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))  # run the finally/atexit cleanups on pkill too
    t0 = time.time()

    def log(msg: str) -> None:
        print(f"[{time.time() - t0:7.1f}s] {msg}", flush=True)

    target = Cloudflare(TARGETS[a.target])
    scratch = Path(os.environ.get("TMPDIR", "/tmp"))

    if a.undo:
        if a.target != "staging":
            sys.exit("--undo is staging only: on production it would delete rows the Worker wrote since")
        rep = json.loads(Path(a.undo).read_text())
        schema = target.schema()
        stmts: list[str] = []
        for t in reversed(ex.TABLE_ORDER):
            keys = [tuple(k) for k in rep["inserted_keys"].get(t, [])]
            if keys:
                stmts += delete_sql(t, schema[t]["pk"], keys)
        if stmts:
            target.execute_sql(stmts, scratch)  # deleting a key that never got inserted is a no-op
        def drop(key: str) -> None:
            try:
                target.r2_delete(key)
            except RuntimeError:  # never written (copy stopped early) or a ".." key the REST path refuses: handled below
                if ".." in key:
                    target.binding_delete(key)

        with cf.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(drop, rep.get("r2_keys_added", [])))
        target.close()
        log(f"undo done: {sum(len(v) for v in rep['inserted_keys'].values())} rows, {len(rep.get('r2_keys_added', []))} objects removed")
        return 0

    rw = Railway(a.project, a.environment)
    prev = json.loads(Path(a.report).read_text()) if a.report and Path(a.report).exists() else {}

    def write_report() -> None:
        # Written before any write as well as at the end: --undo needs the keys even if a run dies half way.
        # A re-run into the same file keeps the keys the earlier run added (it finds nothing new to insert).
        if a.report:
            for t, keys in (prev.get("inserted_keys") or {}).items():
                seen = {tuple(k) for k in report["inserted_keys"].get(t, [])}
                report["inserted_keys"][t] = report["inserted_keys"].get(t, []) + [k for k in keys if tuple(k) not in seen]
            report["r2_keys_added"] = sorted(set(report.get("r2_keys_added", [])) | set(prev.get("r2_keys_added", [])))
            Path(a.report).write_text(json.dumps(report, indent=1))

    report: dict = {"target": a.target, "apply": a.apply, "started": datetime.now(timezone.utc).isoformat(), "tables": {}, "inserted_keys": {}, "tables_were_applied": False}

    # ---- rows
    if not a.skip_rows:
        log("reading D1 schema")
        schema = target.schema()
        log("reading Railway Postgres through railway ssh")
        src, cols_by, pg_only = read_source(rw, schema)
        report["postgres_only_tables_not_migrated"] = pg_only
        log(f"  {sum(len(v) for v in src.values())} source rows in {len(src)} tables")
        before = target.counts(list(src))
        plans = {}
        for t in ex.TABLE_ORDER:
            if t not in src:
                continue
            pk, cols = schema[t]["pk"], cols_by[t]
            need = list(dict.fromkeys(pk + [c for c in COUNTERS.get(t, ()) if c in cols] + (["user_id"] if "user_id" in cols else []) + (cols if a.deep_diff else [])))
            d1_rows = target.query_all(t, need) if src[t] else []
            plans[t] = plan_table(src[t], d1_rows, cols, pk, t)
        owners = Counter()
        for p in plans.values():
            owners.update(p["owners"])
        remap, ambiguous = owner_remap(owners)
        # A Railway row created after the first import may belong to a placeholder user the Worker side merged away.
        remapped = {t: remap_owners(p["new"], remap) for t, p in plans.items()}
        report["owner_remap"] = {"railway_user_to_d1_user": len(remap), "ambiguous_railway_users": ambiguous, "new_rows_re_owned": {t: n for t, n in remapped.items() if n}}
        log("planned: " + (", ".join(f"{t}+{len(p['new'])}" for t, p in plans.items() if p["new"]) or "nothing to insert"))

        if a.apply:
            report["inserted_keys"] = {t: [list(pk_of(r, schema[t]["pk"])) for r in p["new"]] for t, p in plans.items()}
            write_report()
            stmts = []
            for t in ex.TABLE_ORDER:
                p = plans.get(t)
                if not p:
                    continue
                stmts += insert_sql(t, cols_by[t], p["new"])
                stmts += [bump_sql(t, schema[t]["pk"], r) for r in p["bumps"]]
            n_files = target.execute_sql(stmts, scratch) if stmts else 0
            report["tables_were_applied"] = True
            log(f"D1 applied in {n_files} file(s)")

        after = target.counts(list(src))
        for t, p in plans.items():
            pk = schema[t]["pk"]
            keys_after = {pk_of(r, pk) for r in target.query_all(t, pk)} if src[t] else set()
            missing = [k for k in (pk_of(r, pk) for r in src[t]) if k not in keys_after]
            report["tables"][t] = {
                "railway_rows": len(src[t]),
                "target_before": before[t],
                "target_after": after[t],
                "new_rows": len(p["new"]),
                "counter_bumps": len(p["bumps"]),
                "railway_keys_missing_in_target_after": len(missing),
                "target_only_rows": after[t] - (len(src[t]) - len(missing)),
                "overlap_columns_differing": p["diff_cols"],
            }
        ident = target.query(f"SELECT id, is_active FROM users WHERE lower(email) = '{SERVICE_IDENTITY}'")
        keys = target.query(f"SELECT count(*) AS n FROM api_keys WHERE user_id IN (SELECT id FROM users WHERE lower(email) = '{SERVICE_IDENTITY}') AND revoked_at IS NULL")
        report["service_identity"] = {"in_source": any(str(r.get("email", "")).lower() == SERVICE_IDENTITY for r in src.get("users", [])), "in_target": bool(ident), "active": bool(ident and ident[0]["is_active"]), "live_api_keys": keys[0]["n"]}
        log("rows done")

    # ---- blobs
    if not a.skip_blobs:
        log("listing GridFS and R2")
        files = rw.gridfs_list()
        r2_before = target.r2_list()
        todo = blobs_to_copy(files, r2_before)
        log(f"  GridFS {len(files)} files / {sum(f['length'] for f in files)} B; R2 {len(r2_before)} objects; to copy {len(todo)} files / {sum(f['length'] for f in todo)} B")
        copied = {"copied": [], "bad": []}
        if a.apply and todo:
            report["r2_keys_added"] = [f["filename"] for f in todo]  # journal: undo deletes these
            write_report()
            mimes = mime_by_key(src) if not a.skip_rows else {}
            try:
                copied = copy_blobs(target, rw, todo, mimes, a.parallel, log)
            finally:
                target.close()
        r2_after = target.r2_list()
        names = {f["filename"]: f["length"] for f in files}
        report["blobs"] = {
            "gridfs_files": len(files),
            "gridfs_bytes": sum(f["length"] for f in files),
            "r2_objects_before": len(r2_before),
            "r2_bytes_before": sum(r2_before.values()),
            "r2_objects_after": len(r2_after),
            "r2_bytes_after": sum(r2_after.values()),
            "gridfs_names_present_in_r2_with_same_size": sum(1 for k, n in names.items() if r2_after.get(k) == n),
            "gridfs_bytes_present_in_r2": sum(n for k, n in names.items() if r2_after.get(k) == n),
            "copied_files": len(copied["copied"]),
            "copied_bytes": sum(c["bytes"] for c in copied["copied"]),
            "failed": copied["bad"],
            "r2_target_only_objects": len(set(r2_after) - set(names)),
        }
        log("blobs done")

    report["duration_seconds"] = round(time.time() - t0, 1)
    ok = all(v["railway_keys_missing_in_target_after"] == 0 for v in report["tables"].values()) and not report.get("blobs", {}).get("failed")
    if "blobs" in report:
        ok = ok and report["blobs"]["gridfs_names_present_in_r2_with_same_size"] == report["blobs"]["gridfs_files"]
    report["all_railway_data_present_in_target"] = ok
    write_report()
    print(json.dumps({k: v for k, v in report.items() if k not in ("inserted_keys", "r2_keys_added")}, indent=1))
    # A plan (no --apply) is expected to report differences: it only fails on a real error above.
    return 0 if (ok or not a.apply) else 1


if __name__ == "__main__":
    sys.exit(main())
