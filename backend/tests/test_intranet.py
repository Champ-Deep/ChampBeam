from __future__ import annotations

import asyncio
import uuid as _uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import FastAPI, Header, HTTPException
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.models.file_asset import FileAsset, STATUS_DELETED
from app.models.intranet import DecisionLogEntry, Transfer
from app.models.org import Organization, OrganizationMembership
from app.models.user import User

PREFIX = "/api/v1"
I = f"{PREFIX}/intranet"

ROLES = {
    "admin": ("admin", False),
    "rita": ("member", True),
    "rex": ("member", True),
    "alice": ("member", False),
    "bob": ("member", False),
    "carol": ("member", False),
}


class Ctx:
    def __init__(self, client: AsyncClient, maker: async_sessionmaker, ids: dict[str, str], storage_root: Path):
        self.client = client
        self.maker = maker
        self.ids = ids
        self.storage_root = storage_root

    def h(self, who: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {who}"}


@pytest_asyncio.fixture(scope="function")
async def ctx(tmp_path, monkeypatch) -> AsyncGenerator[Ctx, None]:
    from app.api.v1 import intranet
    from app.db import postgres
    from app.db.postgres import Base, get_db_session
    from app.middleware.rate_limit import limiter, setup_rate_limiting

    limiter.reset()
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path / "files"))
    monkeypatch.setattr(settings, "storage_upload_secret", "test-secret")
    monkeypatch.setattr(settings, "intranet_org_ids", "")

    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(conn, _rec):
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    ids = {k: str(_uuid.uuid4()) for k in [*ROLES, "outsider", "gone"]}
    async with maker() as s:
        for name, uid in ids.items():
            s.add(User(id=_uuid.UUID(uid), clerk_id=f"user_{name}", email=f"{name}@champions.test", full_name=name.title()))
        org = Organization(id=_uuid.uuid4(), clerk_org_id="org_intranet", name="Champions", slug="champions")
        s.add(org)
        await s.flush()
        for name, (role, reviewer) in ROLES.items():
            s.add(OrganizationMembership(organization_id=org.id, user_id=_uuid.UUID(ids[name]), role=role, is_reviewer=reviewer))
        s.add(
            OrganizationMembership(
                organization_id=org.id, user_id=_uuid.UUID(ids["gone"]), role="member", deactivated_at=datetime.utcnow()
            )
        )
        await s.commit()

    async def override_get_db():
        async with maker() as session:
            try:
                yield session
                await session.commit()
            except Exception:
                await session.rollback()
                raise

    async def override_auth(authorization: str | None = Header(default=None)):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(status_code=401, detail="Not authenticated")
        who = authorization.split(" ", 1)[1]
        if who not in ids:
            raise HTTPException(status_code=401, detail="Invalid token")
        role = ROLES.get(who, ("member", False))[0]
        return TokenData(
            user_id=ids[who], email=f"{who}@champions.test", clerk_user_id=f"user_{who}",
            org_id="org_intranet", org_role=role, org_slug="champions",
        )

    app = FastAPI()
    setup_rate_limiting(app)
    app.include_router(intranet.router, prefix=PREFIX)
    app.include_router(intranet.blob_router, prefix=PREFIX)
    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[require_auth] = override_auth

    original_maker = postgres.async_session_maker
    postgres.async_session_maker = maker
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield Ctx(client, maker, ids, tmp_path / "files")
    postgres.async_session_maker = original_maker
    await engine.dispose()


async def _upload(c: Ctx, who: str, content: bytes = b"hello data team", filename: str = "report.csv") -> str:
    r = await c.client.post(
        f"{I}/uploads",
        json={"filename": filename, "content_type": "text/csv", "size_bytes": len(content)},
        headers=c.h(who),
    )
    assert r.status_code == 201, r.text
    body = r.json()
    put = await c.client.put(body["upload_url"], content=content, headers=body["headers"])
    assert put.status_code == 204, put.text
    return body["file_id"]


async def _submit(c: Ctx, who: str = "alice", to: str = "bob", content: bytes = b"hello data team", **limits) -> dict:
    file_id = await _upload(c, who, content)
    r = await c.client.post(
        f"{I}/transfers",
        json={"file_id": file_id, "recipient_user_id": c.ids[to], "purpose": "Monthly export", **limits},
        headers=c.h(who),
    )
    assert r.status_code == 201, r.text
    return r.json()


async def _approve(c: Ctx, tid: str, who: str = "rita", **body) -> dict:
    r = await c.client.post(f"{I}/review/{tid}/approve", json=body, headers=c.h(who))
    assert r.status_code == 200, r.text
    return r.json()


async def _events(c: Ctx, tid: str) -> list[str]:
    async with c.maker() as s:
        rows = (
            await s.execute(
                select(DecisionLogEntry.event)
                .where(DecisionLogEntry.transfer_id == _uuid.UUID(tid))
                .order_by(DecisionLogEntry.id)
            )
        ).scalars()
        return list(rows)


async def test_uninvited_and_deactivated_users_are_refused(ctx: Ctx):
    for who in ("outsider", "gone"):
        for path in ("/me", "/inbox", "/transfers/mine", "/members", "/badges"):
            r = await ctx.client.get(f"{I}{path}", headers=ctx.h(who))
            assert r.status_code == 403, (who, path, r.text)
        r = await ctx.client.post(
            f"{I}/uploads", json={"filename": "a.csv", "size_bytes": 3}, headers=ctx.h(who)
        )
        assert r.status_code == 403


async def test_org_allowlist_blocks_other_orgs(ctx: Ctx, monkeypatch):
    monkeypatch.setattr(settings, "intranet_org_ids", "org_somewhere_else")
    r = await ctx.client.get(f"{I}/me", headers=ctx.h("alice"))
    assert r.status_code == 403


async def test_unauthenticated_requests_never_get_bytes(ctx: Ctx):
    t = await _submit(ctx)
    await _approve(ctx, t["id"])
    for path in (f"/transfers/{t['id']}/download", f"/review/{t['id']}/file", "/inbox", "/log", "/log.csv"):
        r = await ctx.client.get(f"{I}{path}")
        assert r.status_code in (401, 404), path
        assert b"hello data team" not in r.content


async def test_unapproved_file_is_403_to_recipient_and_others(ctx: Ctx):
    t = await _submit(ctx)
    for who in ("bob", "carol", "admin"):
        r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h(who))
        assert r.status_code == 403, (who, r.text)
        assert b"hello data team" not in r.content
    r = await ctx.client.get(f"{I}/transfers/{t['id']}", headers=ctx.h("bob"))
    assert r.status_code == 403
    inbox = await ctx.client.get(f"{I}/inbox", headers=ctx.h("bob"))
    assert inbox.json() == []
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("alice"))
    assert r.status_code == 200 and r.content == b"hello data team"


async def test_full_flow_logs_every_step_and_receipt_changes(ctx: Ctx):
    t = await _submit(ctx)
    assert t["state"] == "submitted" and t["receipt"] == "pending"

    queue = (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("rita"))).json()
    assert [q["id"] for q in queue] == [t["id"]]
    badges = (await ctx.client.get(f"{I}/badges", headers=ctx.h("rita"))).json()
    assert badges["review_queue"] == 1

    r = await ctx.client.get(f"{I}/review/{t['id']}/file", headers=ctx.h("rita"))
    assert r.status_code == 200 and r.content == b"hello data team"

    approved = await _approve(ctx, t["id"])
    assert approved["state"] == "released"
    mine = (await ctx.client.get(f"{I}/transfers/mine", headers=ctx.h("alice"))).json()
    assert mine[0]["receipt"] == "not_opened"
    assert (await ctx.client.get(f"{I}/badges", headers=ctx.h("bob"))).json()["inbox_unopened"] == 1

    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 200 and r.content == b"hello data team"
    assert "attachment" in r.headers["content-disposition"]

    mine = (await ctx.client.get(f"{I}/transfers/mine", headers=ctx.h("alice"))).json()
    assert mine[0]["receipt"] == "opened" and mine[0]["first_opened_at"]

    assert await _events(ctx, t["id"]) == [
        "submitted", "opened_for_review", "approved", "released", "opened_by_recipient",
    ]
    verify = (await ctx.client.get(f"{I}/log/verify", headers=ctx.h("admin"))).json()
    assert verify["ok"] is True and verify["rows"] >= 5


async def test_reviewer_cannot_approve_own_submission(ctx: Ctx):
    t = await _submit(ctx, who="rita", to="bob")
    r = await ctx.client.post(f"{I}/review/{t['id']}/approve", json={}, headers=ctx.h("rita"))
    assert r.status_code == 403
    r = await ctx.client.post(f"{I}/review/{t['id']}/reject", json={"reason": "no"}, headers=ctx.h("rita"))
    assert r.status_code == 403
    await _approve(ctx, t["id"], who="rex")


async def test_non_reviewer_cannot_decide(ctx: Ctx):
    t = await _submit(ctx)
    for who in ("admin", "carol", "bob"):
        r = await ctx.client.post(f"{I}/review/{t['id']}/approve", json={}, headers=ctx.h(who))
        assert r.status_code == 403
        r = await ctx.client.get(f"{I}/review/queue", headers=ctx.h(who))
        assert r.status_code == 403


async def test_reject_requires_reason_and_deletes_blob(ctx: Ctx):
    t = await _submit(ctx)
    r = await ctx.client.post(f"{I}/review/{t['id']}/reject", json={"reason": ""}, headers=ctx.h("rita"))
    assert r.status_code == 422
    r = await ctx.client.post(f"{I}/review/{t['id']}/reject", json={}, headers=ctx.h("rita"))
    assert r.status_code == 422
    r = await ctx.client.post(f"{I}/review/{t['id']}/reject", json={"reason": "Contains PII"}, headers=ctx.h("rita"))
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == "rejected" and body["reject_reason"] == "Contains PII"
    mine = (await ctx.client.get(f"{I}/transfers/mine", headers=ctx.h("alice"))).json()
    assert mine[0]["receipt"] == "rejected" and mine[0]["reject_reason"] == "Contains PII"
    assert not any(ctx.storage_root.rglob("report.csv"))
    r = await ctx.client.post(f"{I}/review/{t['id']}/approve", json={}, headers=ctx.h("rex"))
    assert r.status_code == 409


async def test_one_time_file_parallel_downloads_yield_exactly_one_success(ctx: Ctx):
    payload = b"x" * 200_000
    t = await _submit(ctx, content=payload, requested_one_time=True)
    await _approve(ctx, t["id"])
    results = await asyncio.gather(
        *[ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob")) for _ in range(10)]
    )
    ok = [r for r in results if r.status_code == 200]
    assert len(ok) == 1, [r.status_code for r in results]
    assert ok[0].content == payload
    assert all(r.status_code in (409, 410) for r in results if r.status_code != 200)
    again = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert again.status_code == 410
    events = await _events(ctx, t["id"])
    assert events.count("consumed") == 1 and events.count("opened_by_recipient") == 1
    assert not any(ctx.storage_root.rglob("report.csv"))


async def test_one_time_cannot_be_loosened_and_expiry_only_tightens(ctx: Ctx):
    t = await _submit(ctx, requested_one_time=True, requested_expires_in_days=3)
    r = await ctx.client.post(f"{I}/review/{t['id']}/approve", json={"one_time": False}, headers=ctx.h("rita"))
    assert r.status_code == 422
    r = await ctx.client.post(f"{I}/review/{t['id']}/approve", json={"expires_in_days": 5}, headers=ctx.h("rita"))
    assert r.status_code == 422
    approved = await _approve(ctx, t["id"], expires_in_days=1)
    assert approved["one_time"] is True
    released = datetime.fromisoformat(approved["released_at"].replace("Z", "+00:00"))
    expires = datetime.fromisoformat(approved["expires_at"].replace("Z", "+00:00"))
    assert expires - released == timedelta(days=1)


async def test_reviewer_can_tighten_to_one_time(ctx: Ctx):
    t = await _submit(ctx)
    approved = await _approve(ctx, t["id"], one_time=True)
    assert approved["one_time"] is True


async def test_expired_file_is_refused_and_sweep_removes_blob(ctx: Ctx):
    from app.services import file_expiry

    t = await _submit(ctx)
    await _approve(ctx, t["id"])
    async with ctx.maker() as s:
        await s.execute(
            update(Transfer)
            .where(Transfer.id == _uuid.UUID(t["id"]))
            .values(expires_at=datetime.utcnow() - timedelta(minutes=1))
        )
        await s.commit()
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 410
    assert any(ctx.storage_root.rglob("report.csv"))
    assert await file_expiry.sweep_transfers() == 1
    assert not any(ctx.storage_root.rglob("report.csv"))
    async with ctx.maker() as s:
        row = await s.get(Transfer, _uuid.UUID(t["id"]))
        assert row.state == "expired"
        asset = await s.get(FileAsset, row.file_id)
        assert asset.status == STATUS_DELETED
    assert (await _events(ctx, t["id"]))[-1] == "expired"
    mine = (await ctx.client.get(f"{I}/transfers/mine", headers=ctx.h("alice"))).json()
    assert mine[0]["receipt"] == "expired"


async def test_undecided_submission_hard_expires(ctx: Ctx):
    from app.services import file_expiry

    t = await _submit(ctx)
    async with ctx.maker() as s:
        await s.execute(
            update(Transfer)
            .where(Transfer.id == _uuid.UUID(t["id"]))
            .values(hard_expires_at=datetime.utcnow() - timedelta(seconds=1))
        )
        await s.commit()
    await file_expiry.sweep_transfers()
    queue = (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("rita"))).json()
    assert queue == []
    assert (await _events(ctx, t["id"]))[-1] == "expired"


async def test_revoke_is_immediate(ctx: Ctx):
    t = await _submit(ctx)
    await _approve(ctx, t["id"])
    r = await ctx.client.post(f"{I}/transfers/{t['id']}/revoke", json={"reason": "wrong file"}, headers=ctx.h("bob"))
    assert r.status_code == 403
    r = await ctx.client.post(f"{I}/transfers/{t['id']}/revoke", json={"reason": "wrong file"}, headers=ctx.h("alice"))
    assert r.status_code == 200 and r.json()["receipt"] == "revoked"
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 410
    t2 = await _submit(ctx)
    r = await ctx.client.post(f"{I}/transfers/{t2['id']}/revoke", headers=ctx.h("rex"))
    assert r.status_code == 200
    assert (await _events(ctx, t2["id"]))[-1] == "revoked"


async def test_intake_checks_block_and_log(ctx: Ctx, monkeypatch):
    r = await ctx.client.post(
        f"{I}/uploads", json={"filename": "setup.exe", "size_bytes": 10}, headers=ctx.h("alice")
    )
    assert r.status_code == 422
    assert "Blocked file type" in r.json()["detail"]["failures"][0]
    monkeypatch.setattr(settings, "intranet_max_file_bytes", 5)
    r = await ctx.client.post(
        f"{I}/uploads", json={"filename": "big.csv", "size_bytes": 10}, headers=ctx.h("alice")
    )
    assert r.status_code == 422
    async with ctx.maker() as s:
        rows = (await s.execute(select(DecisionLogEntry).where(DecisionLogEntry.event == "check_failed"))).scalars().all()
        assert len(rows) == 2
        assert all("setup.exe" not in (row.reason or "") for row in rows)


async def test_submission_validation(ctx: Ctx):
    file_id = await _upload(ctx, "alice")
    base = {"file_id": file_id, "purpose": "x"}
    for recipient, code in ((ctx.ids["alice"], 400), (ctx.ids["outsider"], 400), (ctx.ids["gone"], 400)):
        r = await ctx.client.post(f"{I}/transfers", json={**base, "recipient_user_id": recipient}, headers=ctx.h("alice"))
        assert r.status_code == code
    r = await ctx.client.post(
        f"{I}/transfers", json={**base, "recipient_user_id": ctx.ids["bob"]}, headers=ctx.h("carol")
    )
    assert r.status_code == 404
    r = await ctx.client.post(
        f"{I}/transfers", json={**base, "recipient_user_id": ctx.ids["bob"], "purpose": ""}, headers=ctx.h("alice")
    )
    assert r.status_code == 422
    ok = await ctx.client.post(f"{I}/transfers", json={**base, "recipient_user_id": ctx.ids["bob"]}, headers=ctx.h("alice"))
    assert ok.status_code == 201
    dup = await ctx.client.post(f"{I}/transfers", json={**base, "recipient_user_id": ctx.ids["bob"]}, headers=ctx.h("alice"))
    assert dup.status_code == 409


async def test_size_mismatch_is_rejected(ctx: Ctx):
    r = await ctx.client.post(
        f"{I}/uploads", json={"filename": "a.csv", "content_type": "text/csv", "size_bytes": 100}, headers=ctx.h("alice")
    )
    body = r.json()
    put = await ctx.client.put(body["upload_url"], content=b"short", headers=body["headers"])
    assert put.status_code == 204
    r = await ctx.client.post(
        f"{I}/transfers",
        json={"file_id": body["file_id"], "recipient_user_id": ctx.ids["bob"], "purpose": "x"},
        headers=ctx.h("alice"),
    )
    assert r.status_code == 400


async def test_log_is_append_only_and_tamper_evident(ctx: Ctx):
    from app.api.v1 import intranet

    for route in intranet.router.routes:
        if "/log" in route.path:
            assert route.methods <= {"GET", "HEAD"}, route.path
    t = await _submit(ctx)
    await _approve(ctx, t["id"])
    assert (await ctx.client.get(f"{I}/log", headers=ctx.h("carol"))).status_code == 403
    page = (await ctx.client.get(f"{I}/log", headers=ctx.h("admin"))).json()
    assert page["total"] == 3
    csv_body = (await ctx.client.get(f"{I}/log.csv", headers=ctx.h("rita"))).text
    assert csv_body.splitlines()[0].startswith("id,at,transfer_id,event")
    assert len(csv_body.strip().splitlines()) == 4
    filtered = (await ctx.client.get(f"{I}/log", params={"event": "approved"}, headers=ctx.h("admin"))).json()
    assert [e["event"] for e in filtered["items"]] == ["approved"]

    async with ctx.maker() as s:
        await s.execute(text("UPDATE decision_log SET reason = 'edited' WHERE event = 'approved'"))
        await s.commit()
    verify = (await ctx.client.get(f"{I}/log/verify", headers=ctx.h("admin"))).json()
    assert verify["ok"] is False


async def test_admin_member_management_and_settings(ctx: Ctx, monkeypatch):
    from app.services import clerk_client

    calls: list[tuple] = []

    async def fake_delete(org_id, user_id):
        calls.append(("delete", org_id, user_id))
        return {}

    monkeypatch.setattr(clerk_client, "delete_org_membership", fake_delete)

    r = await ctx.client.patch(f"{I}/members/{ctx.ids['carol']}", json={"is_reviewer": True}, headers=ctx.h("alice"))
    assert r.status_code == 403
    r = await ctx.client.patch(f"{I}/members/{ctx.ids['carol']}", json={"is_reviewer": True}, headers=ctx.h("admin"))
    assert r.status_code == 200 and r.json()["is_reviewer"] is True
    assert (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("carol"))).status_code == 200

    r = await ctx.client.patch(f"{I}/members/{ctx.ids['carol']}", json={"active": False}, headers=ctx.h("admin"))
    assert r.status_code == 200 and r.json()["active"] is False
    assert calls == [("delete", "org_intranet", "user_carol")]
    assert (await ctx.client.get(f"{I}/me", headers=ctx.h("carol"))).status_code == 403
    r = await ctx.client.patch(f"{I}/members/{ctx.ids['admin']}", json={"active": False}, headers=ctx.h("admin"))
    assert r.status_code == 400

    r = await ctx.client.put(f"{I}/review-settings", json={"agent_mode": "jev"}, headers=ctx.h("admin"))
    assert r.status_code == 422
    r = await ctx.client.put(f"{I}/review-settings", json={"default_expiry_days": 3}, headers=ctx.h("rita"))
    assert r.status_code == 403
    r = await ctx.client.put(f"{I}/review-settings", json={"default_expiry_days": 3}, headers=ctx.h("admin"))
    assert r.status_code == 200 and r.json()["default_expiry_days"] == 3
    async with ctx.maker() as s:
        events = (await s.execute(select(DecisionLogEntry.event).order_by(DecisionLogEntry.id))).scalars().all()
    assert events == ["member_updated", "member_deactivated", "settings_changed"]


async def test_invites_go_through_clerk_and_are_logged(ctx: Ctx, monkeypatch):
    from app.services import clerk_client

    sent: list[tuple] = []

    async def fake_create(org_id, email, role, inviter, redirect):
        sent.append((org_id, email, role, inviter))
        return {"id": "orginv_1"}

    async def fake_revoke(org_id, invitation_id, requester):
        sent.append(("revoke", invitation_id))
        return {}

    monkeypatch.setattr(clerk_client, "create_org_invitation", fake_create)
    monkeypatch.setattr(clerk_client, "revoke_org_invitation", fake_revoke)

    r = await ctx.client.post(f"{I}/invites", json={"email": "new@champions.test"}, headers=ctx.h("alice"))
    assert r.status_code == 403
    r = await ctx.client.post(f"{I}/invites", json={"email": "bob@champions.test"}, headers=ctx.h("admin"))
    assert r.status_code == 409
    r = await ctx.client.post(f"{I}/invites", json={"email": "New@Champions.test"}, headers=ctx.h("admin"))
    assert r.status_code == 201
    invite = r.json()
    assert invite["status"] == "pending" and invite["email"] == "new@champions.test"
    assert sent[0] == ("org_intranet", "new@champions.test", "member", "user_admin")
    r = await ctx.client.delete(f"{I}/invites/{invite['id']}", headers=ctx.h("admin"))
    assert r.status_code == 200 and r.json()["status"] == "revoked"
    assert sent[-1] == ("revoke", "orginv_1")
    listed = (await ctx.client.get(f"{I}/invites", headers=ctx.h("admin"))).json()
    assert [i["status"] for i in listed] == ["revoked"]


async def test_invites_expire_after_ttl(ctx: Ctx, monkeypatch):
    from app.models.intranet import OrgInvite
    from app.services import clerk_client, file_expiry

    revoked: list[str] = []

    async def fake_create(org_id, email, role, inviter, redirect):
        return {"id": "orginv_2"}

    async def fake_revoke(org_id, invitation_id, requester):
        revoked.append(invitation_id)
        return {}

    monkeypatch.setattr(clerk_client, "create_org_invitation", fake_create)
    monkeypatch.setattr(clerk_client, "revoke_org_invitation", fake_revoke)
    r = await ctx.client.post(f"{I}/invites", json={"email": "late@champions.test"}, headers=ctx.h("admin"))
    assert r.status_code == 201
    async with ctx.maker() as s:
        await s.execute(update(OrgInvite).values(expires_at=datetime.utcnow() - timedelta(seconds=1)))
        await s.commit()
    await file_expiry.sweep_transfers()
    assert revoked == ["orginv_2"]
    listed = (await ctx.client.get(f"{I}/invites", headers=ctx.h("admin"))).json()
    assert listed[0]["status"] == "expired"


async def test_me_reports_roles(ctx: Ctx):
    me = (await ctx.client.get(f"{I}/me", headers=ctx.h("rita"))).json()
    assert me["is_reviewer"] is True and me["is_admin"] is False
    assert me["malware_scan"] is False
    admin = (await ctx.client.get(f"{I}/me", headers=ctx.h("admin"))).json()
    assert admin["is_admin"] is True
    members = (await ctx.client.get(f"{I}/members", headers=ctx.h("alice"))).json()
    assert ctx.ids["gone"] not in {m["user_id"] for m in members}


@pytest.mark.parametrize("name", ["data.csv", "archive.tar.gz", "report.final.xlsx"])
def test_allowed_names_pass_hard_checks(name):
    from app.services.transfer_service import hard_check_failures

    assert hard_check_failures(name, 10) == []


@pytest.mark.parametrize("name", ["evil.exe", "invoice.pdf.exe", "run.PS1", "x.exe.", "a.bat"])
def test_blocked_names_fail_hard_checks(name):
    from app.services.transfer_service import hard_check_failures

    assert hard_check_failures(name, 10)


async def test_interrupted_one_time_download_can_be_retried(ctx: Ctx):
    from app.services import transfer_service

    t = await _submit(ctx, requested_one_time=True)
    await _approve(ctx, t["id"])
    async with ctx.maker() as s:
        row = await s.get(Transfer, _uuid.UUID(t["id"]))
        claim = await transfer_service.claim_download(s, row, ctx.ids["bob"])
    busy = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert busy.status_code == 409
    async with ctx.maker() as s:
        await transfer_service.release_claim(s, claim)
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 200 and r.content == b"hello data team"


async def test_stale_claim_lease_expires(ctx: Ctx, monkeypatch):
    from app.services import transfer_service

    t = await _submit(ctx, requested_one_time=True)
    await _approve(ctx, t["id"])
    async with ctx.maker() as s:
        row = await s.get(Transfer, _uuid.UUID(t["id"]))
        await transfer_service.claim_download(s, row, ctx.ids["bob"])
        await s.execute(
            update(Transfer)
            .where(Transfer.id == row.id)
            .values(download_claim_at=datetime.utcnow() - timedelta(seconds=settings.intranet_download_lease_seconds + 5))
        )
        await s.commit()
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 200


async def test_revoke_during_claim_stops_completion(ctx: Ctx):
    from app.services import transfer_service

    t = await _submit(ctx, requested_one_time=True)
    await _approve(ctx, t["id"])
    async with ctx.maker() as s:
        row = await s.get(Transfer, _uuid.UUID(t["id"]))
        claim = await transfer_service.claim_download(s, row, ctx.ids["bob"])
    r = await ctx.client.post(f"{I}/transfers/{t['id']}/revoke", headers=ctx.h("alice"))
    assert r.status_code == 200
    async with ctx.maker() as s:
        assert await transfer_service.heartbeat_claim(s, claim) is False
        assert await transfer_service.complete_download(s, claim, ctx.ids["bob"]) is None
    assert "consumed" not in await _events(ctx, t["id"])


async def test_download_ticket_streams_without_bearer(ctx: Ctx, monkeypatch):
    from app.api.v1 import intranet

    t = await _submit(ctx, requested_one_time=True)
    r = await ctx.client.post(f"{I}/transfers/{t['id']}/download-ticket", json={"kind": "review"}, headers=ctx.h("alice"))
    assert r.status_code == 403
    review = (await ctx.client.post(f"{I}/transfers/{t['id']}/download-ticket", json={"kind": "review"}, headers=ctx.h("rita"))).json()
    r = await ctx.client.get(review["url"])
    assert r.status_code == 200 and r.content == b"hello data team"

    early = (await ctx.client.post(f"{I}/transfers/{t['id']}/download-ticket", headers=ctx.h("bob"))).json()
    assert (await ctx.client.get(early["url"])).status_code == 403

    await _approve(ctx, t["id"])
    ticket = (await ctx.client.post(f"{I}/transfers/{t['id']}/download-ticket", headers=ctx.h("bob"))).json()
    assert ticket["url"].startswith("/api/v1/intranet/download/")
    tampered = ticket["url"][:-3] + ("AAA" if not ticket["url"].endswith("AAA") else "BBB")
    assert (await ctx.client.get(tampered)).status_code == 404
    r = await ctx.client.get(ticket["url"])
    assert r.status_code == 200 and r.content == b"hello data team"
    assert (await ctx.client.get(ticket["url"])).status_code == 410

    monkeypatch.setattr(intranet, "_TICKET_TTL_SECONDS", -1)
    stale = (await ctx.client.post(f"{I}/transfers/{t['id']}/download-ticket", headers=ctx.h("alice"))).json()
    assert (await ctx.client.get(stale["url"])).status_code == 404


async def test_download_ticket_refused_after_deactivation(ctx: Ctx):
    t = await _submit(ctx)
    await _approve(ctx, t["id"])
    ticket = (await ctx.client.post(f"{I}/transfers/{t['id']}/download-ticket", headers=ctx.h("bob"))).json()
    async with ctx.maker() as s:
        await s.execute(
            update(OrganizationMembership)
            .where(OrganizationMembership.user_id == _uuid.UUID(ctx.ids["bob"]))
            .values(deactivated_at=datetime.utcnow())
        )
        await s.commit()
    r = await ctx.client.get(ticket["url"])
    assert r.status_code == 403 and b"hello data team" not in r.content


async def test_sweeper_reclaims_only_abandoned_intranet_uploads(ctx: Ctx):
    from app.services import file_expiry

    abandoned_id = await _upload(ctx, "alice", filename="abandoned.csv")
    t = await _submit(ctx)
    marketing_id = _uuid.uuid4()
    old = datetime.utcnow() - timedelta(days=2)
    async with ctx.maker() as s:
        s.add(
            FileAsset(
                id=marketing_id, user_id=_uuid.UUID(ctx.ids["alice"]), short_code="mkt1", filename="deck.pdf",
                kind="pdf", mime_type="application/pdf", size_bytes=1, storage_key="u/x/deck.pdf",
                status="active", serve_mode="stream", view_count=0, created_at=old,
            )
        )
        await s.execute(update(FileAsset).values(created_at=old))
        await s.commit()
    await file_expiry.sweep_transfers()
    async with ctx.maker() as s:
        assert (await s.get(FileAsset, _uuid.UUID(abandoned_id))).status == STATUS_DELETED
        assert (await s.get(FileAsset, marketing_id)).status == "active"
        row = await s.get(Transfer, _uuid.UUID(t["id"]))
        assert (await s.get(FileAsset, row.file_id)).status == "active"
    assert not any(ctx.storage_root.rglob("abandoned.csv"))


async def test_sweeper_does_not_expire_accepted_invites(ctx: Ctx, monkeypatch):
    from app.models.intranet import OrgInvite
    from app.services import clerk_client, file_expiry

    revoked: list[str] = []

    async def fake_create(org_id, email, role, inviter, redirect):
        return {"id": "orginv_3"}

    async def fake_revoke(org_id, invitation_id, requester):
        revoked.append(invitation_id)
        return {}

    monkeypatch.setattr(clerk_client, "create_org_invitation", fake_create)
    monkeypatch.setattr(clerk_client, "revoke_org_invitation", fake_revoke)
    r = await ctx.client.post(f"{I}/invites", json={"email": "joiner@champions.test"}, headers=ctx.h("admin"))
    assert r.status_code == 201
    async with ctx.maker() as s:
        await s.execute(update(OrgInvite).values(expires_at=datetime.utcnow() - timedelta(seconds=1)))
        await s.execute(update(User).where(User.id == _uuid.UUID(ctx.ids["carol"])).values(email="Joiner@champions.test"))
        await s.commit()
    await file_expiry.sweep_transfers()
    assert revoked == []
    listed = (await ctx.client.get(f"{I}/invites", headers=ctx.h("admin"))).json()
    assert listed[0]["status"] == "accepted"
    async with ctx.maker() as s:
        events = (await s.execute(select(DecisionLogEntry.event))).scalars().all()
    assert "invite_expired" not in events
