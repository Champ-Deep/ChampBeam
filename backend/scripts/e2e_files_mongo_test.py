"""End-to-end test for the MongoDB GridFS storage backend + anonymous uploads.

Drives the full guest flow (init -> PUT bytes to the backend blob endpoint ->
finalize with owner_token -> serve -> "seen?" status), size-cap rejection,
auto-expiry (lazy 410 + sweeper), and the authenticated path, with bytes
stored in GridFS instead of disk/S3. Exits non-zero on any failed assertion.

Prereqs:
    pip install pymongo
    a running mongod   (export MONGO_URL, default mongodb://localhost:27017)
    pg_isready ; alembic upgrade head

Run:
    MONGO_URL=mongodb://localhost:27017 python scripts/e2e_files_mongo_test.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from datetime import datetime, timedelta
from uuid import UUID, uuid4

import httpx

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
MONGO_DB = "champbeam_files_e2e"

os.environ["STORAGE_BACKEND"] = "mongo"
os.environ["MONGO_URL"] = MONGO_URL
os.environ["MONGO_DB"] = MONGO_DB
os.environ["ANON_FILE_TTL_SECONDS"] = "86400"
os.environ["REDIRECT_BASE_URL"] = "http://platform.test"
os.environ["PLATFORM_REDIRECT_HOST"] = "platform.test"
os.environ["DEBUG"] = "false"

sys.path.insert(0, ".")

from pymongo import MongoClient  # noqa: E402
from sqlalchemy import delete, select, update  # noqa: E402
from app.main import app  # noqa: E402
from app.core.security import TokenData, get_current_user, require_auth  # noqa: E402
from app.db.postgres import async_session_maker  # noqa: E402
from app.models import ClickEvent, FileAsset, User  # noqa: E402
from app.services.file_expiry import sweep_expired  # noqa: E402

_mongo = MongoClient(MONGO_URL)
_TEST_USER_ID: str | None = None
_created: list[str] = []


def _gridfs_count() -> int:
    return _mongo[MONGO_DB]["fs.files"].count_documents({})


async def _ensure_test_user() -> str:
    async with async_session_maker() as session:
        result = await session.execute(select(User).where(User.email == "e2e-mongo@test.local"))
        u = result.scalar_one_or_none()
        if u is None:
            u = User(id=uuid4(), email="e2e-mongo@test.local", clerk_id=f"clerk_mongo_{uuid4().hex[:8]}")
            session.add(u)
            await session.commit()
            await session.refresh(u)
        return str(u.id)


def _make_token() -> TokenData:
    return TokenData(user_id=_TEST_USER_ID, email="e2e-mongo@test.local")


async def _cleanup() -> None:
    async with async_session_maker() as session:
        ids = [UUID(i) for i in _created]
        if ids:
            await session.execute(delete(ClickEvent).where(ClickEvent.file_id.in_(ids)))
            await session.execute(delete(FileAsset).where(FileAsset.id.in_(ids)))
        if _TEST_USER_ID:
            files = (await session.execute(select(FileAsset.id).where(FileAsset.user_id == _TEST_USER_ID))).scalars().all()
            if files:
                await session.execute(delete(ClickEvent).where(ClickEvent.file_id.in_(files)))
            await session.execute(delete(FileAsset).where(FileAsset.user_id == _TEST_USER_ID))
        await session.commit()


PASS = "\033[32mPASS\033[0m"
FAIL = "\033[31mFAIL\033[0m"
_failures: list[str] = []


def check(label: str, cond: bool, detail: str = "") -> None:
    if cond:
        print(f"  {PASS} {label}")
    else:
        print(f"  {FAIL} {label}  {detail}")
        _failures.append(label)


async def run() -> int:
    global _TEST_USER_ID
    # wait for mongo
    for _ in range(40):
        try:
            _mongo.admin.command("ping")
            break
        except Exception:
            await asyncio.sleep(0.5)
    else:
        print("mongo did not become ready")
        return 1

    _TEST_USER_ID = await _ensure_test_user()
    print(f"\nMongo: {MONGO_URL}/{MONGO_DB}\nTest user: {_TEST_USER_ID}")
    await _cleanup()

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://platform.test") as client:

        # === T1: anonymous init ===
        print("\n[T1] guest upload init (no auth)")
        pdf = b"%PDF-1.4\nmongo-anon-e2e\n%%EOF\n"
        r = await client.post("/api/v1/files", json={
            "filename": "report.pdf", "content_type": "application/pdf", "size_bytes": len(pdf),
        })
        check("returns 201", r.status_code == 201, f"got {r.status_code}: {r.text}")
        if r.status_code != 201:
            return 1
        init = r.json()
        _created.append(init["file_id"])
        check("upload_via_backend is true", init["upload_via_backend"] is True)
        check("upload url is the blob endpoint", "blob?token=" in init["presigned_put_url"])
        check("owner_token returned", bool(init.get("owner_token")))
        check("serve_mode = stream", init["serve_mode"] == "stream")

        # === T2: PUT bytes -> lands in GridFS ===
        print("\n[T2] PUT bytes to blob endpoint -> GridFS")
        before = _gridfs_count()
        put = await client.put(init["presigned_put_url"], content=pdf, headers=init["headers"])
        check("PUT returns 204", put.status_code == 204, f"got {put.status_code}: {put.text}")
        check("a GridFS file was created", _gridfs_count() == before + 1, f"{before} -> {_gridfs_count()}")

        # === T3: bad token -> 403 ===
        print("\n[T3] blob PUT with bad token -> 403")
        bad = await client.put(f"/api/v1/files/{init['file_id']}/blob?token=nope.deadbeef", content=b"x")
        check("returns 403", bad.status_code == 403, f"got {bad.status_code}")

        # === T4: finalize with owner_token ===
        print("\n[T4] finalize with owner_token")
        r = await client.post(f"/api/v1/files/{init['file_id']}/finalize",
                              json={"owner_token": init["owner_token"]})
        check("returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
        check("status = active", r.json().get("status") == "active")
        check("size matches", r.json().get("size_bytes") == len(pdf))

        # === T5: serve streams from GridFS + records a view ===
        print("\n[T5] serve via /f/{code} (streamed from GridFS)")
        r = await client.get(f"/f/{init['short_code']}", headers={"Host": "platform.test"})
        check("returns 200", r.status_code == 200, f"got {r.status_code}")
        check("body matches upload", r.content == pdf, f"sent {len(pdf)} B, got {len(r.content)} B")

        # === T6: "seen?" status ===
        print("\n[T6] status shows seen=true after a view")
        r = await client.get(f"/api/v1/files/{init['file_id']}/status",
                             params={"owner_token": init["owner_token"]})
        check("returns 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
        st = r.json()
        check("seen = true", st.get("seen") is True)
        check("view_count = 1", st.get("view_count") == 1, f"got {st.get('view_count')}")

        # === T7: declared-size cap enforced ===
        print("\n[T7] over-size blob PUT -> 413")
        r = await client.post("/api/v1/files", json={
            "filename": "small.pdf", "content_type": "application/pdf", "size_bytes": 10,
        })
        cap_init = r.json()
        _created.append(cap_init["file_id"])
        put = await client.put(cap_init["presigned_put_url"], content=b"x" * 50, headers=cap_init["headers"])
        check("PUT returns 413", put.status_code == 413, f"got {put.status_code}: {put.text}")

        # === T8: lazy expiry -> 410 ===
        print("\n[T8] expired file serves 410")
        async with async_session_maker() as session:
            await session.execute(
                update(FileAsset).where(FileAsset.id == UUID(init["file_id"]))
                .values(expires_at=datetime.utcnow() - timedelta(hours=1))
            )
            await session.commit()
        r = await client.get(f"/f/{init['short_code']}", headers={"Host": "platform.test"})
        check("expired serve -> 410", r.status_code == 410, f"got {r.status_code}")

        # === T9: sweeper reclaims expired files (blob removed from GridFS) ===
        print("\n[T9] sweeper reclaims expired files")
        gpdf = b"%PDF-1.4 mongo-sweep %%EOF"
        r = await client.post("/api/v1/files", json={
            "filename": "sweep.pdf", "content_type": "application/pdf", "size_bytes": len(gpdf),
        })
        s_init = r.json()
        _created.append(s_init["file_id"])
        await client.put(s_init["presigned_put_url"], content=gpdf, headers=s_init["headers"])
        await client.post(f"/api/v1/files/{s_init['file_id']}/finalize", json={"owner_token": s_init["owner_token"]})
        count_before_sweep = _gridfs_count()
        async with async_session_maker() as session:
            await session.execute(
                update(FileAsset).where(FileAsset.id == UUID(s_init["file_id"]))
                .values(expires_at=datetime.utcnow() - timedelta(hours=1))
            )
            await session.commit()
        swept = await sweep_expired()
        check("sweeper reclaimed at least one file", swept >= 1, f"swept={swept}")
        check("GridFS blob count dropped", _gridfs_count() < count_before_sweep,
              f"{count_before_sweep} -> {_gridfs_count()}")

        # === T10: authenticated upload on mongo backend ===
        print("\n[T10] authenticated upload on mongo backend")
        app.dependency_overrides[get_current_user] = _make_token
        app.dependency_overrides[require_auth] = _make_token
        try:
            apdf = b"%PDF-1.4 authed-mongo %%EOF"
            r = await client.post("/api/v1/files", json={
                "filename": "owned.pdf", "content_type": "application/pdf", "size_bytes": len(apdf),
            })
            a_init = r.json()
            _created.append(a_init["file_id"])
            check("authed init: no expiry", a_init.get("expires_at") is None)
            await client.put(a_init["presigned_put_url"], content=apdf, headers=a_init["headers"])
            r = await client.post(f"/api/v1/files/{a_init['file_id']}/finalize")
            check("authed finalize 200", r.status_code == 200, f"got {r.status_code}: {r.text}")
            r = await client.get("/api/v1/files")
            check("authed list includes the file", any(f["id"] == a_init["file_id"] for f in r.json()))
            r = await client.get(f"/f/{a_init['short_code']}", headers={"Host": "platform.test"})
            check("authed serve 200 + bytes", r.status_code == 200 and r.content == apdf)
        finally:
            app.dependency_overrides.pop(get_current_user, None)
            app.dependency_overrides.pop(require_auth, None)

    await _cleanup()

    print("\n" + "=" * 60)
    if _failures:
        print(f"\033[31m{len(_failures)} FAILURE(S):\033[0m")
        for f in _failures:
            print(f"  - {f}")
        return 1
    print("\033[32mAll MongoDB GridFS + anonymous checks passed.\033[0m")
    return 0


if __name__ == "__main__":
    try:
        code = asyncio.run(run())
    finally:
        try:
            _mongo.drop_database(MONGO_DB)
        except Exception:
            pass
    sys.exit(code)
