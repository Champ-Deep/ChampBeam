"""ensure_geoip must NOT block boot downloading local GeoIP DBs when a
datacenter-safe web provider (MaxMind web service / IPinfo) is configured — that
pre-uvicorn download was timing out the Railway healthcheck.

Maps to docs/TESTING.md § Location / geo: GEO-10..12.
"""

from __future__ import annotations

import pytest

import scripts.ensure_geoip as eg


def _no_download(monkeypatch):
    def _boom(*a, **k):
        raise AssertionError("ensure_geoip should not download in this case")

    monkeypatch.setattr(eg, "_download", _boom)


def test_geo10_skips_download_when_maxmind_web_service_configured(monkeypatch):
    monkeypatch.setenv("MAXMIND_ACCOUNT_ID", "1375991")
    monkeypatch.delenv("GEOIP_FORCE_DOWNLOAD", raising=False)
    _no_download(monkeypatch)
    eg.main()  # returns immediately, no download attempted


def test_geo11_skips_download_when_ipinfo_configured(monkeypatch):
    monkeypatch.delenv("MAXMIND_ACCOUNT_ID", raising=False)
    monkeypatch.setenv("IPINFO_API_TOKEN", "tok")
    monkeypatch.delenv("GEOIP_FORCE_DOWNLOAD", raising=False)
    _no_download(monkeypatch)
    eg.main()


def test_geo12_force_download_overrides_skip(monkeypatch):
    monkeypatch.setenv("MAXMIND_ACCOUNT_ID", "1375991")
    monkeypatch.setenv("MAXMIND_LICENSE_KEY", "key")
    monkeypatch.setenv("GEOIP_FORCE_DOWNLOAD", "1")
    # Point the editions at paths that don't exist so main() treats them missing.
    monkeypatch.setattr(eg, "EDITIONS", {"GeoLite2-City": "/nonexistent/City.mmdb"})
    called = {"n": 0}

    def _fake(edition, key, dest):
        called["n"] += 1

    monkeypatch.setattr(eg, "_download", _fake)
    eg.main()
    assert called["n"] == 1  # force bypasses the skip and attempts the download
