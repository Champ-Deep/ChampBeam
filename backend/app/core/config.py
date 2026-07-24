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
    app_name: str = "Champbeam"
    app_version: str = "1.0.0"
    debug: bool = True
    environment: str = "development"

    # API
    api_v1_prefix: str = "/api/v1"

    # PostgreSQL
    postgres_host: str = "localhost"
    postgres_port: int = 5432
    postgres_user: str = "champbeam"
    postgres_password: str = "champbeam_dev"
    postgres_db: str = "champbeam"
    database_url: str = ""

    # Redis Cache
    redis_url: str = "redis://localhost:6379/0"

    # Clerk
    clerk_secret_key: str = ""
    # Clerk publishable key (pk_test_... / pk_live_...). The Frontend API host is
    # base64url-encoded in the key body, so setting this is enough to DERIVE the
    # token issuer and turn on `iss` verification in production.
    clerk_publishable_key: str = ""
    # Explicit issuer override, e.g. https://clerk.champbeam.com. Takes precedence
    # over the value derived from the publishable key. Empty => issuer check off
    # (and we cannot derive one) so verification falls back to signature + expiry.
    clerk_issuer: str = ""
    # Comma-separated authorized parties (the `azp` claim, i.e. the exact origins
    # the SPA is served from). Falls back to frontend_url + cors_allow_origins
    # when unset. Empty list disables azp enforcement.
    clerk_authorized_parties: str = ""
    # Svix signing secret (whsec_...) for POST /api/v1/webhooks/clerk. When unset
    # the webhook endpoint returns 503 (events are then synced lazily on auth).
    clerk_webhook_secret: str = ""
    # Clerk Backend API base; override only for tests.
    clerk_api_url: str = "https://api.clerk.com"

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
    # The CNAME target customers point their domain at. e.g. cname.champbeam.com
    cloudflare_cname_target: str = ""

    # Cloudflare account id, required for the (account-scoped) Registrar API that
    # powers in-app domain procurement: search names, check price/availability,
    # and register. When the account id + a token with Registrar write scope are
    # set, the /api/v1/domains/search|check|purchase endpoints go live; otherwise
    # they return 503 with a setup hint. The Registrar API is in beta and only
    # supports a subset of TLDs.
    cloudflare_account_id: str = ""
    # Default registrant contact applied to a registration when the buyer does
    # not supply one (Cloudflare also requires a default contact on the account).
    cloudflare_registrant_email: str = ""

    # ChampVault content hub (external, read-only). ChampBeam lists the library
    # and mints delivery URLs to wrap in tracked beams; it never stores bytes.
    # When unset, the /api/v1/champvault endpoints return 503 with a setup hint.
    champvault_url: str = ""
    champvault_api_key: str = ""

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
    mongo_db: str = "champbeam_files"
    mongo_bucket: str = "fs"

    # GeoIP Configuration
    # "maxmind" uses local GeoLite2-City.mmdb file (recommended for production)
    # "ipapi" uses ip-api.com free API (fallback, rate-limited at 45 req/min)
    geoip_provider: str = "maxmind"
    maxmind_db_path: str = "data/GeoLite2-City.mmdb"
    maxmind_asn_db_path: str = "data/GeoLite2-ASN.mmdb"
    maxmind_license_key: str = ""  # Required to download/update GeoLite2 DB

    # MaxMind GeoIP2 web service (GeoIP Insights / City / Country). Unlike the
    # local .mmdb files this is an HTTPS REST call — datacenter-safe, so it fixes
    # "Unknown" geo on Railway/any PaaS without shipping a database. Insights adds
    # anonymizer traits (VPN/proxy/hosting/Tor) for VPN detection. Auth = account
    # id + license key. Host: geoip.maxmind.com for paid GeoIP2 (Insights lives
    # here); geolite.info for the free GeoLite2 web service. Endpoint: one of
    # "insights" | "city" | "country" (Insights has the richest traits).
    maxmind_account_id: str = ""
    maxmind_ws_host: str = "geoip.maxmind.com"
    maxmind_ws_endpoint: str = "insights"

    # Company intent (reverse-IP firmographics). Provider-agnostic:
    #   "none"   - disabled.
    #   "asn"    - $0: reuse the ASN/network owner we already resolve via MaxMind
    #              (rough "network" signal, no firmographics). No external call.
    #   "ipinfo" - IPinfo's IP-to-Company add-on (real company name/domain/type);
    #              needs IPINFO_API_TOKEN on a plan that includes the company data.
    # Swap providers without touching app code — see app/services/company_intel.py.
    company_intel_provider: str = "asn"
    ipinfo_api_token: str = ""

    @property
    def resolved_platform_redirect_host(self) -> str:
        """Primary platform-default host (lowercased, no port).

        Used when building new short/file URLs and reserving the name. When
        ``platform_redirect_host`` holds a comma-separated list (during a host
        migration), the first entry is the primary. Falls back to parsing
        ``redirect_base_url`` when unset.
        """
        if self.platform_redirect_host:
            return self.platform_redirect_host.split(",")[0].lower().strip()
        from urllib.parse import urlparse
        parsed = urlparse(self.redirect_base_url)
        return (parsed.hostname or "").lower()

    @property
    def platform_redirect_hosts(self) -> set[str]:
        """All hostnames treated as the platform default (no custom domain).

        ``PLATFORM_REDIRECT_HOST`` may be a comma-separated list so that, when
        you change the backend's public URL, the OLD host can keep serving
        previously-issued ``/r/`` and ``/f/`` links (whose URLs embed that host)
        while the new host takes over — no shared link breaks. The host derived
        from ``redirect_base_url`` is always included.
        """
        hosts: set[str] = set()
        for h in (self.platform_redirect_host or "").split(","):
            h = h.lower().strip()
            if h:
                hosts.add(h)
        if self.redirect_base_url:
            from urllib.parse import urlparse
            derived = (urlparse(self.redirect_base_url).hostname or "").lower()
            if derived:
                hosts.add(derived)
        return hosts

    def is_platform_host(self, host: str | None) -> bool:
        """True when an incoming Host should resolve in the platform-default
        (``domain_id IS NULL``) namespace rather than a custom BYOD domain.

        An empty Host is treated as platform-default (preserves prior behavior
        and keeps internal/test calls working)."""
        h = (host or "").lower().strip()
        if not h:
            return True
        return h in self.platform_redirect_hosts

    @property
    def cloudflare_configured(self) -> bool:
        return bool(self.cloudflare_api_token and self.cloudflare_zone_id)

    @property
    def cloudflare_registrar_configured(self) -> bool:
        """True when the account-scoped Registrar API can be called."""
        return bool(self.cloudflare_api_token and self.cloudflare_account_id)

    @property
    def champvault_configured(self) -> bool:
        return bool(self.champvault_url and self.champvault_api_key)

    @property
    def maxmind_ws_configured(self) -> bool:
        """True when the MaxMind GeoIP2 web service can be called (account + key)."""
        return bool(self.maxmind_account_id and self.maxmind_license_key)

    @property
    def company_intel_configured(self) -> bool:
        """True when company-intent has a usable signal source.

        'asn' always qualifies (reuses free MaxMind ASN data); 'ipinfo' needs a
        token; 'none' disables the feature.
        """
        p = (self.company_intel_provider or "none").lower()
        if p == "asn":
            return True
        if p == "ipinfo":
            return bool(self.ipinfo_api_token)
        return False

    @property
    def clerk_environment(self) -> str:
        """'production' for sk_live_ keys, else 'development'."""
        return "production" if self.clerk_secret_key.startswith("sk_live_") else "development"

    @property
    def resolved_clerk_issuer(self) -> str:
        """Expected `iss` of a Clerk session token.

        Prefers an explicit CLERK_ISSUER; otherwise derives it from the
        publishable key, whose body is the base64url-encoded Frontend API host
        with a trailing '$' (e.g. pk_live_<b64('clerk.champbeam.com$')>).
        Returns "" when neither is available, in which case issuer verification
        is skipped (signature + expiry are still enforced).
        """
        if self.clerk_issuer:
            return self.clerk_issuer.rstrip("/")
        pk = self.clerk_publishable_key.strip()
        if not pk:
            return ""
        try:
            import base64

            body = pk.split("_", 2)[-1]
            padded = body + "=" * (-len(body) % 4)
            host = base64.urlsafe_b64decode(padded).decode().rstrip("$").strip("/")
            return f"https://{host}" if host else ""
        except Exception:
            return ""

    @property
    def clerk_authorized_parties_list(self) -> list[str]:
        """Origins the session token's `azp` claim is allowed to carry.

        Explicit CLERK_AUTHORIZED_PARTIES wins; otherwise we trust the SPA origin
        (frontend_url) plus any CORS_ALLOW_ORIGINS. Empty => azp check disabled.
        """
        raw = self.clerk_authorized_parties.strip()
        if raw:
            parties = [p.strip().rstrip("/") for p in raw.split(",") if p.strip()]
        else:
            parties = [self.frontend_url.rstrip("/")] if self.frontend_url else []
            parties += [o.strip().rstrip("/") for o in self.cors_allow_origins.split(",") if o.strip()]
        return list(dict.fromkeys(p for p in parties if p))

    @property
    def clerk_webhook_configured(self) -> bool:
        return bool(self.clerk_webhook_secret)

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
        """Build the async (asyncpg) PostgreSQL connection URL.

        Accepts whatever DATABASE_URL shape a host hands us and normalizes the
        driver: Railway/Heroku expose ``postgres://`` or ``postgresql://`` and
        SQLAlchemy needs ``postgresql+asyncpg://``. If DATABASE_URL is already an
        explicit ``+driver`` URL it is passed through untouched.

        Note: this only fixes the *scheme* — a wrong password/host in
        DATABASE_URL still fails auth at connect time. On Railway, set
        ``DATABASE_URL=${{Postgres.DATABASE_URL}}`` (a reference) so the password
        can never drift out of sync with the database service.
        """
        if self.database_url:
            url = self.database_url.strip()
            if url.startswith("postgresql+"):
                return url  # already has an explicit driver
            if url.startswith("postgresql://"):
                return url.replace("postgresql://", "postgresql+asyncpg://", 1)
            if url.startswith("postgres://"):
                return url.replace("postgres://", "postgresql+asyncpg://", 1)
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
