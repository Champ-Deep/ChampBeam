"""MaxMind GeoIP2 web service (GeoIP Insights) — the datacenter-safe HTTPS path
that resolves geo + VPN in production without shipping a local database.

Maps to docs/TESTING.md § Location / geo: GEO-6..GEO-9.
"""

from __future__ import annotations

from types import SimpleNamespace

import geoip2.webservice
import pytest

import app.services.geoip_service as geo
from app.core.config import settings


def _insights_response():
    return SimpleNamespace(
        country=SimpleNamespace(name="United States", iso_code="US"),
        subdivisions=SimpleNamespace(most_specific=SimpleNamespace(name="California")),
        city=SimpleNamespace(name="Mountain View"),
        location=SimpleNamespace(latitude=37.4056, longitude=-122.0775),
        traits=SimpleNamespace(
            isp="Google LLC",
            autonomous_system_organization="GOOGLE",
            organization="Google Cloud",
            is_anonymous_vpn=True,
            is_public_proxy=False,
            is_tor_exit_node=False,
            is_hosting_provider=True,
            is_residential_proxy=False,
            is_anonymous=True,
        ),
    )


class _FakeClient:
    """Stand-in for geoip2.webservice.AsyncClient (async context manager)."""

    last_args = None

    def __init__(self, account_id, license_key, host=None, **kw):
        _FakeClient.last_args = (account_id, license_key, host)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def insights(self, ip):
        return _insights_response()

    async def city(self, ip):
        # City endpoint: geo + ASN, but no anonymizer flags.
        return SimpleNamespace(
            country=SimpleNamespace(name="United States", iso_code="US"),
            subdivisions=SimpleNamespace(most_specific=SimpleNamespace(name="Virginia")),
            city=SimpleNamespace(name="Ashburn"),
            location=SimpleNamespace(latitude=39.0, longitude=-77.5),
            traits=SimpleNamespace(isp="Amazon Technologies", organization="AWS"),
        )


@pytest.fixture(autouse=True)
def _configure(monkeypatch):
    monkeypatch.setattr(settings, "maxmind_account_id", "123456")
    monkeypatch.setattr(settings, "maxmind_license_key", "secret_key")
    monkeypatch.setattr(settings, "maxmind_ws_host", "geoip.maxmind.com")
    monkeypatch.setattr(settings, "maxmind_ws_endpoint", "insights")
    monkeypatch.setattr(geoip2.webservice, "AsyncClient", _FakeClient)


@pytest.mark.asyncio
async def test_geo6_insights_parses_geo_isp_and_vpn():
    res = await geo._lookup_maxmind_ws("8.8.8.8")
    assert res is not None
    assert res["country_code"] == "US"
    assert res["country"] == "United States"
    assert res["region"] == "California"
    assert res["city"] == "Mountain View"
    assert res["latitude"] == 37.4056 and res["longitude"] == -122.0775
    assert res["asn_org"] == "Google LLC"        # isp wins over org
    assert res["is_vpn"] is True                  # anonymizer flag
    # account id was passed as an int, not a string.
    assert _FakeClient.last_args[0] == 123456


@pytest.mark.asyncio
async def test_geo7_none_without_credentials(monkeypatch):
    monkeypatch.setattr(settings, "maxmind_account_id", "")
    assert await geo._lookup_maxmind_ws("8.8.8.8") is None
    monkeypatch.setattr(settings, "maxmind_account_id", "123456")
    monkeypatch.setattr(settings, "maxmind_license_key", "")
    assert await geo._lookup_maxmind_ws("8.8.8.8") is None


@pytest.mark.asyncio
async def test_geo8_lookup_ip_prefers_maxmind_ws_when_no_local_db(monkeypatch):
    # No local readers in the test env, and IPinfo/ip-api should never be reached
    # because MaxMind resolves first.
    async def _boom(ip):  # pragma: no cover - must not be called
        raise AssertionError("fallback provider should not be called")

    monkeypatch.setattr(geo, "_lookup_ipinfo", _boom)
    monkeypatch.setattr(geo, "_lookup_ipapi", _boom)
    res = await geo.lookup_ip("8.8.8.8")
    assert res is not None
    assert res["city"] == "Mountain View"
    assert res["is_vpn"] is True


@pytest.mark.asyncio
async def test_geo9_city_endpoint_infers_vpn_from_hosting_asn(monkeypatch):
    monkeypatch.setattr(settings, "maxmind_ws_endpoint", "city")
    res = await geo._lookup_maxmind_ws("52.1.2.3")
    assert res is not None
    assert res["city"] == "Ashburn"
    assert res["asn_org"] == "Amazon Technologies"
    # No anonymizer flags on the City endpoint -> inferred from the hosting ASN.
    assert res["is_vpn"] is True


@pytest.mark.asyncio
async def test_private_ip_short_circuits():
    assert await geo.lookup_ip("127.0.0.1") is None
    assert await geo.lookup_ip("10.0.0.5") is None
