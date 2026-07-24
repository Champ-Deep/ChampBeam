"""Tests for company intent (reverse-IP):

- the provider-agnostic resolver + IPinfo adapter parsing, and
- the /utm/analytics/company-intent aggregation (firmographic + free ASN
  fallback, VPN/ISP filtering, temperature).

No network — the IPinfo HTTP call is monkeypatched.
"""

from __future__ import annotations

import importlib
import uuid as _uuid
from datetime import datetime, timedelta
from typing import AsyncGenerator

import httpx
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.models.file_asset import FileAsset
from app.models.user import User
from app.models.utm import ClickEvent, LinkClick

_CURRENT: dict[str, TokenData] = {}


# ----------------------------------------------------------------------------
# Resolver / IPinfo adapter (unit)
# ----------------------------------------------------------------------------


class _FakeResp:
    def __init__(self, data, status=200):
        self._data, self.status_code = data, status

    def json(self):
        return self._data


@pytest.mark.asyncio
async def test_resolve_company_none_when_disabled(monkeypatch):
    from app.services.company_intel import resolve_company
    monkeypatch.setattr(settings, "company_intel_provider", "none")
    assert await resolve_company("8.8.8.8") is None
    monkeypatch.setattr(settings, "company_intel_provider", "asn")  # asn stores nothing
    assert await resolve_company("8.8.8.8") is None


@pytest.mark.asyncio
async def test_ipinfo_adapter_parses_company_and_ignores_bare_org(monkeypatch):
    from app.services.company_intel import resolve_company
    monkeypatch.setattr(settings, "company_intel_provider", "ipinfo")
    monkeypatch.setattr(settings, "ipinfo_api_token", "tok")

    payloads = {
        "1.1.1.1": {"ip": "1.1.1.1", "company": {"name": "Stripe", "domain": "stripe.com", "type": "business"}},
        "2.2.2.2": {"ip": "2.2.2.2", "org": "AS7922 Comcast Cable"},  # no company object
    }

    async def fake_get(self, url, params=None, headers=None):
        ip = url.rstrip("/json").rsplit("/", 1)[-1]
        return _FakeResp(payloads.get(ip, {}))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    got = await resolve_company("1.1.1.1")
    assert got == {"name": "Stripe", "domain": "stripe.com", "industry": None, "size": None, "type": "business"}
    # Only a bare ASN org, no firmographic company -> None (that's the asn signal).
    assert await resolve_company("2.2.2.2") is None
    # Token missing -> None even if provider is ipinfo.
    monkeypatch.setattr(settings, "ipinfo_api_token", "")
    assert await resolve_company("1.1.1.1") is None


# ----------------------------------------------------------------------------
# Aggregation endpoint (integration)
# ----------------------------------------------------------------------------


@pytest_asyncio.fixture(scope="function")
async def ci_ctx() -> AsyncGenerator[tuple[AsyncClient, async_sessionmaker], None]:
    from app.db.postgres import Base, get_db_session
    from app.main import app
    from app.middleware.rate_limit import limiter

    limiter.reset()
    engine = create_async_engine("sqlite+aiosqlite:///:memory:", future=True)

    @event.listens_for(engine.sync_engine, "connect")
    def _fk(conn, _rec):
        cur = conn.cursor()
        cur.execute("PRAGMA foreign_keys=ON")
        cur.close()

    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    async def override_get_db():
        async with maker() as s:
            try:
                yield s
                await s.commit()
            except Exception:
                await s.rollback()
                raise

    async def override_auth():
        return _CURRENT["token"]

    app.dependency_overrides[get_db_session] = override_get_db
    app.dependency_overrides[require_auth] = override_auth
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client, maker
    app.dependency_overrides.clear()
    await engine.dispose()


async def _seed(maker):
    uid = _uuid.uuid4()
    link_id, file_id = _uuid.uuid4(), _uuid.uuid4()
    async with maker() as s:
        s.add(User(id=uid, clerk_id="u", email="u@e.com"))
        s.add(LinkClick(id=link_id, user_id=uid, original_url="https://acme.com/q3", short_code="abc123"))
        s.add(FileAsset(
            id=file_id, user_id=uid, short_code="def456", filename="pitch-deck.pdf",
            kind="pdf", mime_type="application/pdf", size_bytes=10, storage_key="k",
            status="active", serve_mode="stream",
        ))
        await s.commit()
    return str(uid), link_id, file_id


def _ev(**kw):
    base = dict(id=_uuid.uuid4(), ip_address="9.9.9.9", clicked_at=datetime.utcnow(), is_vpn=False)
    base.update(kw)
    return ClickEvent(**base)


@pytest.mark.asyncio
async def test_company_intent_aggregates_filters_and_temps(ci_ctx, monkeypatch):
    client, maker = ci_ctx
    monkeypatch.setattr(settings, "company_intel_provider", "asn")
    uid, link_id, file_id = await _seed(maker)
    _CURRENT["token"] = TokenData(user_id=uid, email="u@e.com", clerk_user_id="u")

    now = datetime.utcnow()
    async with maker() as s:
        # Stripe: 3 firmographic opens today on the deck -> Hot.
        for _ in range(3):
            s.add(_ev(file_id=file_id, company_name="Stripe", company_domain="stripe.com",
                      company_type="business", city="San Francisco", country="United States",
                      clicked_at=now))
        # Notion Labs: 1 firmographic open today -> Warm.
        s.add(_ev(link_id=link_id, company_name="Notion Labs", company_domain="notion.so",
                  company_type="business", clicked_at=now))
        # A hosting-type firmographic hit -> filtered out.
        s.add(_ev(link_id=link_id, company_name="AWS EC2", company_type="hosting", clicked_at=now))
        # VPN open -> filtered out.
        s.add(_ev(file_id=file_id, company_name="Ghost", company_type="business", is_vpn=True, clicked_at=now))
        # Free ASN fallback: a real business network -> included as source=network.
        s.add(_ev(link_id=link_id, asn_org="Globex Corporation", clicked_at=now))
        # Free ASN fallback: a consumer ISP -> dropped as noise.
        s.add(_ev(link_id=link_id, asn_org="Comcast Cable Communications", clicked_at=now))
        await s.commit()

    resp = await client.get("/api/v1/utm/analytics/company-intent?days=14")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["provider"] == "asn"
    by_name = {c["name"]: c for c in body["companies"]}

    assert set(by_name) == {"Stripe", "Notion Labs", "Globex Corporation"}
    assert "AWS EC2" not in by_name and "Ghost" not in by_name and "Comcast Cable Communications" not in by_name

    assert by_name["Stripe"]["opens"] == 3
    assert by_name["Stripe"]["temperature"] == "hot"
    assert by_name["Stripe"]["source"] == "firmographic"
    assert by_name["Stripe"]["last_asset"] == "pitch-deck.pdf"
    assert by_name["Stripe"]["country"] == "United States"

    assert by_name["Notion Labs"]["temperature"] == "warm"
    assert by_name["Globex Corporation"]["source"] == "network"

    # Hot sorts above warm.
    assert body["companies"][0]["name"] == "Stripe"


@pytest.mark.asyncio
async def test_company_intent_marks_stale_company_cool(ci_ctx, monkeypatch):
    client, maker = ci_ctx
    monkeypatch.setattr(settings, "company_intel_provider", "asn")
    uid, link_id, file_id = await _seed(maker)
    _CURRENT["token"] = TokenData(user_id=uid, email="u@e.com", clerk_user_id="u")

    old = datetime.utcnow() - timedelta(days=12)
    async with maker() as s:
        s.add(_ev(link_id=link_id, company_name="Figma", company_domain="figma.com",
                  company_type="business", clicked_at=old))
        await s.commit()

    body = (await client.get("/api/v1/utm/analytics/company-intent?days=30")).json()
    assert body["companies"][0]["name"] == "Figma"
    assert body["companies"][0]["temperature"] == "cool"
