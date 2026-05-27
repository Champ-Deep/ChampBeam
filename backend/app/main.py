"""
ChampUTM - FastAPI Backend

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

# Import routers
from app.api.v1 import auth, health, projects, utm, short_links
from app.api.redirect import router as redirect_router


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

    logger.info("Ready in %.1fs", time.time() - startup_start)

    yield

    # Shutdown
    await redis_client.close()
    await close_db()
    logger.info("Shutdown complete")


# Create FastAPI app
app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    description="ChampUTM API - UTM link generator and analytics platform.",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

# CORS middleware
# Exact production + local origins, plus a regex that admits any Vercel
# preview deployment of this project (champ-utm.vercel.app for prod;
# champ-utm-git-<branch>-... and champ-utm-<commit>-... for previews).
allowed_origins = [
    "https://champ-utm.vercel.app",
    settings.frontend_url.rstrip("/"),
    "http://localhost:3000",
    "http://localhost:5173",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
]
allowed_origin_regex = r"^https://champ-utm(-[a-z0-9-]+)?\.vercel\.app$"

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
app.include_router(redirect_router)  # /r/{short_code} — top-level, no prefix
app.include_router(auth.router, prefix=settings.api_v1_prefix)
app.include_router(utm.router, prefix=settings.api_v1_prefix)
app.include_router(projects.router, prefix=settings.api_v1_prefix)
app.include_router(short_links.router)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=settings.debug)
