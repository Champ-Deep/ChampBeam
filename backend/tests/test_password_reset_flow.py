"""
End-to-end tests for the forgot-password flow.

Covers the security guarantees in the spec:
  - Step 1 always returns the same generic message (no user enumeration)
  - Tokens are persisted only as bcrypt hashes — the raw token never lives
    in the database
  - Tokens expire and become unusable
  - Tokens are single-use: a successful reset deletes the row
  - Requesting a new token invalidates any previously issued token for
    that user
  - Step 2 actually rotates the password (login with the new password
    works; the old password is rejected)
  - Email dispatch goes through the Resend wrapper exactly once on a
    real request
"""

from __future__ import annotations

from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

import pytest
from sqlalchemy import select

from app.core.security import verify_password
from app.models.password_reset import PasswordResetToken
from app.models.user import User


GENERIC_MSG = (
    "If this email is in our system, you will receive a reset link shortly."
)


async def _register(client, email: str, password: str = "originalpw123"):
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": "Test"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _capture_token(client, email: str) -> str:
    """Issue a reset email request and return the raw token that *would*
    have been emailed by digging it out of the email_service mock."""
    with patch(
        "app.api.v1.auth.email_service.send_password_reset_email",
        new=AsyncMock(return_value="msg_test"),
    ) as mock_send:
        resp = await client.post(
            "/api/v1/auth/forgot-password", json={"email": email}
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["message"] == GENERIC_MSG
    # background_tasks fire after the response — give them a chance to run
    # in this async loop.
    import asyncio

    for _ in range(20):
        if mock_send.await_count:
            break
        await asyncio.sleep(0.01)
    assert mock_send.await_count == 1, "email send did not fire"
    kwargs = mock_send.await_args.kwargs
    assert kwargs["to"] == email
    return kwargs["token"]


@pytest.mark.asyncio
async def test_forgot_password_generic_for_unknown_email(app_client):
    """Unknown emails get the same generic response — no enumeration."""
    with patch(
        "app.api.v1.auth.email_service.send_password_reset_email",
        new=AsyncMock(),
    ) as mock_send:
        resp = await app_client.post(
            "/api/v1/auth/forgot-password",
            json={"email": "nobody@example.com"},
        )
    assert resp.status_code == 200
    assert resp.json()["message"] == GENERIC_MSG
    # No email sent for an unknown user
    assert mock_send.await_count == 0


@pytest.mark.asyncio
async def test_forgot_password_emails_known_user(app_client):
    await _register(app_client, "alice@example.com")
    token = await _capture_token(app_client, "alice@example.com")
    assert token and len(token) >= 32  # URL-safe base64 of 48 bytes


@pytest.mark.asyncio
async def test_token_stored_hashed_only(app_client):
    """The DB must contain a bcrypt hash, not the raw token."""
    await _register(app_client, "bob@example.com")
    raw_token = await _capture_token(app_client, "bob@example.com")

    # Inspect the DB directly through the same dependency-overridden session
    from app.db.postgres import get_db_session

    override = app_client._transport.app.dependency_overrides[get_db_session]
    async for session in override():
        rows = (await session.execute(select(PasswordResetToken))).scalars().all()
        assert len(rows) == 1
        row = rows[0]
        assert row.token_hash != raw_token
        assert row.token_hash.startswith("$2")  # bcrypt prefix
        assert verify_password(raw_token, row.token_hash)
        break


@pytest.mark.asyncio
async def test_reset_password_happy_path(app_client):
    await _register(app_client, "carol@example.com", password="originalpw123")
    raw_token = await _capture_token(app_client, "carol@example.com")

    reset = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": raw_token, "new_password": "brandnewpw456"},
    )
    assert reset.status_code == 200, reset.text
    assert reset.json()["success"] is True

    # Old password should now fail
    old_login = await app_client.post(
        "/api/v1/auth/login",
        json={"email": "carol@example.com", "password": "originalpw123"},
    )
    assert old_login.status_code == 401

    # New password should succeed
    new_login = await app_client.post(
        "/api/v1/auth/login",
        json={"email": "carol@example.com", "password": "brandnewpw456"},
    )
    assert new_login.status_code == 200


@pytest.mark.asyncio
async def test_reset_token_is_single_use(app_client):
    await _register(app_client, "dave@example.com")
    raw_token = await _capture_token(app_client, "dave@example.com")

    first = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": raw_token, "new_password": "newpw1234"},
    )
    assert first.status_code == 200

    second = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": raw_token, "new_password": "anotherpw5678"},
    )
    assert second.status_code == 400
    assert "invalid or has expired" in second.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invalid_token_rejected(app_client):
    await _register(app_client, "eve@example.com")
    # Get a real token for the user, then submit garbage
    await _capture_token(app_client, "eve@example.com")

    resp = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": "this-is-not-the-token-xxxxxxxxxxxx", "new_password": "newpw1234"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_new_request_invalidates_previous_token(app_client):
    await _register(app_client, "frank@example.com")

    first_token = await _capture_token(app_client, "frank@example.com")
    second_token = await _capture_token(app_client, "frank@example.com")
    assert first_token != second_token

    # The first token must no longer work — newer request wipes older rows
    stale = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": first_token, "new_password": "newpw1234"},
    )
    assert stale.status_code == 400

    # The latest token still works
    fresh = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": second_token, "new_password": "newpw1234"},
    )
    assert fresh.status_code == 200


@pytest.mark.asyncio
async def test_expired_token_rejected(app_client):
    await _register(app_client, "grace@example.com")
    raw_token = await _capture_token(app_client, "grace@example.com")

    # Forcibly age out the token row by driving the dep-override generator
    # to completion so its trailing ``await session.commit()`` runs.
    from app.db.postgres import get_db_session

    override = app_client._transport.app.dependency_overrides[get_db_session]
    gen = override()
    session = await gen.__anext__()
    row = (await session.execute(select(PasswordResetToken))).scalars().one()
    row.expires_at = datetime.utcnow() - timedelta(minutes=5)
    await session.flush()
    try:
        await gen.__anext__()
    except StopAsyncIteration:
        pass

    resp = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": raw_token, "new_password": "newpw1234"},
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_short_password_rejected(app_client):
    await _register(app_client, "henry@example.com")
    raw_token = await _capture_token(app_client, "henry@example.com")

    resp = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": raw_token, "new_password": "short"},
    )
    assert resp.status_code == 422  # pydantic min_length validation


@pytest.mark.asyncio
async def test_email_service_no_op_without_api_key(app_client, monkeypatch):
    """If RESEND_API_KEY is unset, email send returns None (no crash)."""
    from app.services.email_service import email_service
    from app.core.config import settings

    monkeypatch.setattr(settings, "resend_api_key", "")
    result = await email_service.send_password_reset_email(
        to="x@example.com", token="abc"
    )
    assert result is None


@pytest.mark.asyncio
async def test_email_service_calls_resend_sdk(app_client, monkeypatch):
    """With an API key configured, the email service hands off to the
    Resend SDK with the expected payload shape."""
    from app.services.email_service import email_service
    from app.core.config import settings
    import resend

    monkeypatch.setattr(settings, "resend_api_key", "re_test_key")
    monkeypatch.setattr(settings, "resend_from_email", "ChampUTM <a@b.com>")
    monkeypatch.setattr(settings, "frontend_url", "https://app.example.com")

    captured: dict = {}

    def fake_send(params):
        captured.update(params)
        return {"id": "msg_abc"}

    monkeypatch.setattr(resend.Emails, "send", staticmethod(fake_send))
    # Make sure we hit the sync send via to_thread fallback for a stable
    # assertion regardless of the SDK's async surface.
    monkeypatch.setattr(resend.Emails, "send_async", None, raising=False)

    msg_id = await email_service.send_password_reset_email(
        to="dest@example.com", token="raw-token-abc"
    )
    assert msg_id == "msg_abc"
    assert captured["from"] == "ChampUTM <a@b.com>"
    assert captured["to"] == ["dest@example.com"]
    assert "Reset" in captured["subject"]
    assert "raw-token-abc" in captured["html"]
    assert "https://app.example.com/reset-password?token=raw-token-abc" in captured["html"]
    assert "raw-token-abc" in captured["text"]


@pytest.mark.asyncio
async def test_forgot_password_rate_limited(app_client):
    """The forgot-password endpoint refuses to spray emails."""
    await _register(app_client, "spammer@example.com")

    with patch(
        "app.api.v1.auth.email_service.send_password_reset_email",
        new=AsyncMock(),
    ):
        # 5 allowed, 6th should be rate-limited.
        responses = []
        for _ in range(6):
            r = await app_client.post(
                "/api/v1/auth/forgot-password",
                json={"email": "spammer@example.com"},
            )
            responses.append(r.status_code)

    assert responses[:5] == [200] * 5
    assert responses[5] == 429


@pytest.mark.asyncio
async def test_password_reset_invalidates_existing_jwt(app_client):
    """After a password reset, JWTs issued *before* the reset must stop
    working — defends against stolen-but-not-yet-expired sessions."""
    await _register(app_client, "ian@example.com", password="originalpw123")

    # Sign in to get a JWT that's "in the field" before the reset.
    login = await app_client.post(
        "/api/v1/auth/login",
        json={"email": "ian@example.com", "password": "originalpw123"},
    )
    assert login.status_code == 200
    stale_token = login.json()["access_token"]
    auth = {"Authorization": f"Bearer {stale_token}"}

    me_before = await app_client.get("/api/v1/auth/me", headers=auth)
    assert me_before.status_code == 200

    # Reset the password.
    raw_token = await _capture_token(app_client, "ian@example.com")
    # ensure the iat of the new password_changed_at is strictly greater
    # than the JWT's iat (1-second granularity in iat).
    import asyncio

    await asyncio.sleep(1.1)
    reset = await app_client.post(
        "/api/v1/auth/reset-password",
        json={"token": raw_token, "new_password": "brandnewpw456"},
    )
    assert reset.status_code == 200

    # The pre-reset JWT is no longer accepted.
    me_after = await app_client.get("/api/v1/auth/me", headers=auth)
    assert me_after.status_code == 401

    # But a freshly issued JWT is.
    relogin = await app_client.post(
        "/api/v1/auth/login",
        json={"email": "ian@example.com", "password": "brandnewpw456"},
    )
    assert relogin.status_code == 200
    fresh_token = relogin.json()["access_token"]
    me_fresh = await app_client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {fresh_token}"}
    )
    assert me_fresh.status_code == 200
