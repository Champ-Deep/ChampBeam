"""
ChampUTM - FastAPI Backend

Main application entry point.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
allowed_origins = [settings.frontend_url.rstrip("/")]
if settings.environment == "development":
    allowed_origins.extend([
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
    ])
logger.info("CORS allowed_origins=%s", allowed_origins)

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Requested-With", "Accept"],
)

# Rate limiting
setup_rate_limiting(app)


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
