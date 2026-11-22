from __future__ import annotations

import asyncio
import json
import struct
import uuid as _uuid
from datetime import datetime, timedelta

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import select, update

from app.core.config import settings
from app.models.file_asset import FileAsset, STATUS_DELETED
from app.models.intranet import DecisionLogEntry, OrgReviewSettings, Transfer
from app.services import file_expiry, malware_scan, review_agent
from tests.test_intranet import I, Ctx, _approve, _events, _submit, _upload, ctx  # noqa: F401

EICAR = b"X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


@pytest_asyncio.fixture
async def clamd(monkeypatch):
    seen: list[int] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        command = await reader.readuntil(b"\0")
        assert command == b"zINSTREAM\0"
        body = bytearray()
        while True:
            size = struct.unpack("!L", await reader.readexactly(4))[0]
            if size == 0:
                break
            body.extend(await reader.readexactly(size))
        seen.append(len(body))
        reply = b"stream: Eicar-Test-Signature FOUND\0" if b"EICAR-STANDARD" in body else b"stream: OK\0"
        writer.write(reply)
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    monkeypatch.setattr(settings, "clamd_host", "127.0.0.1")
    monkeypatch.setattr(settings, "clamd_port", port)
    yield seen
    server.close()
    await server.wait_closed()


async def _transfer(c: Ctx, tid: str) -> Transfer:
    async with c.maker() as s:
        return await s.get(Transfer, _uuid.UUID(tid))


async def _set(c: Ctx, tid: str, **values) -> None:
    async with c.maker() as s:
        await s.execute(update(Transfer).where(Transfer.id == _uuid.UUID(tid)).values(**values))
        await s.commit()


async def _settings(c: Ctx, **values) -> None:
    async with c.maker() as s:
        await s.execute(update(OrgReviewSettings).values(**values))
        await s.commit()


async def _agent_rows(c: Ctx, tid: str) -> list[DecisionLogEntry]:
    async with c.maker() as s:
        return list(
            (
                await s.execute(
                    select(DecisionLogEntry)
                    .where(DecisionLogEntry.transfer_id == _uuid.UUID(tid), DecisionLogEntry.actor_type == "agent")
                    .order_by(DecisionLogEntry.id)
                )
            ).scalars()
        )


@pytest.mark.parametrize(
    "reply,status",
    [
        ("stream: OK\0", "clean"),
        ("stream: Win.Test.EICAR_HDB-1 FOUND\0", "infected"),
        ("INSTREAM size limit exceeded. ERROR\0", "not_scanned"),
        ("", "not_scanned"),
    ],
)
def test_clamd_reply_parsing(reply, status):
    result = malware_scan.parse_reply(reply)
    assert result.status == status
    if status == "infected":
        assert result.signature == "Win.Test.EICAR_HDB-1"


async def test_clean_file_is_scanned_before_entering_queue(ctx: Ctx, clamd):
    t = await _submit(ctx)
    assert t["state"] == "scanning" and t["receipt"] == "scanning"
    row = await _transfer(ctx, t["id"])
    assert row.state == "submitted" and row.scan_status == "clean"
    queue = (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("rita"))).json()
    assert [q["scan_status"] for q in queue] == ["clean"]
    assert clamd == [len(b"hello data team")]
    assert (await _events(ctx, t["id"]))[:2] == ["submitted", "scanned"]
    me = (await ctx.client.get(f"{I}/me", headers=ctx.h("alice"))).json()
    assert me["malware_scan"] is True


async def test_infected_file_is_refused_and_deleted(ctx: Ctx, clamd):
    t = await _submit(ctx, content=EICAR)
    row = await _transfer(ctx, t["id"])
    assert row.state == "check_failed" and row.scan_status == "infected"
    assert (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("rita"))).json() == []
    async with ctx.maker() as s:
        assert (await s.get(FileAsset, row.file_id)).status == STATUS_DELETED
    assert not any(ctx.storage_root.rglob("report.csv"))
    assert await _events(ctx, t["id"]) == ["submitted", "scanned", "check_failed"]
    mine = (await ctx.client.get(f"{I}/transfers/mine", headers=ctx.h("alice"))).json()
    assert mine[0]["receipt"] == "check_failed"


async def test_file_over_scan_limit_is_queued_flagged(ctx: Ctx, clamd, monkeypatch):
    monkeypatch.setattr(settings, "clamd_max_stream_bytes", 4)
    t = await _submit(ctx)
    row = await _transfer(ctx, t["id"])
    assert row.state == "submitted" and row.scan_status == "not_scanned"
    assert "scan limit" in row.scan_detail
    assert clamd == []


async def test_unreachable_scanner_queues_flagged(ctx: Ctx, monkeypatch):
    monkeypatch.setattr(settings, "clamd_host", "127.0.0.1")
    monkeypatch.setattr(settings, "clamd_port", 1)
    t = await _submit(ctx)
    row = await _transfer(ctx, t["id"])
    assert row.state == "submitted" and row.scan_status == "not_scanned"
    assert row.scan_detail == "Scanner unreachable."


async def test_stuck_scan_is_retried_by_sweeper(ctx: Ctx, clamd, monkeypatch):
    from app.services import transfer_service

    real_scan = transfer_service.scan_transfer

    async def no_scan(_tid):
        return None

    monkeypatch.setattr(transfer_service, "scan_transfer", no_scan)
    t = await _submit(ctx)
    monkeypatch.setattr(transfer_service, "scan_transfer", real_scan)
    assert (await _transfer(ctx, t["id"])).state == "scanning"
    await file_expiry.sweep_transfers()
    assert (await _transfer(ctx, t["id"])).state == "scanning"
    await _set(ctx, t["id"], submitted_at=datetime.utcnow() - timedelta(hours=1))
    await file_expiry.sweep_transfers()
    row = await _transfer(ctx, t["id"])
    assert row.state == "submitted" and row.scan_status == "clean"
    assert clamd == [len(b"hello data team")]


async def test_withdraw_unreleased_only_by_submitter(ctx: Ctx):
    t = await _submit(ctx)
    r = await ctx.client.post(f"{I}/transfers/{t['id']}/withdraw", headers=ctx.h("rita"))
    assert r.status_code == 403
    r = await ctx.client.post(f"{I}/transfers/{t['id']}/withdraw", json={"reason": "wrong file"}, headers=ctx.h("alice"))
    assert r.status_code == 200 and r.json()["state"] == "withdrawn"
    assert (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("rita"))).json() == []
    assert not any(ctx.storage_root.rglob("report.csv"))
    assert (await _events(ctx, t["id"]))[-1] == "withdrawn"
    t2 = await _submit(ctx)
    await _approve(ctx, t2["id"])
    r = await ctx.client.post(f"{I}/transfers/{t2['id']}/withdraw", headers=ctx.h("alice"))
    assert r.status_code == 409


async def test_reminder_is_sent_once_after_reminder_age(ctx: Ctx):
    t = await _submit(ctx)
    await file_expiry.sweep_transfers()
    assert (await _transfer(ctx, t["id"])).reminded_at is None
    await _set(ctx, t["id"], submitted_at=datetime.utcnow() - timedelta(hours=13))
    await file_expiry.sweep_transfers()
    await file_expiry.sweep_transfers()
    assert (await _events(ctx, t["id"])).count("reminder_sent") == 1
    badges = (await ctx.client.get(f"{I}/badges", headers=ctx.h("rita"))).json()
    assert badges["review_overdue"] == 1
    queue = (await ctx.client.get(f"{I}/review/queue", headers=ctx.h("rita"))).json()
    assert queue[0]["reminded_at"]


async def test_agent_mode_requires_configured_provider(ctx: Ctx, monkeypatch):
    for mode in ("local", "jev"):
        r = await ctx.client.put(f"{I}/review-settings", json={"agent_mode": mode}, headers=ctx.h("admin"))
        assert r.status_code == 422, mode
    monkeypatch.setattr(settings, "review_agent_allow_mock", True)
    r = await ctx.client.put(f"{I}/review-settings", json={"agent_mode": "local", "agent_input_mode": "content_excerpt"}, headers=ctx.h("admin"))
    assert r.status_code == 200
    me = (await ctx.client.get(f"{I}/me", headers=ctx.h("admin"))).json()
    assert me["agent"]["modes"] == ["off", "local"]


async def _agent_ready(c: Ctx, monkeypatch, **submit_kwargs) -> dict:
    monkeypatch.setattr(settings, "review_agent_allow_mock", True)
    t = await _submit(c, **submit_kwargs)
    await _settings(c, agent_mode="local")
    await _set(
        c,
        t["id"],
        scan_status="clean",
        check_results={"size": "ok", "type": "ok", "malware_scan": "clean"},
        agent_window_ends_at=datetime.utcnow() - timedelta(minutes=1),
    )
    return t


async def test_agent_never_acts_before_window(ctx: Ctx, monkeypatch):
    monkeypatch.setattr(settings, "review_agent_allow_mock", True)
    t = await _submit(ctx)
    await _settings(ctx, agent_mode="local")
    await _set(ctx, t["id"], scan_status="clean")
    await file_expiry.sweep_transfers()
    assert (await _transfer(ctx, t["id"])).state == "submitted"
    assert await _agent_rows(ctx, t["id"]) == []


async def test_agent_approves_above_threshold_and_logs_inputs(ctx: Ctx, monkeypatch):
    t = await _agent_ready(ctx, monkeypatch)
    await file_expiry.sweep_transfers()
    row = await _transfer(ctx, t["id"])
    assert row.state == "released" and row.decided_by_type == "agent" and row.decided_by_id == "agent:mock"
    approved = [r for r in await _agent_rows(ctx, t["id"]) if r.event == "approved"][0]
    assert approved.agent_provider == "mock" and approved.agent_p_approve == pytest.approx(0.97)
    assert approved.agent_threshold == pytest.approx(0.95) and len(approved.agent_input_sha256) == 64
    assert approved.agent_input_mode == "metadata_only"
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 200
    verify = (await ctx.client.get(f"{I}/log/verify", headers=ctx.h("admin"))).json()
    assert verify["ok"] is True


async def test_agent_escalates_low_confidence_once(ctx: Ctx, monkeypatch):
    file_id = await _upload(ctx, "alice")
    monkeypatch.setattr(settings, "review_agent_allow_mock", True)
    r = await ctx.client.post(
        f"{I}/transfers",
        json={"file_id": file_id, "recipient_user_id": ctx.ids["bob"], "purpose": "please reject this"},
        headers=ctx.h("alice"),
    )
    tid = r.json()["id"]
    await _settings(ctx, agent_mode="local")
    await _set(ctx, tid, scan_status="clean", agent_window_ends_at=datetime.utcnow() - timedelta(minutes=1),
               check_results={"size": "ok", "type": "ok", "malware_scan": "clean"})
    await file_expiry.sweep_transfers()
    await file_expiry.sweep_transfers()
    row = await _transfer(ctx, tid)
    assert row.state == "submitted" and row.escalated_at is not None
    assert "below" in row.escalation_reason
    rows = await _agent_rows(ctx, tid)
    assert [r.event for r in rows] == ["escalated"]
    assert rows[0].agent_p_approve == pytest.approx(0.1)
    badges = (await ctx.client.get(f"{I}/badges", headers=ctx.h("rita"))).json()
    assert badges["review_overdue"] == 1


async def test_agent_skips_scorer_when_deterministic_checks_fail(ctx: Ctx, monkeypatch):
    calls: list[dict] = []

    async def spy(self, payload):
        calls.append(payload)
        return review_agent.ScoreResult(0.99, [], "m", "1", "mock")

    monkeypatch.setattr(review_agent.MockScorer, "score", spy)
    t = await _agent_ready(ctx, monkeypatch)
    await _set(ctx, t["id"], scan_status="not_scanned")
    await file_expiry.sweep_transfers()
    row = await _transfer(ctx, t["id"])
    assert row.state == "submitted" and "malware scan" in row.escalation_reason
    assert calls == []

    t2 = await _agent_ready(ctx, monkeypatch)
    async with ctx.maker() as s:
        first = await s.get(Transfer, _uuid.UUID(t["id"]))
        sha = (await s.get(FileAsset, first.file_id)).sha256
    assert sha
    await file_expiry.sweep_transfers()
    row2 = await _transfer(ctx, t2["id"])
    assert row2.state == "submitted" and "submitted before" in row2.escalation_reason
    assert calls == []


async def test_clef_contract_and_errors_never_approve(ctx: Ctx, monkeypatch):
    received: list[dict] = []
    replies = iter([
        httpx.Response(200, json={"p_approve": 1.5}),
        httpx.Response(500),
        httpx.Response(200, json={"p_approve": 0.96, "reasons": ["looks routine"], "model": "clef-small", "version": "7"}),
    ])

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"] == "Bearer clef-secret"
        received.append(json.loads(request.content))
        return next(replies)

    original = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(review_agent.httpx, "AsyncClient", client_factory)
    monkeypatch.setattr(settings, "clef_url", "http://clef.internal/score")
    monkeypatch.setattr(settings, "clef_token", "clef-secret")

    tids = []
    for content in (b"one", b"two", b"three"):
        t = await _submit(ctx, content=content)
        await _set(ctx, t["id"], scan_status="clean", agent_window_ends_at=datetime.utcnow() - timedelta(minutes=1),
                   check_results={"size": "ok", "type": "ok", "malware_scan": "clean"})
        tids.append(t["id"])
    await _settings(ctx, agent_mode="local", agent_input_mode="content_excerpt")
    await file_expiry.sweep_transfers()

    states = [(await _transfer(ctx, tid)).state for tid in tids]
    assert states == ["submitted", "submitted", "released"]
    assert "Scorer unavailable" in (await _transfer(ctx, tids[0])).escalation_reason
    assert "HTTP 500" in (await _transfer(ctx, tids[1])).escalation_reason
    body = received[2]
    assert body["question"] and [c["name"] for c in body["criteria"]][0] == "business_purpose"
    assert body["input"]["purpose"] == "Monthly export" and body["input"]["content_excerpt"] == "three"
    approved = [r for r in await _agent_rows(ctx, tids[2]) if r.event == "approved"][0]
    assert approved.agent_model == "clef-small@7" and approved.agent_input_mode == "content_excerpt"


async def test_overturn_agent_approval_until_opened(ctx: Ctx, monkeypatch):
    t = await _agent_ready(ctx, monkeypatch)
    t2 = await _agent_ready(ctx, monkeypatch, content=b"second file")
    await file_expiry.sweep_transfers()
    listed = (await ctx.client.get(f"{I}/review/agent-approved", headers=ctx.h("rita"))).json()
    assert {x["id"] for x in listed} == {t["id"], t2["id"]}
    assert listed[0]["decided_by_id"] == "agent:mock" and listed[0]["agent_result"]["p_approve"] == pytest.approx(0.97)

    r = await ctx.client.post(f"{I}/review/{t['id']}/overturn", json={"reason": ""}, headers=ctx.h("rita"))
    assert r.status_code == 422
    r = await ctx.client.post(f"{I}/review/{t['id']}/overturn", json={"reason": "Not for Bob"}, headers=ctx.h("rita"))
    assert r.status_code == 200 and r.json()["state"] == "rejected"
    assert (await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))).status_code == 403
    assert (await _events(ctx, t["id"]))[-1] == "overturned"

    assert (await ctx.client.get(f"{I}/transfers/{t2['id']}/download", headers=ctx.h("bob"))).status_code == 200
    r = await ctx.client.post(f"{I}/review/{t2['id']}/overturn", json={"reason": "late"}, headers=ctx.h("rita"))
    assert r.status_code == 409

    human = await _submit(ctx, content=b"human")
    await _approve(ctx, human["id"])
    r = await ctx.client.post(f"{I}/review/{human['id']}/overturn", json={"reason": "x"}, headers=ctx.h("rex"))
    assert r.status_code == 409


async def test_benchmark_replays_human_decisions(ctx: Ctx, monkeypatch):
    r = await ctx.client.post(f"{I}/agent/benchmarks", json={"provider": "clef"}, headers=ctx.h("admin"))
    assert r.status_code == 422
    monkeypatch.setattr(settings, "review_agent_allow_mock", True)
    assert (await ctx.client.post(f"{I}/agent/benchmarks", json={"provider": "mock"}, headers=ctx.h("rita"))).status_code == 403

    good = await _submit(ctx, content=b"a")
    await _approve(ctx, good["id"])
    good2 = await _submit(ctx, content=b"b")
    await _approve(ctx, good2["id"])
    file_id = await _upload(ctx, "alice", content=b"c")
    bad = (await ctx.client.post(
        f"{I}/transfers",
        json={"file_id": file_id, "recipient_user_id": ctx.ids["bob"], "purpose": "reject me"},
        headers=ctx.h("alice"),
    )).json()
    await ctx.client.post(f"{I}/review/{bad['id']}/reject", json={"reason": "no"}, headers=ctx.h("rita"))
    disagree = await _submit(ctx, content=b"d")
    await ctx.client.post(f"{I}/review/{disagree['id']}/reject", json={"reason": "no"}, headers=ctx.h("rita"))

    r = await ctx.client.post(f"{I}/agent/benchmarks", json={"provider": "mock"}, headers=ctx.h("admin"))
    assert r.status_code == 202
    runs = (await ctx.client.get(f"{I}/agent/benchmarks", headers=ctx.h("admin"))).json()
    report = runs[0]["report"]
    assert runs[0]["status"] == "done"
    assert report["cases"] == 4 and report["scored"] == 4
    assert report["human_approved"] == 2 and report["human_rejected"] == 2
    current = report["at_current_threshold"]
    assert current["tp"] == 2 and current["fp"] == 1 and current["tn"] == 1
    assert current["agreement"] == 0.75 and current["false_releases"] == 1
    assert "| 0.95 (current) | 0.75 |" in runs[0]["markdown"]
    async with ctx.maker() as s:
        events = (await s.execute(select(DecisionLogEntry.event))).scalars().all()
    assert "benchmark_run" in events
