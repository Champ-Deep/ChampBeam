"""
Champbeam - FastAPI Backend

Main application entry point.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from app.core.config import settings
from app.db.postgres import init_db, close_db
from app.db.redis import redis_client
from app.middleware.rate_limit import setup_rate_limiting
from app.core.service_auth import service_key_gate

# Import routers
from app.api.v1 import auth, health, projects, utm, short_links, domains, qr
from app.api.v1 import files as files_v1
from app.api.v1 import webhooks, org, content, champvault, rooms, api_keys, internal_provisioning, pages
from app.api.redirect import router as redirect_router
from app.api.files import router as files_serve_router
from app.api.page_state import router as page_state_router
from app.services.file_expiry import expiry_sweeper_loop
from app.services.domain_provisioning import domain_provision_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan handler for startup/shutdown."""
    import asyncio
    import time

    startup_start = time.time()

    logger.info("Starting %s v%s [%s]", settings.app_name, settings.app_version, settings.environment)
    logger.info("CORS frontend_url=%s | allowed_origins=%s", settings.frontend_url, allowed_origins)

    # Initialize PostgreSQL
    try:
        await asyncio.wait_for(init_db(), timeout=15.0)
        logger.info("PostgreSQL connected (%.1fs)", time.time() - startup_start)
    except asyncio.TimeoutError:
        logger.error("PostgreSQL init TIMED OUT after 15s")
    except Exception as e:
        logger.error("PostgreSQL initialization failed: %s", e)

    # Storage backend visibility + a durability guardrail. The "local" backend
    # writes file bytes to STORAGE_LOCAL_PATH on the host filesystem, which must
    # be durable. On ephemeral container platforms (e.g. Railway) that path is
    # wiped on every redeploy unless it is a mounted Volume; on a VPS a normal
    # disk path is fine. Surface the active backend and flag local storage on a
    # production boot so the risk is never silent.
    storage_backend = settings.storage_backend_normalized
    logger.info("Storage backend: %s (configured=%s)", storage_backend, settings.storage_configured)
    if storage_backend == "local" and (
        settings.environment.lower() == "production" or not settings.debug
    ):
        logger.warning(
            "STORAGE_BACKEND=local in production: file uploads go to %s on the host filesystem. "
            "Ensure that path is durable storage (a mounted Volume on container platforms like "
            "Railway, a real disk on a VPS); on ephemeral containers it is wiped on every redeploy. "
            "For storage decoupled from the host, use STORAGE_BACKEND=s3 (Cloudflare R2) or mongo.",
            settings.storage_local_path,
        )

    # Background sweeper that reclaims expired anonymous file uploads.
    sweeper_task = asyncio.create_task(expiry_sweeper_loop())
    # Background loop that auto-advances pending BYOD domains (DNS check ->
    # pending_ssl -> active). Exits immediately when local BYOD is unconfigured.
    provision_task = asyncio.create_task(domain_provision_loop())

    logger.info("Ready in %.1fs", time.time() - startup_start)

    yield

    # Shutdown
    for task in (sweeper_task, provision_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await redis_client.close()
    await close_db()
    logger.info("Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="Champbeam API - UTM link generator and analytics platform.",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS middleware
# Exact production + local origins (plus any from CORS_ALLOW_ORIGINS), and a
# regex that admits this project/team's Vercel deployments: the Champbeam app
# and its Vercel project (champbeam*.vercel.app, plus the legacy champ-utm*
# project during the rename) and the team-suffixed preview hosts
# (<deploy>-deep-5245s-projects.vercel.app). Both the list and the regex are
# env-overridable so a new app origin never needs a code change.
allowed_origins = [
    "https://app.champbeam.com",
    "https://champbeam.com",
    "https://champ-utm.vercel.app",
    settings.frontend_url.rstrip("/"),
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
]
allowed_origins += [
    o.strip().rstrip("/") for o in settings.cors_allow_origins.split(",") if o.strip()
]
allowed_origins = list(dict.fromkeys(o for o in allowed_origins if o))  # dedup, drop empties
allowed_origin_regex = (
    settings.cors_allow_origin_regex
    or r"^https://(champbeam(-[a-z0-9-]+)?|champ-utm(-[a-z0-9-]+)?|[a-z0-9-]+-deep-5245s-projects)\.vercel\.app$"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=allowed_origin_regex,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "Accept"],
)

# Rate limiting
setup_rate_limiting(app)

# Service-key lane (X-Service-Key): validates the key, enforces the write-only
# route allowlist (403 off-list), and applies the per-key rate limit — all
# before routing, so scope lives in exactly one place (app/core/service_auth.py).
app.middleware("http")(service_key_gate)


# Belt-and-suspenders: if anything escapes the route handlers, make sure the
# 500 response still carries the CORS header the browser needs. Without this,
# Starlette's default 500 path can produce a response that the browser reports
# as a CORS error instead of a 500, which makes diagnosis painful.
_allowed_origin_regex = re.compile(allowed_origin_regex)


def _cors_origin_for(request: Request) -> str | None:
    origin = request.headers.get("origin")
    if not origin:
        return None
    if origin in allowed_origins or _allowed_origin_regex.match(origin):
        return origin
    return None


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    headers: dict[str, str] = {}
    origin = _cors_origin_for(request)
    if origin:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
        headers["Vary"] = "Origin"
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error"},
        headers=headers,
    )


@app.get("/", tags=["Root"])
async def root():
    """API root."""
    return {
        "name": settings.app_name,
        "version": settings.app_version,
        "docs": "/docs",
        "health": "/health",
    }


# Include routers
app.include_router(health.router)
app.include_router(redirect_router)  # /r/{short_code}, top-level, no prefix
app.include_router(files_serve_router)  # /f/{short_code}, top-level, no prefix
app.include_router(page_state_router)  # /api/pages/{ident}/…, public token auth, same-origin with pages
app.include_router(auth.router, prefix=settings.api_v1_prefix)
app.include_router(utm.router, prefix=settings.api_v1_prefix)
app.include_router(projects.router, prefix=settings.api_v1_prefix)
app.include_router(domains.router, prefix=settings.api_v1_prefix)
app.include_router(files_v1.router, prefix=settings.api_v1_prefix)
app.include_router(qr.router, prefix=settings.api_v1_prefix)
app.include_router(webhooks.router, prefix=settings.api_v1_prefix)
app.include_router(org.router, prefix=settings.api_v1_prefix)
app.include_router(content.router, prefix=settings.api_v1_prefix)
app.include_router(champvault.router, prefix=settings.api_v1_prefix)
app.include_router(rooms.router, prefix=settings.api_v1_prefix)
app.include_router(api_keys.router, prefix=settings.api_v1_prefix)
app.include_router(internal_provisioning.router, prefix=settings.api_v1_prefix)
app.include_router(pages.router, prefix=settings.api_v1_prefix)
app.include_router(short_links.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=settings.debug)
