"""Unit tests for Clerk production hardening: issuer/azp derivation, org claim
extraction, role normalization, and svix webhook verification."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest

from app.core.config import settings
from app.core.security import _azp_authorized, _extract_org_claims, _normalize_role
from app.services import clerk_client


def _restore(attr, value):
    setattr(settings, attr, value)


def test_resolved_issuer_from_publishable_key():
    host = "clerk.example.com"
    pk = "pk_test_" + base64.urlsafe_b64encode((host + "$").encode()).decode().rstrip("=")
    old_pk, old_iss = settings.clerk_publishable_key, settings.clerk_issuer
    try:
        settings.clerk_issuer = ""
        settings.clerk_publishable_key = pk
        assert settings.resolved_clerk_issuer == "https://clerk.example.com"
    finally:
        _restore("clerk_publishable_key", old_pk)
        _restore("clerk_issuer", old_iss)


def test_explicit_issuer_overrides_publishable_key():
    old_iss = settings.clerk_issuer
    try:
        settings.clerk_issuer = "https://clerk.champbeam.com/"
        assert settings.resolved_clerk_issuer == "https://clerk.champbeam.com"
    finally:
        _restore("clerk_issuer", old_iss)


def test_clerk_environment_from_secret_prefix():
    old = settings.clerk_secret_key
    try:
        settings.clerk_secret_key = "sk_live_abc"
        assert settings.clerk_environment == "production"
        settings.clerk_secret_key = "sk_test_abc"
        assert settings.clerk_environment == "development"
    finally:
        _restore("clerk_secret_key", old)


def test_authorized_parties_fallback_to_frontend_url():
    old_parties, old_front, old_cors = (
        settings.clerk_authorized_parties,
        settings.frontend_url,
        settings.cors_allow_origins,
    )
    try:
        settings.clerk_authorized_parties = ""
        settings.frontend_url = "https://app.champbeam.com/"
        settings.cors_allow_origins = "https://preview.champbeam.com"
        parties = settings.clerk_authorized_parties_list
        assert "https://app.champbeam.com" in parties
        assert "https://preview.champbeam.com" in parties
    finally:
        _restore("clerk_authorized_parties", old_parties)
        _restore("frontend_url", old_front)
        _restore("cors_allow_origins", old_cors)


def test_azp_exact_match_in_allowlist():
    """AUTH-1: an origin in the strict allowlist authorizes regardless of regex."""
    old_parties, old_front, old_cors, old_rx = (
        settings.clerk_authorized_parties,
        settings.frontend_url,
        settings.cors_allow_origins,
        settings.cors_allow_origin_regex,
    )
    try:
        settings.clerk_authorized_parties = "https://app.champbeam.com"
        settings.frontend_url = ""
        settings.cors_allow_origins = ""
        settings.cors_allow_origin_regex = ""
        assert _azp_authorized("https://app.champbeam.com/") is True
        assert _azp_authorized("https://evil.example.com") is False
    finally:
        _restore("clerk_authorized_parties", old_parties)
        _restore("frontend_url", old_front)
        _restore("cors_allow_origins", old_cors)
        _restore("cors_allow_origin_regex", old_rx)


def test_azp_preview_origin_allowed_via_cors_regex():
    """AUTH-2: a per-deploy Vercel preview origin not in the allowlist still
    authenticates when it matches the operator-set CORS_ALLOW_ORIGIN_REGEX."""
    old_parties, old_front, old_cors, old_rx = (
        settings.clerk_authorized_parties,
        settings.frontend_url,
        settings.cors_allow_origins,
        settings.cors_allow_origin_regex,
    )
    try:
        settings.clerk_authorized_parties = "https://app.champbeam.com"
        settings.frontend_url = ""
        settings.cors_allow_origins = ""
        settings.cors_allow_origin_regex = r"https://champbeam-[a-z0-9-]+\.vercel\.app"
        assert _azp_authorized("https://champbeam-git-claude-abc123-projects.vercel.app") is True
        assert _azp_authorized("https://champbeam-4zdm6dxf9-deep.vercel.app") is True
        assert _azp_authorized("https://not-champbeam.vercel.app") is False
    finally:
        _restore("clerk_authorized_parties", old_parties)
        _restore("frontend_url", old_front)
        _restore("cors_allow_origins", old_cors)
        _restore("cors_allow_origin_regex", old_rx)


def test_azp_no_regex_configured_is_strict():
    """AUTH-3: with no regex set, only the exact allowlist authorizes (unchanged)."""
    old_parties, old_front, old_cors, old_rx = (
        settings.clerk_authorized_parties,
        settings.frontend_url,
        settings.cors_allow_origins,
        settings.cors_allow_origin_regex,
    )
    try:
        settings.clerk_authorized_parties = "https://app.champbeam.com"
        settings.frontend_url = ""
        settings.cors_allow_origins = ""
        settings.cors_allow_origin_regex = ""
        assert _azp_authorized("https://champbeam-preview.vercel.app") is False
    finally:
        _restore("clerk_authorized_parties", old_parties)
        _restore("frontend_url", old_front)
        _restore("cors_allow_origins", old_cors)
        _restore("cors_allow_origin_regex", old_rx)


def test_normalize_role_strips_org_prefix():
    assert _normalize_role("org:admin") == "admin"
    assert _normalize_role("admin") == "admin"
    assert _normalize_role("org:member") == "member"
    assert _normalize_role(None) is None


def test_extract_org_claims_v1():
    org_id, role, slug = _extract_org_claims(
        {"org_id": "org_123", "org_role": "org:admin", "org_slug": "acme"}
    )
    assert (org_id, role, slug) == ("org_123", "admin", "acme")


def test_extract_org_claims_v2_compact():
    org_id, role, slug = _extract_org_claims(
        {"o": {"id": "org_456", "rol": "member", "slg": "sales"}}
    )
    assert (org_id, role, slug) == ("org_456", "member", "sales")


def test_extract_org_claims_absent():
    assert _extract_org_claims({"sub": "user_1"}) == (None, None, None)


def _sign(secret_b64: str, msg_id: str, ts: int, body: bytes) -> str:
    key = base64.b64decode(secret_b64)
    signed = f"{msg_id}.{ts}.{body.decode()}".encode()
    sig = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    return f"v1,{sig}"


def test_verify_webhook_valid_and_tampered():
    secret_b64 = base64.b64encode(b"super-secret-key").decode()
    old = settings.clerk_webhook_secret
    try:
        settings.clerk_webhook_secret = "whsec_" + secret_b64
        body = json.dumps({"type": "user.created", "data": {"id": "user_1"}}).encode()
        ts = int(time.time())
        good = {"svix-id": "msg_1", "svix-timestamp": str(ts), "svix-signature": _sign(secret_b64, "msg_1", ts, body)}
        assert clerk_client.verify_webhook(good, body) is True

        # Tampered body must fail.
        assert clerk_client.verify_webhook(good, body + b"x") is False
        # Stale timestamp must fail.
        stale = dict(good)
        stale["svix-timestamp"] = str(ts - 10_000)
        assert clerk_client.verify_webhook(stale, body) is False
    finally:
        _restore("clerk_webhook_secret", old)


def test_verify_webhook_no_secret_returns_false():
    old = settings.clerk_webhook_secret
    try:
        settings.clerk_webhook_secret = ""
        assert clerk_client.verify_webhook({"svix-id": "x"}, b"{}") is False
    finally:
        _restore("clerk_webhook_secret", old)
