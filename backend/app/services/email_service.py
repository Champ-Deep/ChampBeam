"""
Email delivery via Resend.

Resend is used purely as the transport layer — all token generation, hashing,
and lifecycle management lives in the backend (see ``user_service`` /
``PasswordResetToken``). This module only knows how to render and dispatch
messages.

The send method is async-friendly: the Resend SDK is synchronous, so we run
it in a thread pool to avoid blocking the event loop. If no API key is
configured, the call is treated as a no-op (logged at WARNING) so local
development without Resend credentials never crashes the request.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Optional
from urllib.parse import quote

from app.core.config import settings

logger = logging.getLogger(__name__)


def _build_reset_link(token: str) -> str:
    """Compose the absolute reset URL for the email body."""
    base = settings.frontend_url.rstrip("/")
    path = settings.password_reset_path
    if not path.startswith("/"):
        path = "/" + path
    return f"{base}{path}?token={quote(token, safe='')}"


def _render_password_reset_html(reset_link: str, ttl_minutes: int) -> str:
    return (
        "<!DOCTYPE html><html><body style=\"font-family:Helvetica,Arial,sans-serif;"
        "color:#0f172a;line-height:1.5;padding:24px;\">"
        "<h2 style=\"margin:0 0 16px;color:#7c3aed;\">Reset your ChampUTM password</h2>"
        "<p>We received a request to reset the password on your ChampUTM account. "
        "Click the button below to choose a new one. This link expires in "
        f"<strong>{ttl_minutes} minutes</strong>.</p>"
        f"<p style=\"margin:24px 0;\"><a href=\"{reset_link}\" "
        "style=\"background:#7c3aed;color:#fff;padding:12px 20px;border-radius:6px;"
        "text-decoration:none;font-weight:600;display:inline-block;\">Reset password</a></p>"
        "<p style=\"color:#475569;font-size:14px;\">If the button doesn't work, "
        f"paste this URL into your browser:<br><span style=\"word-break:break-all;\">{reset_link}</span></p>"
        "<p style=\"color:#94a3b8;font-size:12px;margin-top:32px;\">"
        "Didn't request this? You can safely ignore this email — your password "
        "will not be changed.</p></body></html>"
    )


def _render_password_reset_text(reset_link: str, ttl_minutes: int) -> str:
    return (
        "Reset your ChampUTM password\n\n"
        "We received a request to reset the password on your ChampUTM account. "
        f"Open the link below to choose a new one. This link expires in {ttl_minutes} minutes.\n\n"
        f"{reset_link}\n\n"
        "Didn't request this? You can safely ignore this email — your password "
        "will not be changed.\n"
    )


class EmailService:
    """Thin wrapper around the Resend SDK."""

    def _client(self):
        """Lazy import + configure the Resend SDK.

        Returns the ``resend`` module with ``api_key`` set, or None if no
        API key is configured or the SDK is not installed.
        """
        api_key = settings.resend_api_key
        if not api_key:
            return None
        try:
            import resend  # type: ignore
        except ImportError:
            logger.warning("Resend SDK not installed; email send skipped.")
            return None
        resend.api_key = api_key
        return resend

    async def send(
        self,
        *,
        to: str,
        subject: str,
        html: str,
        text: Optional[str] = None,
    ) -> Optional[str]:
        """Send an email via Resend. Returns the message id, or None on no-op."""
        client = self._client()
        if client is None:
            logger.warning(
                "Resend not configured; would have sent email to=%s subject=%r",
                to,
                subject,
            )
            return None

        params: dict = {
            "from": settings.resend_from_email,
            "to": [to],
            "subject": subject,
            "html": html,
        }
        if text:
            params["text"] = text

        def _send_sync() -> dict:
            return client.Emails.send(params)

        try:
            result = await asyncio.to_thread(_send_sync)
        except Exception as exc:
            logger.error("Resend send failed to=%s subject=%r err=%s", to, subject, exc)
            return None

        message_id = result.get("id") if isinstance(result, dict) else None
        logger.info("Resend send queued to=%s id=%s", to, message_id)
        return message_id

    async def send_password_reset_email(self, *, to: str, token: str) -> Optional[str]:
        """Compose + dispatch the password reset email."""
        ttl = settings.password_reset_token_ttl_minutes
        reset_link = _build_reset_link(token)
        return await self.send(
            to=to,
            subject="Reset your ChampUTM password",
            html=_render_password_reset_html(reset_link, ttl),
            text=_render_password_reset_text(reset_link, ttl),
        )


email_service = EmailService()
