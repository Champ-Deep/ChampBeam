"""MaxMind credit/usage tracking: bookkeeping, burn rate, spend, endpoint auth."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core.config import settings
from app.services import maxmind_usage


async def _key(monkeypatch):
    from tests.test_api_keys import _mint_key

    raw, _, user = await _mint_key()
    from app.db import postgres
    async with postgres.async_session_maker() as session:
        owner = await session.get(type(user), user.id)
        owner.clerk_id = "user_platform_admin"
        await session.commit()
    monkeypatch.setattr(settings, "system_admin_clerk_ids", "user_platform_admin")
    return {"X-API-Key": raw}


@pytest.mark.asyncio
async def test_record_lookup_accumulates_and_keeps_latest_balance(app_client):
    await maxmind_usage.record_lookup(queries_remaining=24881, ok=True)
    await maxmind_usage.record_lookup(queries_remaining=24880, ok=True)
    await maxmind_usage.record_lookup(queries_remaining=None, ok=False)

    from app.db import postgres

    async with postgres.async_session_maker() as s:
        summary = await maxmind_usage.usage_summary(s)

    assert summary["lookups_today"] == 2
    assert summary["errors_window"] == 1
    # a failed call must not wipe the last known balance
    assert summary["queries_remaining"] == 24880
    assert summary["lifetime_lookups"] == 2
    assert summary["status"] == "ok"


@pytest.mark.asyncio
async def test_burn_rate_projection_and_spend(app_client, monkeypatch):
    from app.db import postgres
    from sqlalchemy import text

    # two observed days: 100 + 300 lookups -> 200/day, 2000 credits -> 10 days
    async with postgres.async_session_maker() as s:
        yesterday = datetime.utcnow().date() - timedelta(days=1)
        today = datetime.utcnow().date()
        await s.execute(
            text("INSERT INTO maxmind_usage (day, lookups, errors, queries_remaining, updated_at) "
                 "VALUES (:d1,100,0,2100,:t1), (:d2,300,0,2000,:t2)"),
            {"d1": yesterday, "t1": datetime.utcnow() - timedelta(days=1),
             "d2": today, "t2": datetime.utcnow()},
        )
        await s.commit()

    monkeypatch.setattr(settings, "maxmind_unit_price_usd", 0.002)
    async with postgres.async_session_maker() as s:
        summary = await maxmind_usage.usage_summary(s)

    assert summary["avg_daily"] == 200.0
    assert summary["days_left"] == 10
    assert summary["projected_exhaustion"] == (datetime.utcnow().date() + timedelta(days=10)).isoformat()
    assert summary["spend_window_usd"] == pytest.approx(0.80)
    assert summary["spend_lifetime_usd"] == pytest.approx(0.80)


@pytest.mark.asyncio
async def test_thresholds_grade_the_balance(monkeypatch):
    monkeypatch.setattr(settings, "maxmind_credit_warn_threshold", 5000)
    monkeypatch.setattr(settings, "maxmind_credit_crit_threshold", 1000)
    assert maxmind_usage._status(24881) == "ok"
    assert maxmind_usage._status(5000) == "warning"
    assert maxmind_usage._status(999) == "critical"
    assert maxmind_usage._status(None) == "unknown"


@pytest.mark.asyncio
async def test_endpoints_need_auth_and_report(app_client, monkeypatch):
    assert (await app_client.get("/api/v1/system/maxmind")).status_code == 401
    assert (await app_client.get("/api/v1/system/status")).status_code == 401

    from tests.test_api_keys import _mint_key
    ordinary, _, _ = await _mint_key()
    for path in ("/api/v1/system/maxmind", "/api/v1/system/status"):
        assert (await app_client.get(path, headers={"X-API-Key": ordinary})).status_code == 403
    assert (await app_client.get("/api/v1/system/access", headers={"X-API-Key": ordinary})).json() == {"is_admin": False}

    # a deployment that really does call MaxMind, so the balance is graded
    monkeypatch.setattr(settings, "maxmind_account_id", "123456")
    monkeypatch.setattr(settings, "maxmind_license_key", "test-key")
    headers = await _key(monkeypatch)
    assert (await app_client.get("/api/v1/system/access", headers=headers)).json() == {"is_admin": True}
    await maxmind_usage.record_lookup(queries_remaining=42, ok=True)

    r = await app_client.get("/api/v1/system/maxmind", headers=headers)
    assert r.status_code == 200 and r.json()["queries_remaining"] == 42

    s = await app_client.get("/api/v1/system/status", headers=headers)
    assert s.status_code == 200
    body = s.json()
    assert body["checks"]["database"]["status"] == "ok"
    # 42 credits is under the critical threshold -> the monitor must not read "ok"
    assert body["checks"]["maxmind"]["status"] == "critical"
    assert body["ok"] is False


@pytest.mark.asyncio
async def test_status_reports_off_when_the_service_is_not_configured(app_client, monkeypatch):
    """A deployment with no MaxMind credentials is configured that way on
    purpose. It must read as "off", never as a fault the monitor pages about."""
    monkeypatch.setattr(settings, "maxmind_account_id", "")
    monkeypatch.setattr(settings, "maxmind_license_key", "")

    headers = await _key(monkeypatch)
    r = await app_client.get("/api/v1/system/status", headers=headers)
    assert r.status_code == 200
    assert r.json()["checks"]["maxmind"]["status"] == "off"
    assert r.json()["checks"]["maxmind"]["configured"] is False
    assert r.json()["ok"] is True


@pytest.mark.asyncio
async def test_usage_bookkeeping_never_breaks_geo(monkeypatch):
    """A failing ledger must not propagate into the geo chain."""
    from app.services import geoip_service

    async def boom(**_kwargs):
        raise RuntimeError("ledger down")

    monkeypatch.setattr(maxmind_usage, "record_lookup", boom)
    await geoip_service._record_ws_usage(123, ok=True)  # must not raise
