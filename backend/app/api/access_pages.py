"""Branded HTML pages served on the redirect/file hot path when a self-destruct
control blocks or gates a view (expired, revoked, view-cap hit, VPN blocked, or
the email gate). Kept dependency-free and inline-styled so they render even when
the SPA/frontend is unreachable.
"""

from __future__ import annotations

import html

from fastapi.responses import HTMLResponse

_BLOCK_COPY = {
    "expired": ("Link expired", "This link is no longer available — it passed its expiry date."),
    "revoked": ("Link revoked", "The sender has turned off access to this link."),
    "maxed": ("View limit reached", "This link self-destructed after reaching its view limit."),
    "vpn": ("Access blocked", "Opens from VPNs or anonymizing proxies aren’t allowed for this link."),
    "gone": ("Link unavailable", "This link is no longer available."),
}


def _shell(title: str, body: str, *, status: int, brand: str | None) -> HTMLResponse:
    brand_html = (
        f'<div class="brand">{html.escape(brand)}</div>' if brand else '<div class="brand">Champbeam</div>'
    )
    page = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0f172a; color:#e2e8f0; }}
  .card {{ max-width:420px; padding:40px 32px; text-align:center; background:#111c33;
    border:1px solid #1e293b; border-radius:16px; }}
  .brand {{ font-weight:700; color:#34d399; margin-bottom:20px; letter-spacing:-.01em; }}
  h1 {{ font-size:20px; margin:0 0 8px; }}
  p {{ color:#94a3b8; font-size:14px; line-height:1.5; margin:0 0 20px; }}
  form {{ display:flex; gap:8px; }}
  input {{ flex:1; padding:10px 12px; border-radius:10px; border:1px solid #334155;
    background:#0b1425; color:#e2e8f0; font-size:14px; }}
  button {{ padding:10px 16px; border:0; border-radius:10px; background:#34d399; color:#04120b;
    font-weight:600; font-size:14px; cursor:pointer; }}
</style></head><body><div class="card">{brand_html}{body}</div></body></html>"""
    return HTMLResponse(content=page, status_code=status)


def blocked_page(reason: str, *, brand: str | None = None) -> HTMLResponse:
    title, msg = _BLOCK_COPY.get(reason, _BLOCK_COPY["gone"])
    body = f"<h1>{html.escape(title)}</h1><p>{html.escape(msg)}</p>"
    return _shell(title, body, status=410, brand=brand)


def email_gate_page(*, action: str, brand: str | None = None, error: bool = False) -> HTMLResponse:
    """The 'enter your email to view' gate. ``action`` is the POST unlock URL."""
    err = '<p style="color:#f87171">Please enter a valid email.</p>' if error else ""
    body = (
        "<h1>Enter your email to view</h1>"
        "<p>The sender asked for your email before granting access.</p>"
        f"{err}"
        f'<form method="post" action="{html.escape(action)}">'
        '<input type="email" name="email" placeholder="you@company.com" required autofocus>'
        '<button type="submit">View</button></form>'
    )
    return _shell("Enter your email to view", body, status=200, brand=brand)


def code_gate_page(
    *, action: str, brand: str | None = None, error: str | None = None
) -> HTMLResponse:
    """The 'enter the access code' gate for Beam Pages.

    ``error`` is None, "wrong" (re-render with a message) or "too_many"
    (429, no form — attempts are exhausted for a while).
    """
    if error == "too_many":
        body = (
            "<h1>Too many attempts</h1>"
            "<p>Please wait a few minutes before trying the access code again.</p>"
        )
        return _shell("Too many attempts", body, status=429, brand=brand)
    err = '<p style="color:#f87171">That code isn’t right.</p>' if error == "wrong" else ""
    body = (
        "<h1>Enter the access code</h1>"
        "<p>The sender protected this page with a code.</p>"
        f"{err}"
        f'<form method="post" action="{html.escape(action)}">'
        '<input type="text" name="code" inputmode="numeric" pattern="[0-9]{4,8}" '
        'autocomplete="one-time-code" placeholder="Access code" required autofocus>'
        '<button type="submit">View</button></form>'
    )
    return _shell("Enter the access code", body, status=200, brand=brand)
