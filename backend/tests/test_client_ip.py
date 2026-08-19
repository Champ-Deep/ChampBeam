"""Client-IP resolution: the visitor's IP must survive a CDN proxy chain."""

from __future__ import annotations

from app.api.access_control import client_ip


class _Req:
    def __init__(self, headers: dict, peer: str | None = "10.0.0.1"):
        self.headers = headers
        self.client = type("C", (), {"host": peer})() if peer else None


def test_prefers_cloudflare_connecting_ip_over_forwarded_chain():
    """Behind Cloudflare the CDN's own egress can head X-Forwarded-For; the
    visitor IP must still win, otherwise every open geo-locates to a datacenter."""
    req = _Req({
        "CF-Connecting-IP": "49.205.201.248",
        "X-Forwarded-For": "172.68.147.138, 10.0.0.5",
        "X-Real-IP": "172.68.147.138",
    })
    assert client_ip(req) == "49.205.201.248"


def test_true_client_ip_used_when_present():
    req = _Req({"True-Client-IP": "203.0.113.9", "X-Forwarded-For": "172.68.1.1"})
    assert client_ip(req) == "203.0.113.9"


def test_falls_back_to_forwarded_for_without_cdn_headers():
    req = _Req({"X-Forwarded-For": "24.48.0.1, 10.0.0.5"})
    assert client_ip(req) == "24.48.0.1"


def test_ignores_our_own_nginx_real_ip_when_it_is_the_proxy():
    """X-Real-IP is set by our nginx to the immediate peer; it must never
    outrank X-Forwarded-For, or a Cloudflare-fronted deploy loses the visitor."""
    req = _Req({"X-Real-IP": "172.68.147.138", "X-Forwarded-For": "49.205.201.248"})
    assert client_ip(req) == "49.205.201.248"


def test_falls_back_to_peer_when_no_headers():
    assert client_ip(_Req({}, peer="198.51.100.7")) == "198.51.100.7"


def test_none_when_nothing_available():
    assert client_ip(_Req({}, peer=None)) is None
