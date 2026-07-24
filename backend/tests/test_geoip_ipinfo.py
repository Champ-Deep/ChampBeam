"""Geo/VPN via IPinfo — the datacenter-safe path that fixes 'Unknown' opens
when MaxMind isn't installed and free ip-api.com blocks the cloud egress IP."""

from __future__ import annotations

import httpx
import pytest

import app.services.geoip_service as geo
from app.core.config import settings


class _Resp:
    def __init__(self, data, status=200):
        self._d, self.status_code = data, status

    def json(self):
        return self._d


@pytest.mark.asyncio
async def test_lookup_ip_uses_ipinfo_when_configured(monkeypatch):
    monkeypatch.setattr(settings, "ipinfo_api_token", "tok")

    async def fake_get(self, url, params=None, headers=None):
        assert "ipinfo.io" in url
        return _Resp({
            "ip": "8.8.8.8", "city": "Mountain View", "region": "California",
            "country": "US", "loc": "37.4056,-122.0775", "org": "AS15169 Google LLC",
            "privacy": {"vpn": False, "proxy": False, "tor": False, "hosting": True},
        })

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)

    res = await geo.lookup_ip("8.8.8.8")  # no MaxMind DB in tests -> IPinfo path
    assert res is not None
    assert res["country_code"] == "US"
    assert res["city"] == "Mountain View" and res["region"] == "California"
    assert res["latitude"] == 37.4056 and res["longitude"] == -122.0775
    assert res["asn_org"] == "Google LLC"      # AS number stripped
    assert res["is_vpn"] is True               # hosting flag


@pytest.mark.asyncio
async def test_ipinfo_none_without_token(monkeypatch):
    monkeypatch.setattr(settings, "ipinfo_api_token", "")
    assert await geo._lookup_ipinfo("8.8.8.8") is None


@pytest.mark.asyncio
async def test_private_ip_short_circuits(monkeypatch):
    monkeypatch.setattr(settings, "ipinfo_api_token", "tok")
    assert await geo.lookup_ip("127.0.0.1") is None
    assert await geo.lookup_ip("10.0.0.5") is None
