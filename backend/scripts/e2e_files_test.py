"""End-to-end test for the file-hosting feature.

Drives the full upload → finalize → serve flow against a moto S3 server
standing in for Supabase Storage, plus the local Postgres. Bypasses
Clerk auth via a FastAPI dependency override. Exits non-zero on any
failed assertion.

Prereqs:
    pip install 'moto[server]'
    pg_isready  # local Postgres must be up
    alembic upgrade head

Run:
    python scripts/e2e_files_test.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from uuid import uuid4

import boto3
import httpx
from botocore.client import Config
from moto.server import ThreadedMotoServer


# --- 1. Start moto S3 on a free port and wire env BEFORE importing the app ---

_moto = ThreadedMotoServer(port=0)
_moto.start()
_port = _moto._server.socket.getsockname()[1]
S3_ENDPOINT = f"http://127.0.0.1:{_port}"

os.environ["STORAGE_BACKEND"] = "s3"  # exercise the S3 path explicitly
os.environ["SUPABASE_STORAGE_ENDPOINT"] = S3_ENDPOINT
os.environ["SUPABASE_STORAGE_REGION"] = "us-east-1"
os.environ["SUPABASE_STORAGE_ACCESS_KEY_ID"] = "testkey"
os.environ["SUPABASE_STORAGE_SECRET_ACCESS_KEY"] = "testsecret"
os.environ["SUPABASE_STORAGE_BUCKET"] = "files-test"
os.environ["REDIRECT_BASE_URL"] = "http://platform.test"
os.environ["PLATFORM_REDIRECT_HOST"] = "platform.test"
os.environ["DEBUG"] = "false"

# Create the bucket in moto.
_s3 = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT,
    aws_access_key_id="testkey",
    aws_secret_access_key="testsecret",
    region_name="us-east-1",
    config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
)
_s3.create_bucket(Bucket="files-test")

# --- 2. Import the app and override require_auth ---

sys.path.insert(0, ".")

from sqlalchemy import select, delete  # noqa: E402
from app.main import app  # noqa: E402
from app.core.security import TokenData, get_current_user, require_auth  # noqa: E402
from app.db.postgres import async_session_maker  # noqa: E402
from app.models import User, FileAsset, ClickEvent, Domain  # noqa: E402
from app.models.domain import STATUS_ACTIVE as DOMAIN_STATUS_ACTIVE  # noqa: E402


_TEST_USER_ID: str | None = None


async def _ensure_test_user() -> str:
    async with async_session_maker() as session:
        result = await session.execute(select(User).where(User.email == "e2e@test.local"))
        u = result.scalar_one_or_none()
        if u is None:
            u = User(
                id=uuid4(),
                email="e2e@test.local",
                clerk_id=f"clerk_test_{uuid4().hex[:8]}",
            )
            session.add(u)
            await session.commit()
            await session.refresh(u)
        return str(u.id)


def _make_token() -> TokenData:
    return TokenData(user_id=_TEST_USER_ID, email="e2e@test.local")


async def _cleanup() -> None:
    """Remove any FileAsset / ClickEvent / Domain rows belonging to the test user."""
    if not _TEST_USER_ID:
        return
    async with async_session_maker() as session:
        files = (await session.execute(select(FileAsset.id).where(FileAsset.user_id == _TEST_USER_ID))).scalars().all()
        if files:
            await session.execute(delete(ClickEvent).where(ClickEvent.file_id.in_(files)))
        await session.execute(delete(FileAsset).where(FileAsset.user_id == _TEST_USER_ID))
        await session.execute(delete(Domain).where(Domain.user_id == _TEST_USER_ID))
        await session.commit()


# --- 3. Test helpers ---

PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
_failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  {PASS} {label}")
    else:
        print(f"  {FAIL} {label}  {detail}")
        _failures.append(label)


# --- 4. Drive the end-to-end flow ---

async def run() -> int:
    global _TEST_USER_ID
    _TEST_USER_ID = await _ensure_test_user()
    print(f"\nTest user: {_TEST_USER_ID}")

    await _cleanup()
    # init/finalize/status use optional auth (get_current_user); list/delete use
    # require_auth. Override both so this suite drives the authenticated path.
    app.dependency_overrides[require_auth] = _make_token
    app.dependency_overrides[get_current_user] = _make_token

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://platform.test") as client:

        # === T1: upload init for an unsupported type returns 415 ===
        print("\n[T1] reject unsupported content-type")
        r = await client.post("/api/v1/files", json={
            "filename": "evil.exe",
            "content_type": "application/x-msdownload",
            "size_bytes": 1024,
        })
        check("returns 415", r.status_code == 415, f"got {r.status_code}: {r.text}")

        # === T2: upload init for an oversized PDF returns 413 ===
        print("\n[T2] reject oversize file for kind")
        r = await client.post("/api/v1/files", json={
            "filename": "huge.pdf",
            "content_type": "application/pdf",
            "size_bytes": 60 * 1024 * 1024,  # PDF cap is 50 MB
        })
        check("returns 413", r.status_code == 413, f"got {r.status_code}: {r.text}")

        # === T3: upload init for a small PDF returns presigned URL ===
        print("\n[T3] PDF upload happy path: init")
        pdf_bytes = b"%PDF-1.4\nstub-pdf-bytes-for-e2e-test\n%%EOF\n"
        r = await client.post("/api/v1/files", json={
            "filename": "report.pdf",
            "content_type": "application/pdf",
            "size_bytes": len(pdf_bytes),
        })
        check("returns 201", r.status_code == 201, f"got {r.status_code}: {r.text}")
        if r.status_code != 201:
            return 1
        init = r.json()
        pdf_file_id = init["file_id"]
        pdf_short = init["short_code"]
        check("short_code is 8 chars", len(pdf_short) == 8)
        check("serve_mode = stream", init["serve_mode"] == "stream")
        check("presigned_put_url returned", init["presigned_put_url"].startswith(S3_ENDPOINT))

        # === T4: PUT bytes directly to the presigned URL (bypasses backend) ===
        print("\n[T4] PUT bytes to presigned URL")
        async with httpx.AsyncClient() as raw:
            put_resp = await raw.put(
                init["presigned_put_url"],
                content=pdf_bytes,
                headers=init["headers"],
                timeout=10.0,
            )
        check("PUT returns 2xx", 200 <= put_resp.status_code < 300, f"got {put_resp.status_code}: {put_resp.text[:200]}")

        # === T5: finalize confirms the upload ===
        print("\n[T5] finalize")
        r = await client.post(f"/api/v1/files/{pdf_file_id}/finalize")
        check("returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
        final = r.json()
        check("status = active", final["status"] == "active")
        check("size matches", final["size_bytes"] == len(pdf_bytes))
        check("serve_url uses platform host", "platform.test" in final["serve_url"])

        # === T6: GET /f/{code} streams the bytes ===
        print("\n[T6] serve PDF via /f/{code}")
        r = await client.get(f"/f/{pdf_short}", headers={"Host": "platform.test"})
        check("returns 200", r.status_code == 200, f"got {r.status_code}")
        check("body bytes match upload", r.content == pdf_bytes,
              f"sent {len(pdf_bytes)} B, got {len(r.content)} B")
        check("Content-Type = application/pdf", r.headers.get("content-type", "").startswith("application/pdf"),
              f"got {r.headers.get('content-type')}")
        check("X-Content-Type-Options = nosniff",
              r.headers.get("x-content-type-options") == "nosniff")
        check("Content-Disposition is inline",
              "inline" in (r.headers.get("content-disposition") or ""))

        # === T7: ClickEvent recorded with file_id ===
        print("\n[T7] view recorded as ClickEvent")
        async with async_session_maker() as session:
            from uuid import UUID
            ev_res = await session.execute(
                select(ClickEvent).where(ClickEvent.file_id == UUID(pdf_file_id))
            )
            events = ev_res.scalars().all()
            check("exactly one ClickEvent exists", len(events) == 1, f"got {len(events)}")
            if events:
                ev = events[0]
                check("ClickEvent.link_id is NULL", ev.link_id is None)
                check("ClickEvent.file_id is set", str(ev.file_id) == pdf_file_id)
            fa_res = await session.execute(
                select(FileAsset).where(FileAsset.id == UUID(pdf_file_id))
            )
            fa = fa_res.scalar_one()
            check("FileAsset.view_count incremented to 1", fa.view_count == 1, f"got {fa.view_count}")

        # === T8: HTML serve includes CSP ===
        print("\n[T8] HTML upload + serve with CSP")
        html_bytes = b"<!doctype html><body>hi</body>"
        r = await client.post("/api/v1/files", json={
            "filename": "landing.html",
            "content_type": "text/html",
            "size_bytes": len(html_bytes),
        })
        check("init 201", r.status_code == 201)
        if r.status_code == 201:
            h_init = r.json()
            async with httpx.AsyncClient() as raw:
                await raw.put(h_init["presigned_put_url"], content=html_bytes,
                              headers=h_init["headers"], timeout=10.0)
            r = await client.post(f"/api/v1/files/{h_init['file_id']}/finalize")
            check("finalize 200", r.status_code == 200)
            r = await client.get(f"/f/{h_init['short_code']}", headers={"Host": "platform.test"})
            check("serve 200", r.status_code == 200)
            csp = r.headers.get("content-security-policy") or ""
            check("CSP header set", "default-src" in csp, f"got: {csp}")
            check("CSP frame-ancestors none", "frame-ancestors 'none'" in csp)

        # === T9: video defaults to redirect mode ===
        print("\n[T9] video upload uses redirect serve_mode")
        mp4_bytes = b"\x00\x00\x00\x20ftypisom" + b"\x00" * 64  # not a real mp4, just bytes
        r = await client.post("/api/v1/files", json={
            "filename": "talk.mp4",
            "content_type": "video/mp4",
            "size_bytes": len(mp4_bytes),
        })
        if r.status_code != 201:
            check("init 201", False, f"got {r.status_code}: {r.text}")
        else:
            v_init = r.json()
            check("serve_mode = redirect", v_init["serve_mode"] == "redirect")
            async with httpx.AsyncClient() as raw:
                await raw.put(v_init["presigned_put_url"], content=mp4_bytes,
                              headers=v_init["headers"], timeout=10.0)
            await client.post(f"/api/v1/files/{v_init['file_id']}/finalize")
            r = await client.get(f"/f/{v_init['short_code']}", headers={"Host": "platform.test"},
                                 follow_redirects=False)
            check("returns 302", r.status_code == 302, f"got {r.status_code}")
            check("redirect target is presigned URL",
                  S3_ENDPOINT in (r.headers.get("location") or ""),
                  f"got: {r.headers.get('location')}")

        # === T10: BYOD — unknown custom host returns 404, not platform fall-through ===
        print("\n[T10] custom-domain isolation: unknown host returns 404")
        r = await client.get(f"/f/{pdf_short}", headers={"Host": "stranger.example.com"})
        check("returns 404", r.status_code == 404, f"got {r.status_code}")

        # === T11: BYOD — file scoped to an active Domain row is reachable on that host ===
        print("\n[T11] file uploaded against a custom Domain serves on that host")
        async with async_session_maker() as session:
            d = Domain(
                id=uuid4(),
                user_id=_TEST_USER_ID,
                hostname="track.acme.test",
                status=DOMAIN_STATUS_ACTIVE,
                is_primary=False,
            )
            session.add(d)
            await session.commit()
            d_id = str(d.id)
        r = await client.post("/api/v1/files", json={
            "filename": "branded.pdf",
            "content_type": "application/pdf",
            "size_bytes": len(pdf_bytes),
            "domain_id": d_id,
        })
        check("init 201 with domain_id", r.status_code == 201, f"got {r.status_code}: {r.text}")
        if r.status_code == 201:
            b_init = r.json()
            async with httpx.AsyncClient() as raw:
                await raw.put(b_init["presigned_put_url"], content=pdf_bytes,
                              headers=b_init["headers"], timeout=10.0)
            r = await client.post(f"/api/v1/files/{b_init['file_id']}/finalize")
            final = r.json()
            check("finalize returns custom-host serve_url",
                  "track.acme.test" in final.get("serve_url", ""),
                  f"got {final.get('serve_url')}")
            # serve via custom host
            r = await client.get(f"/f/{b_init['short_code']}", headers={"Host": "track.acme.test"})
            check("serve on custom host = 200", r.status_code == 200, f"got {r.status_code}")
            check("body matches", r.content == pdf_bytes)
            # serve on platform default with same short_code = 404 (namespacing)
            r = await client.get(f"/f/{b_init['short_code']}", headers={"Host": "platform.test"})
            check("same short_code on platform default = 404 (namespacing)",
                  r.status_code == 404, f"got {r.status_code}")

        # === T12: list endpoint returns the user's files ===
        print("\n[T12] list endpoint")
        r = await client.get("/api/v1/files")
        check("returns 200", r.status_code == 200)
        files = r.json()
        check("list contains uploaded files", len(files) >= 3, f"got {len(files)}")

        # === T13: delete flips status and the file no longer serves ===
        print("\n[T13] delete + 404 after")
        r = await client.delete(f"/api/v1/files/{pdf_file_id}")
        check("delete returns 204", r.status_code == 204, f"got {r.status_code}")
        r = await client.get(f"/f/{pdf_short}", headers={"Host": "platform.test"})
        check("deleted file returns 404", r.status_code == 404, f"got {r.status_code}")

        # === T14: storage NOT configured → 503 ===
        print("\n[T14] missing storage config → 503")
        from app.core.config import settings as _settings
        # Simulate misconfiguration by clearing one of the secrets and clearing
        # the storage client's lru_cache so the next call rebuilds and trips
        # the "not configured" branch.
        from app.services import storage as _storage_svc
        original = _settings.supabase_storage_endpoint
        _settings.supabase_storage_endpoint = ""
        _storage_svc._client.cache_clear()
        try:
            r = await client.post("/api/v1/files", json={
                "filename": "x.pdf",
                "content_type": "application/pdf",
                "size_bytes": 100,
            })
            check("returns 503 when unconfigured",
                  r.status_code == 503, f"got {r.status_code}: {r.text}")
        finally:
            _settings.supabase_storage_endpoint = original
            _storage_svc._client.cache_clear()

    # === Cleanup ===
    await _cleanup()
    app.dependency_overrides.pop(require_auth, None)
    app.dependency_overrides.pop(get_current_user, None)

    print("\n" + "=" * 60)
    if _failures:
        print(f"\033[31m{len(_failures)} FAILURE(S):\033[0m")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("\033[32mAll end-to-end checks passed.\033[0m")
    return 0


if __name__ == "__main__":
    try:
        code = asyncio.run(run())
    finally:
        _moto.stop()
    sys.exit(code)
