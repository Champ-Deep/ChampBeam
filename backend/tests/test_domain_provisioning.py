"""Self-serve BYOD provisioning: state machine + internal provisioner API."""

from __future__ import annotations

from uuid import uuid4

import pytest

from app.core.config import settings
from app.models.domain import (
    Domain,
    STATUS_ACTIVE,
    STATUS_FAILED,
    STATUS_PENDING_CNAME,
    STATUS_PENDING_SSL,
)
from app.models.user import User
from app.services import domain_provisioning


async def _make_domain(status: str = STATUS_PENDING_CNAME) -> Domain:
    from app.db import postgres

    async with postgres.async_session_maker() as session:
        user = User(id=uuid4(), email=f"{uuid4().hex[:10]}@example.com", is_active=True)
        session.add(user)
        await session.flush()
        domain = Domain(
            id=uuid4(),
            user_id=user.id,
            hostname=f"track-{uuid4().hex[:8]}.example.com",
            status=status,
        )
        session.add(domain)
        await session.commit()
        return domain


def _enable_local_byod(monkeypatch):
    monkeypatch.setattr(settings, "platform_ipv4", "64.227.154.215")
    monkeypatch.setattr(settings, "byod_cname_target", "origin.example.com")


@pytest.mark.asyncio
async def test_dns_verified_advances_to_pending_ssl(app_client, monkeypatch):
    _enable_local_byod(monkeypatch)

    async def not_reachable(hostname):
        return False

    async def dns_ok(hostname):
        return True

    monkeypatch.setattr(domain_provisioning, "verify_reachable", not_reachable)
    monkeypatch.setattr(domain_provisioning, "dns_points_here", dns_ok)

    domain = await _make_domain()
    await domain_provisioning.apply_local_status(domain)
    assert domain.status == STATUS_PENDING_SSL
    assert domain.provision_requested_at is not None
    assert domain.ssl_status == "provisioning"


@pytest.mark.asyncio
async def test_no_dns_stays_pending_cname(app_client, monkeypatch):
    _enable_local_byod(monkeypatch)

    async def nope(hostname):
        return False

    monkeypatch.setattr(domain_provisioning, "verify_reachable", nope)
    monkeypatch.setattr(domain_provisioning, "dns_points_here", nope)

    domain = await _make_domain()
    await domain_provisioning.apply_local_status(domain)
    assert domain.status == STATUS_PENDING_CNAME
    assert "CNAME" in (domain.verification_errors or {}).get("message", "")


@pytest.mark.asyncio
async def test_reachable_goes_straight_to_active(app_client, monkeypatch):
    async def reachable(hostname):
        return True

    monkeypatch.setattr(domain_provisioning, "verify_reachable", reachable)
    domain = await _make_domain()
    await domain_provisioning.apply_local_status(domain)
    assert domain.status == STATUS_ACTIVE
    assert domain.verified_at is not None


@pytest.mark.asyncio
async def test_internal_api_404_without_configured_token(app_client, monkeypatch):
    monkeypatch.setattr(settings, "provisioner_token", "")
    resp = await app_client.get(
        "/api/v1/internal/provisioning/domains",
        headers={"X-Provisioner-Token": "anything"},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_internal_api_401_with_wrong_token(app_client, monkeypatch):
    monkeypatch.setattr(settings, "provisioner_token", "secret-token")
    resp = await app_client.get(
        "/api/v1/internal/provisioning/domains",
        headers={"X-Provisioner-Token": "wrong"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_internal_api_lists_and_resolves_success(app_client, monkeypatch):
    monkeypatch.setattr(settings, "provisioner_token", "secret-token")
    headers = {"X-Provisioner-Token": "secret-token"}

    domain = await _make_domain(status=STATUS_PENDING_SSL)

    listed = await app_client.get("/api/v1/internal/provisioning/domains", headers=headers)
    assert listed.status_code == 200
    jobs = listed.json()
    assert any(j["id"] == str(domain.id) and j["hostname"] == domain.hostname for j in jobs)

    async def reachable(hostname):
        return True

    monkeypatch.setattr(domain_provisioning, "verify_reachable", reachable)
    result = await app_client.post(
        f"/api/v1/internal/provisioning/domains/{domain.id}/result",
        json={"ok": True},
        headers=headers,
    )
    assert result.status_code == 200
    assert result.json()["status"] == STATUS_ACTIVE


@pytest.mark.asyncio
async def test_internal_api_three_failures_park_domain(app_client, monkeypatch):
    monkeypatch.setattr(settings, "provisioner_token", "secret-token")
    headers = {"X-Provisioner-Token": "secret-token"}

    domain = await _make_domain(status=STATUS_PENDING_SSL)

    for attempt in range(1, 4):
        result = await app_client.post(
            f"/api/v1/internal/provisioning/domains/{domain.id}/result",
            json={"ok": False, "error": "certbot exploded"},
            headers=headers,
        )
        assert result.status_code == 200
        body = result.json()
        assert body["attempts"] == attempt
    assert body["status"] == STATUS_FAILED

    # Exhausted domains drop out of the work list.
    listed = await app_client.get("/api/v1/internal/provisioning/domains", headers=headers)
    assert all(j["id"] != str(domain.id) for j in listed.json())
