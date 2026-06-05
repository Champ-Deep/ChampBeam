"""End-to-end test for the platform-subdomain (Netlify-style) custom-domain path.

Drives the REAL /domains + /domains/config endpoints with PLATFORM_SUBDOMAIN_BASE
set and Cloudflare for SaaS intentionally NOT configured, proving:
  - /domains/config reports subdomain mode on (and BYOD off) so the UI can show
    the "Claim a subdomain" card
  - claiming a single-label subdomain -> 201 ACTIVE instantly (no CF, no cert wait)
  - the honesty guarantee: a multi-label slug and an external domain stay PENDING,
    never false-active (so the UI never shows a domain as Live when it would not
    actually connect)
  - a link generated on the claimed subdomain routes on that Host and is isolated
    from the platform-default host

Prereqs:
    pg_isready ; alembic upgrade head

Run:
    PYTHONPATH=. python scripts/e2e_subdomain_test.py
"""

from __future__ import annotations

import os
import sys
import asyncio
from uuid import uuid4, UUID

BASE = "share.lakeb2b.test"
SUB = f"acme.{BASE}"            # single-label subdomain -> instant active
DEEP = f"go.team.{BASE}"        # multi-label -> NOT a platform subdomain
EXT = "track.acmecorp.com"      # external, CF not configured -> stays pending
PLAT = "platform.test"

os.environ["PLATFORM_REDIRECT_HOST"] = PLAT
os.environ["REDIRECT_BASE_URL"] = f"http://{PLAT}"
os.environ["PLATFORM_SUBDOMAIN_BASE"] = BASE
os.environ["CLOUDFLARE_API_TOKEN"] = ""   # BYOD/CF intentionally NOT configured
os.environ["CLOUDFLARE_ZONE_ID"] = ""
os.environ["DEBUG"] = "false"
sys.path.insert(0, ".")

import httpx  # noqa: E402
from sqlalchemy import delete, select  # noqa: E402
from app.main import app  # noqa: E402
from app.core.security import TokenData, get_current_user, require_auth  # noqa: E402
from app.db.postgres import async_session_maker  # noqa: E402
from app.models.domain import Domain  # noqa: E402
from app.models.utm import LinkClick  # noqa: E402
from app.models import User  # noqa: E402

res: list[bool] = []


def chk(label: str, cond: bool, detail: str = "") -> None:
    res.append(cond)
    print(("  PASS " if cond else "  FAIL ") + label + ("" if cond else "  :: " + detail))


async def main() -> int:
    async with async_session_maker() as s:
        u = (await s.execute(select(User).where(User.email == "subd@test.local"))).scalar_one_or_none()
        if not u:
            u = User(id=uuid4(), email="subd@test.local", clerk_id=f"clerk_subd_{uuid4().hex[:8]}")
            s.add(u)
            await s.commit()
            await s.refresh(u)
        uid = str(u.id)
        await s.execute(delete(LinkClick).where(LinkClick.user_id == u.id))
        for h in (SUB, DEEP, EXT):
            await s.execute(delete(Domain).where(Domain.hostname == h))
        await s.commit()

    def tok():
        return TokenData(user_id=uid, email="subd@test.local")

    app.dependency_overrides[get_current_user] = tok
    app.dependency_overrides[require_auth] = tok

    t = httpx.ASGITransport(app=app)
    sub_domain_id = None
    async with httpx.AsyncClient(transport=t, base_url=f"http://{PLAT}", follow_redirects=False) as c:
        r = await c.get("/api/v1/domains/config")
        cfg = r.json() if r.status_code == 200 else {}
        chk("config: subdomain_enabled true", cfg.get("subdomain_enabled") is True, str(cfg))
        chk("config: base echoed", cfg.get("platform_subdomain_base") == BASE, str(cfg))
        chk("config: byod_enabled false (CF not configured)", cfg.get("byod_enabled") is False, str(cfg))

        r = await c.post("/api/v1/domains", json={"hostname": SUB})
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        chk("claim subdomain -> 201", r.status_code == 201, f"{r.status_code}:{r.text[:160]}")
        chk("claimed subdomain is ACTIVE instantly", body.get("status") == "active", str(body))
        chk("claimed subdomain ssl active", body.get("ssl_status") == "active", str(body))
        chk("claimed subdomain not CF-managed", body.get("cloudflare_managed") is False, str(body))
        sub_domain_id = body.get("id")

        r = await c.post("/api/v1/domains", json={"hostname": DEEP})
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        chk("multi-label under base -> not instant active", body.get("status") != "active", str(body))

        r = await c.post("/api/v1/domains", json={"hostname": EXT})
        body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
        chk("external domain -> 201", r.status_code == 201, f"{r.status_code}:{r.text[:160]}")
        chk("external domain NOT active (pending)", body.get("status") == "pending_cname", str(body))

        scc = None
        if sub_domain_id:
            r = await c.post("/api/v1/utm/generate", json={
                "base_url": "https://example.com/dest", "utm_source": "subd", "domain_id": sub_domain_id,
            })
            chk("generate link on claimed subdomain", r.status_code == 200, f"{r.status_code}:{r.text[:160]}")
            scc = r.json().get("short_code") if r.status_code == 200 else None

    app.dependency_overrides.clear()

    async with httpx.AsyncClient(transport=t, base_url="http://x", follow_redirects=False) as c:
        if scc:
            r = await c.get(f"/r/{scc}", headers={"Host": SUB})
            loc = r.headers.get("location", "")
            chk("link on ITS subdomain -> 302 to dest", r.status_code == 302 and "example.com/dest" in loc, f"{r.status_code} {loc}")
            r = await c.get(f"/r/{scc}", headers={"Host": PLAT})
            loc = r.headers.get("location", "")
            chk("link on PLATFORM host -> not found (isolated)", r.status_code == 302 and loc == "/", f"{r.status_code} {loc}")

    async with async_session_maker() as s:
        await s.execute(delete(LinkClick).where(LinkClick.user_id == UUID(uid)))
        for h in (SUB, DEEP, EXT):
            await s.execute(delete(Domain).where(Domain.hostname == h))
        await s.commit()

    print("\nRESULT:", "ALL PASS" if (res and all(res)) else "FAILURES")
    return 0 if (res and all(res)) else 1


sys.exit(asyncio.run(main()))
