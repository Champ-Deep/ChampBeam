"""Hand every public request to the Cloudflare Worker while this Railway service winds down.

Set CF_REDIRECT_BASE (e.g. https://champbeam.com) and every request except the health
check is redirected to the same path and query there. Old links, pages and files sent on
share.lakeb2b.com keep working and are tracked on the Worker, which serves the same
platform-bucket codes and slugs. Unset the variable to turn it off; no deploy needed.
"""

import os

from starlette.requests import Request
from starlette.responses import RedirectResponse

async def cf_redirect(request: Request, call_next):
    base = os.environ.get("CF_REDIRECT_BASE", "").strip().rstrip("/")
    path = request.url.path
    if not base or path == "/health" or path.startswith("/health/"):
        return await call_next(request)
    target = base + path + (f"?{request.url.query}" if request.url.query else "")
    # 302 keeps it temporary (share.lakeb2b.com itself moves to the Worker later); 307 keeps POST bodies (email gates).
    status = 302 if request.method in ("GET", "HEAD") else 307
    return RedirectResponse(target, status_code=status, headers={"Cache-Control": "no-store"})
