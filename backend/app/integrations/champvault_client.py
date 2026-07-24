"""ChampVault content-hub client (external, read-only).

ChampVault stores client-facing assets on Cloudflare R2 + Stream. ChampBeam is a
thin consumer: it lists the library, mints a short-lived delivery URL, wraps that
URL in a tracked beam, and records the opens — it never stores the bytes.

Reads credentials from settings (CHAMPVAULT_URL / CHAMPVAULT_API_KEY) so an
unconfigured deployment degrades to a clean 503 instead of crashing on import.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional

import httpx

from app.core.config import settings


class ChampVaultError(RuntimeError):
    """ChampVault returned a non-success response."""


class ChampVaultNotConfigured(RuntimeError):
    """CHAMPVAULT_URL / CHAMPVAULT_API_KEY are unset; caller should 503."""


@dataclass
class Asset:
    id: str
    title: str
    type: str
    storage: str
    status: str
    mime: Optional[str]
    size_bytes: Optional[int]
    duration_s: Optional[int]
    has_thumbnail: bool
    thumbnail_key: Optional[str]
    tags: list[str]
    description: Optional[str] = None
    created_at: Optional[int] = None
    updated_at: Optional[int] = None

    @classmethod
    def from_json(cls, d: dict[str, Any]) -> "Asset":
        return cls(
            id=d["id"],
            title=d.get("title", ""),
            type=d.get("type", ""),
            storage=d.get("storage", ""),
            status=d.get("status", ""),
            mime=d.get("mime"),
            size_bytes=d.get("sizeBytes"),
            duration_s=d.get("durationS"),
            has_thumbnail=bool(d.get("hasThumbnail")),
            thumbnail_key=d.get("thumbnailKey"),
            tags=d.get("tags", []) or [],
            description=d.get("description"),
            created_at=d.get("createdAt"),
            updated_at=d.get("updatedAt"),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "type": self.type,
            "storage": self.storage,
            "status": self.status,
            "mime": self.mime,
            "size_bytes": self.size_bytes,
            "duration_s": self.duration_s,
            "has_thumbnail": self.has_thumbnail,
            "thumbnail_key": self.thumbnail_key,
            "tags": self.tags,
            "description": self.description,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }


class ChampVault:
    """Async client for the read-only ChampVault API."""

    def __init__(
        self,
        base: str | None = None,
        api_key: str | None = None,
        timeout: float = 15.0,
    ):
        self.base = (base if base is not None else settings.champvault_url).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.champvault_api_key
        self._timeout = timeout

    def _require(self) -> None:
        if not (self.base and self.api_key):
            raise ChampVaultNotConfigured(
                "ChampVault is not configured (set CHAMPVAULT_URL and CHAMPVAULT_API_KEY)."
            )

    @property
    def _headers(self) -> dict[str, str]:
        return {"x-api-key": self.api_key}

    async def _get(self, path: str, params: dict | None = None) -> Any:
        self._require()
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.get(
                f"{self.base}/api/v1{path}",
                params={k: v for k, v in (params or {}).items() if v},
                headers=self._headers,
            )
        if resp.status_code >= 400:
            raise ChampVaultError(f"GET {path} -> {resp.status_code}: {resp.text}")
        return resp.json()

    async def list_assets(
        self,
        *,
        type: str | None = None,
        tag: str | None = None,
        q: str | None = None,
        collection: str | None = None,
        status: str | None = None,
    ) -> list[Asset]:
        data = await self._get(
            "/assets",
            {"type": type, "tag": tag, "q": q, "collection": collection, "status": status},
        )
        return [Asset.from_json(a) for a in data.get("assets", [])]

    async def get_asset(self, asset_id: str) -> Asset:
        return Asset.from_json((await self._get(f"/assets/{asset_id}"))["asset"])

    async def list_collections(self) -> list[dict[str, Any]]:
        return (await self._get("/collections")).get("collections", [])

    async def deliver(self, asset_id: str, expires_in_s: int = 3600, timeout: float | None = None) -> dict[str, Any]:
        """Mint a delivery URL. Returns {kind, url|hlsUrl|iframeUrl, expiresAt}."""
        self._require()
        async with httpx.AsyncClient(timeout=timeout or self._timeout) as client:
            resp = await client.post(
                f"{self.base}/api/v1/assets/{asset_id}/deliver",
                headers={**self._headers, "content-type": "application/json"},
                json={"expiresInS": expires_in_s},
            )
        if resp.status_code >= 400:
            raise ChampVaultError(f"deliver {asset_id} -> {resp.status_code}: {resp.text}")
        return resp.json()


def delivery_target(delivered: dict[str, Any]) -> Optional[str]:
    """The human-facing URL to wrap in a beam.

    Files serve their bytes inline at ``url``. Videos should open the embeddable
    Cloudflare player (``iframeUrl``), not the raw HLS manifest — so a click in a
    browser plays rather than downloads a ``.m3u8``.
    """
    if delivered.get("kind") == "video":
        return delivered.get("iframeUrl") or delivered.get("hlsUrl")
    return delivered.get("url") or delivered.get("iframeUrl") or delivered.get("hlsUrl")
