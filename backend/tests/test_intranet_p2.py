from __future__ import annotations

import json
from datetime import datetime, timedelta

import httpx
import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.intranet import DecisionLogEntry
from app.services import file_expiry, review_agent
from tests.test_intranet import I, Ctx, _approve, _events, _submit, ctx  # noqa: F401
from tests.test_intranet_p1 import _agent_rows, _set, _settings, _transfer


async def _ticket(c: Ctx, tid: str, who: str = "bob", **body) -> httpx.Response:
    return await c.client.post(f"{I}/transfers/{tid}/download-ticket", json=body, headers=c.h(who))


async def test_access_code_gates_recipient_download(ctx: Ctx):
    t = await _submit(ctx)
    r = await ctx.client.post(f"{I}/review/{t['id']}/approve", json={"access_code": "12ab"}, headers=ctx.h("rita"))
    assert r.status_code == 422
    released = await _approve(ctx, t["id"], access_code="4821")
    assert released["access_code_required"] is True
    row = await _transfer(ctx, t["id"])
    assert row.access_code_hash and "4821" not in row.access_code_hash

    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 403 and "access code" in r.json()["detail"]
    assert (await _ticket(ctx, t["id"])).status_code == 403
    assert (await _ticket(ctx, t["id"], access_code="0000")).status_code == 403

    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers={**ctx.h("bob"), "X-Access-Code": "4821"})
    assert r.status_code == 200 and r.content == b"hello data team"
    ticket = (await _ticket(ctx, t["id"], access_code="4821")).json()
    r = await ctx.client.get(ticket["url"])
    assert r.status_code == 200 and r.content == b"hello data team"

    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("alice"))
    assert r.status_code == 200

    events = await _events(ctx, t["id"])
    assert events.count("access_code_failed") == 1
    async with ctx.maker() as s:
        approved = (
            await s.execute(
                select(DecisionLogEntry).where(
                    DecisionLogEntry.transfer_id == row.id, DecisionLogEntry.event == "approved"
                )
            )
        ).scalar_one()
    assert approved.detail["access_code"] is True and "4821" not in json.dumps(approved.detail)
    verify = (await ctx.client.get(f"{I}/log/verify", headers=ctx.h("admin"))).json()
    assert verify["ok"] is True


async def test_access_code_locks_after_five_attempts(ctx: Ctx):
    t = await _submit(ctx)
    await _approve(ctx, t["id"], access_code="77441")
    for _ in range(5):
        assert (await _ticket(ctx, t["id"], access_code="11111")).status_code == 403
    assert (await _ticket(ctx, t["id"], access_code="77441")).status_code == 429
    assert (await _events(ctx, t["id"])).count("access_code_failed") == 5

    await _set(ctx, t["id"], access_code_window_at=datetime.utcnow() - timedelta(minutes=11))
    assert (await _ticket(ctx, t["id"], access_code="77441")).status_code == 200
    for _ in range(4):
        assert (await _ticket(ctx, t["id"], access_code="11111")).status_code == 403
    assert (await _ticket(ctx, t["id"], access_code="77441")).status_code == 200


async def test_ticket_issued_before_code_is_refused(ctx: Ctx):
    t = await _submit(ctx)
    early = (await _ticket(ctx, t["id"])).json()
    await _approve(ctx, t["id"], access_code="5050")
    r = await ctx.client.get(early["url"])
    assert r.status_code == 403
    assert "consumed" not in await _events(ctx, t["id"])


async def test_release_without_code_needs_none(ctx: Ctx):
    t = await _submit(ctx)
    released = await _approve(ctx, t["id"])
    assert released["access_code_required"] is False
    r = await ctx.client.get(f"{I}/transfers/{t['id']}/download", headers=ctx.h("bob"))
    assert r.status_code == 200


def _jev_answers(p: float, per_criterion: float = 0.9) -> dict:
    answers = {review_agent.JEV_DECISION_KEY: {"type": "noul", "noul": p}}
    for c in review_agent.CRITERIA:
        answers[c["name"]] = {"type": "noul", "noul": per_criterion}
    return {"answers": answers, "model": "typesafe/jev-1.13"}


def _mock_jev(monkeypatch, replies) -> list[dict]:
    received: list[dict] = []
    replies = iter(replies)

    def handler(request: httpx.Request) -> httpx.Response:
        assert str(request.url) == settings.jev_url
        assert request.headers["authorization"] == "Bearer or-key"
        received.append(json.loads(request.content))
        return next(replies)

    original = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(review_agent.httpx, "AsyncClient", client_factory)
    return received


async def test_jev_needs_api_key_and_logs_signoff(ctx: Ctx, monkeypatch):
    r = await ctx.client.put(f"{I}/review-settings", json={"agent_mode": "jev"}, headers=ctx.h("admin"))
    assert r.status_code == 422 and "JEV_API_KEY" in r.json()["detail"]
    me = (await ctx.client.get(f"{I}/me", headers=ctx.h("admin"))).json()
    assert "jev" not in me["agent"]["modes"] and me["agent"]["jev_configured"] is False
    with pytest.raises(review_agent.ScorerError):
        review_agent.get_scorer("jev")

    monkeypatch.setattr(settings, "jev_api_key", "or-key")
    monkeypatch.setattr(settings, "jev_signoff_ref", "IT-2026-114 (Nandish, email 2026-11-10)")
    me = (await ctx.client.get(f"{I}/me", headers=ctx.h("admin"))).json()
    assert "jev" in me["agent"]["modes"] and "jev" in me["agent"]["benchmark_providers"]
    r = await ctx.client.put(f"{I}/review-settings", json={"agent_mode": "jev"}, headers=ctx.h("admin"))
    assert r.status_code == 200
    async with ctx.maker() as s:
        row = (
            await s.execute(
                select(DecisionLogEntry)
                .where(DecisionLogEntry.event == "settings_changed")
                .order_by(DecisionLogEntry.id.desc())
                .limit(1)
            )
        ).scalar_one()
    assert row.detail["jev_signoff_ref"].startswith("IT-2026-114")


async def test_jev_scores_metadata_only_and_falls_back(ctx: Ctx, monkeypatch):
    monkeypatch.setattr(settings, "jev_api_key", "or-key")
    received = _mock_jev(
        monkeypatch,
        [
            httpx.Response(200, json=_jev_answers(0.98)),
            httpx.Response(200, json=_jev_answers(0.5)),
            httpx.Response(200, json={"answers": {review_agent.JEV_DECISION_KEY: {"type": "noul", "noul": 1.7}}}),
        ],
    )
    tids = []
    for content in (b"one", b"two", b"three"):
        t = await _submit(ctx, content=content)
        await _set(ctx, t["id"], scan_status="clean", agent_window_ends_at=datetime.utcnow() - timedelta(minutes=1),
                   check_results={"size": "ok", "type": "ok", "malware_scan": "clean"})
        tids.append(t["id"])
    await _settings(ctx, agent_mode="jev", agent_input_mode="content_excerpt")
    await file_expiry.sweep_transfers()

    states = [(await _transfer(ctx, tid)).state for tid in tids]
    assert states == ["released", "submitted", "submitted"]
    assert len(received) == 3
    for body in received:
        assert body["model"] == "typesafe/jev-1.13"
        assert body["state"]["input_mode"] == "metadata_only" and "content_excerpt" not in body["state"]
        assert set(body["questions"]) == {review_agent.JEV_DECISION_KEY, *(c["name"] for c in review_agent.CRITERIA)}
        assert all(q["type"] == "noul" for q in body["questions"].values())
    approved = [r for r in await _agent_rows(ctx, tids[0]) if r.event == "approved"][0]
    assert approved.actor_id == "agent:jev" and approved.agent_model == "typesafe/jev-1.13@1.13"
    assert approved.agent_input_mode == "metadata_only" and approved.agent_p_approve == pytest.approx(0.98)
    assert "below" in (await _transfer(ctx, tids[1])).escalation_reason
    assert "Scorer unavailable" in (await _transfer(ctx, tids[2])).escalation_reason


async def test_jev_error_falls_back_to_clef(ctx: Ctx, monkeypatch):
    monkeypatch.setattr(settings, "jev_api_key", "or-key")
    monkeypatch.setattr(settings, "jev_signoff_ref", "IT-2026-114")
    monkeypatch.setattr(settings, "clef_url", "http://clef.internal/score")
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if str(request.url) == settings.jev_url:
            return httpx.Response(503)
        return httpx.Response(200, json={"p_approve": 0.99, "reasons": ["ok"], "model": "clef-small", "version": "7"})

    original = httpx.AsyncClient

    def client_factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return original(*args, **kwargs)

    monkeypatch.setattr(review_agent.httpx, "AsyncClient", client_factory)
    t = await _submit(ctx)
    await _set(ctx, t["id"], scan_status="clean", agent_window_ends_at=datetime.utcnow() - timedelta(minutes=1),
               check_results={"size": "ok", "type": "ok", "malware_scan": "clean"})
    await _settings(ctx, agent_mode="jev")
    await file_expiry.sweep_transfers()
    assert calls == [settings.jev_url, "http://clef.internal/score"]
    row = await _transfer(ctx, t["id"])
    assert row.state == "released" and row.decided_by_id == "agent:clef"


async def test_jev_never_runs_without_api_key(ctx: Ctx, monkeypatch):
    received = _mock_jev(monkeypatch, [])
    t = await _submit(ctx)
    await _set(ctx, t["id"], scan_status="clean", agent_window_ends_at=datetime.utcnow() - timedelta(minutes=1),
               check_results={"size": "ok", "type": "ok", "malware_scan": "clean"})
    await _settings(ctx, agent_mode="jev")
    await file_expiry.sweep_transfers()
    assert received == []
    row = await _transfer(ctx, t["id"])
    assert row.state == "submitted" and "Scorer unavailable" in row.escalation_reason
