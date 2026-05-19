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

    # JWT Authentication
    jwt_secret_key: str = "your-secret-key-change-in-production"
    jwt_algorithm: str = "HS256"
    jwt_access_token_expire_minutes: int = 1440  # 24 hours

    # Frontend URL for CORS
    frontend_url: str = "http://localhost:5173"

    # Base URL for redirect short links (e.g., https://api.champutm.com)
    # Defaults to http://localhost:8000 for local dev. Set in production env.
    redirect_base_url: str = "http://localhost:8000"

    # GeoIP Configuration
    # "maxmind" uses local GeoLite2-City.mmdb file (recommended for production)
    # "ipapi" uses ip-api.com free API (fallback, rate-limited at 45 req/min)
    geoip_provider: str = "maxmind"
    maxmind_db_path: str = "data/GeoLite2-City.mmdb"
    maxmind_asn_db_path: str = "data/GeoLite2-ASN.mmdb"
    maxmind_license_key: str = ""  # Required to download/update GeoLite2 DB

    # Resend (email delivery)
    resend_api_key: str = ""
    resend_from_email: str = "ChampUTM <no-reply@champutm.com>"

    # Password reset
    password_reset_token_ttl_minutes: int = 30
    password_reset_path: str = "/reset-password"

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
