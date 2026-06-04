"""
Application configuration using Pydantic Settings.
Loads from environment variables and .env file.
"""

from __future__ import annotations

from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # Application
    app_name: str = "ChampUTM"
    app_version: str = "1.0.0"
    debug: bool = True
    environment: str = "development"

    # API
    api_v1_prefix: str = "/api/v1"

    # PostgreSQL
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "champutm"
    postgres_password: str = "champutm_dev"
    postgres_db: str = "champutm"
    database_url: str = ""

    # Redis Cache
    redis_url: str = "redis://localhost:6379/0"

    # Clerk
    clerk_secret_key: str = ""

    # Frontend URL for CORS
    frontend_url: str = "http://localhost:5173"

    # Extra CORS origins (comma-separated, exact match) + an optional regex
    # override, so new app origins (custom domains, Vercel preview URLs) can be
    # allowed via env without a code change.
    cors_allow_origins: str = ""
    cors_allow_origin_regex: str = ""

    # Optional override for short-link base URL (e.g. behind a reverse proxy
    # that rewrites Host). When unset, _build_redirect_url falls back to
    # request.base_url so the URL always matches the host the client used.
    redirect_base_url: str = ""

    # The hostname (no scheme, no path) used when a click arrives on the
    # platform's default redirect host. The redirect handler matches the
    # incoming Host header against this string to decide whether to look up
    # links in the "no custom domain" bucket. Derived from redirect_base_url
    # when unset.
    platform_redirect_host: str = ""

    # Base zone for Netlify-style platform subdomains, e.g. "deependhq.com" so a
    # tenant can claim acme.deependhq.com. Single-label subdomains under this
    # base are served by the platform wildcard DNS + cert, so they need no
    # per-host certificate. Empty disables subdomain mode.
    platform_subdomain_base: str = ""

    # Cloudflare for SaaS Custom Hostnames integration. When both token and
    # zone_id are set, the /api/v1/domains endpoints provision certs via CF.
    # When either is empty, those endpoints return 503 with a setup hint.
    cloudflare_api_token: str = ""
    cloudflare_zone_id: str = ""
    # The CNAME target customers point their domain at. e.g. cname.champutm.com
    cloudflare_cname_target: str = ""

    # Supabase Storage, used as a standalone S3-compatible blob store for the
    # file-hosting feature. Supabase itself is not the database; only Storage
    # is in play. Configure all five in production. When any are unset, the
    # /api/v1/files endpoints return 503 with a setup hint (same pattern as
    # Cloudflare for SaaS).
    #
    #   SUPABASE_STORAGE_ENDPOINT=https://<project>.supabase.co/storage/v1/s3
    #   SUPABASE_STORAGE_REGION=<your_project_region>      e.g. "us-east-1"
    #   SUPABASE_STORAGE_BUCKET=files
    supabase_storage_endpoint: str = ""
    supabase_storage_region: str = "us-east-1"
    supabase_storage_access_key_id: str = ""
    supabase_storage_secret_access_key: str = ""
    supabase_storage_bucket: str = "files"

    # Hard cap on per-user storage. Hardcoded for v1 (no User-tier model yet).
    # Upload intent returns 402 when the user would exceed this.
    max_bytes_per_user: int = 5 * 1024 * 1024 * 1024  # 5 GiB

    # Storage backend selector: "local" (Railway volume) | "s3" (Supabase/R2/...).
    # Local routes upload/serve bytes through the API and needs no external creds;
    # "s3" keeps the presigned-URL flow using the SUPABASE_STORAGE_* vars above.
    # Flip this to scale up later without code changes.
    storage_backend: str = "local"
    # Filesystem root for the local backend. On Railway, point this at a MOUNTED
    # VOLUME (e.g. /data/files) or uploads are wiped on every redeploy.
    storage_local_path: str = "./data/files"
    # HMAC secret for short-lived blob-upload tokens (local backend). Falls back
    # to clerk_secret_key when unset (see resolved_upload_secret).
    storage_upload_secret: str = ""

    # Anonymous (signed-out) uploads auto-expire after this window; a background
    # sweeper reclaims expired blobs + rows on this interval.
    anon_file_ttl_seconds: int = 24 * 3600
    anon_sweep_interval_seconds: int = 900

    # MongoDB GridFS storage backend (STORAGE_BACKEND=mongo). Stores file bytes
    # in GridFS, handy on Railway (one-click Mongo plugin, no volume needed,
    # survives redeploys). The app's primary DB stays PostgreSQL; Mongo holds
    # blobs only. On Railway the Mongo plugin injects MONGO_URL.
    mongo_url: str = ""
    mongo_db: str = "champutm_files"
    mongo_bucket: str = "fs"

    # GeoIP Configuration
    # "maxmind" uses local GeoLite2-City.mmdb file (recommended for production)
    # "ipapi" uses ip-api.com free API (fallback, rate-limited at 45 req/min)
    geoip_provider: str = "maxmind"
    maxmind_db_path: str = "data/GeoLite2-City.mmdb"
    maxmind_asn_db_path: str = "data/GeoLite2-ASN.mmdb"
    maxmind_license_key: str = ""  # Required to download/update GeoLite2 DB

    @property
    def resolved_platform_redirect_host(self) -> str:
        """Hostname (lowercased, no port) of the platform-default redirect host.

        Falls back to parsing redirect_base_url when platform_redirect_host
        isn't explicitly set.
        """
        if self.platform_redirect_host:
            return self.platform_redirect_host.lower().strip()
        from urllib.parse import urlparse
        parsed = urlparse(self.redirect_base_url)
        return (parsed.hostname or "").lower()

    @property
    def cloudflare_configured(self) -> bool:
        return bool(self.cloudflare_api_token and self.cloudflare_zone_id)

    @property
    def storage_backend_normalized(self) -> str:
        return (self.storage_backend or "local").strip().lower()

    @property
    def storage_configured(self) -> bool:
        # The local backend is always "ready", the directory is created on
        # demand. Mongo needs a URL; S3 needs all four credentials.
        backend = self.storage_backend_normalized
        if backend == "local":
            return True
        if backend == "mongo":
            return bool(self.mongo_url)
        return bool(
            self.supabase_storage_endpoint
            and self.supabase_storage_access_key_id
            and self.supabase_storage_secret_access_key
            and self.supabase_storage_bucket
        )

    @property
    def resolved_upload_secret(self) -> str:
        return self.storage_upload_secret or self.clerk_secret_key

    @property
    def postgres_url(self) -> str:
        """Build PostgreSQL async connection URL."""
        if self.database_url:
            url = self.database_url
            if url.startswith("postgresql://"):
                url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
            return url
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )


@lru_cache
def get_settings() -> Settings:
    """Get cached settings instance."""
    return Settings()


settings = get_settings()
