"""Tests for the authenticated change-password endpoint."""

from __future__ import annotations

import asyncio

import pytest


async def _register(client, email="user@example.com", password="originalpw123"):
    r = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": "Test"},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"]


@pytest.mark.asyncio
async def test_change_password_requires_auth(app_client):
    r = await app_client.post(
        "/api/v1/auth/change-password",
        json={"current_password": "x", "new_password": "newpw1234"},
    )
    assert r.status_code == 401


@pytest.mark.asyncio
async def test_change_password_wrong_current(app_client):
    token = await _register(app_client)
    r = await app_client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "wrong", "new_password": "newpw1234"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_change_password_happy_path(app_client):
    token = await _register(app_client, password="originalpw123")
    await asyncio.sleep(1.1)

    r = await app_client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "originalpw123", "new_password": "freshpw4567"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    new_token = body["access_token"]
    assert new_token and new_token != token

    # Old token is invalidated by password_changed_at >= iat rule
    old_me = await app_client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert old_me.status_code == 401

    # Fresh token issued by the endpoint still works
    fresh_me = await app_client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {new_token}"}
    )
    assert fresh_me.status_code == 200

    # Old password no longer works; new one does
    old_login = await app_client.post(
        "/api/v1/auth/login",
        json={"email": "user@example.com", "password": "originalpw123"},
    )
    assert old_login.status_code == 401
    new_login = await app_client.post(
        "/api/v1/auth/login",
        json={"email": "user@example.com", "password": "freshpw4567"},
    )
    assert new_login.status_code == 200


@pytest.mark.asyncio
async def test_change_password_short_new_rejected(app_client):
    token = await _register(app_client)
    r = await app_client.post(
        "/api/v1/auth/change-password",
        headers={"Authorization": f"Bearer {token}"},
        json={"current_password": "originalpw123", "new_password": "short"},
    )
    assert r.status_code == 422
