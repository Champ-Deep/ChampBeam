"""Object storage for the file-hosting feature — swappable backends.

Two backends implement one interface:

* ``LocalStorage`` (default) writes bytes to a filesystem root
  (``settings.storage_local_path``, ideally a Railway volume) and routes
  uploads *through* the API via ``PUT /api/v1/files/{id}/blob`` — there are
  no presigned URLs, so the browser uploads to our own backend.
* ``S3Storage`` targets any S3-compatible endpoint (Supabase Storage, R2,
  S3, MinIO) via boto3 and keeps the presigned PUT/GET flow, so the browser
  uploads straight to the bucket and Railway never proxies the bytes.

The backend is chosen by ``settings.storage_backend`` ("local" | "s3").
Call sites import the module-level functions (``prepare_upload``,
``head_object``, ``delete_object``, ``stream_object``,
``generate_presigned_get``, ``write_stream``) and never touch the classes —
so flipping backends is purely an env-var change.

When the selected backend isn't usable the helpers raise
``StorageNotConfigured`` so callers can return a 503 with a setup hint.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import time
from abc import ABC, abstractmethod
from functools import lru_cache
from pathlib import Path
from typing import AsyncIterator, Optional

import anyio
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.core.config import settings

logger = logging.getLogger(__name__)


class StorageError(Exception):
    """Raised when the underlying storage returns an unexpected error."""


class StorageNotConfigured(Exception):
    """Raised when the selected backend can't be used — caller should 503."""


class StorageFileTooLarge(StorageError):
    """Raised by ``write_stream`` when the body exceeds the allowed size."""


# ============================================================================
# Blob-upload tokens (local backend)
# ============================================================================
#
# The local backend has no presigned URLs, so the blob-upload endpoint is
# authorized by a short-lived HMAC token bound to the file_id. The token rides
# in the query string (a custom header would trip CORS preflight).

BLOB_TOKEN_TTL = 600  # seconds


def make_blob_token(file_id: str, ttl: int = BLOB_TOKEN_TTL) -> str:
    expires_at = int(time.time()) + ttl
    msg = f"{file_id}:{expires_at}".encode()
    sig = hmac.new(settings.resolved_upload_secret.encode(), msg, hashlib.sha256).hexdigest()
    return f"{expires_at}.{sig}"


def verify_blob_token(file_id: str, token: str) -> bool:
    try:
        exp_str, sig = token.split(".", 1)
        expires_at = int(exp_str)
    except (ValueError, AttributeError):
        return False
    if expires_at < int(time.time()):
        return False
    msg = f"{file_id}:{expires_at}".encode()
    expected = hmac.new(settings.resolved_upload_secret.encode(), msg, hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, expected)


# ============================================================================
# Backend interface
# ============================================================================


class StorageBackend(ABC):
    name: str

    @abstractmethod
    def prepare_upload(
        self, *, file_id: str, key: str, content_type: str, size_bytes: int
    ) -> dict:
        """Return ``{"url", "headers", "via_backend"}`` for the browser PUT."""

    @abstractmethod
    def generate_presigned_get(
        self, key: str, filename: Optional[str] = None, expires: int = 300
    ) -> str:
        ...

    @abstractmethod
    async def head_object(self, key: str) -> dict:
        """Return ``{"size", "etag", "content_type"}`` or raise StorageError."""

    @abstractmethod
    async def delete_object(self, key: str) -> None:
        ...

    @abstractmethod
    async def stream_object(self, key: str, chunk_size: int = 64 * 1024) -> AsyncIterator[bytes]:
        ...

    async def write_stream(self, *, key: str, source, max_bytes: int) -> int:
        raise StorageError(f"{self.name} backend does not accept direct uploads")


# ============================================================================
# S3-compatible backend (Supabase Storage, R2, S3, MinIO, ...)
# ============================================================================


@lru_cache(maxsize=1)
def _client():
    """Build (once) the boto3 S3 client pointed at the configured endpoint.

    Path-style addressing is required for Supabase (no virtual-hosted bucket
    subdomains). Signature v4 is the only thing they sign with.
    """
    if not (
        settings.supabase_storage_endpoint
        and settings.supabase_storage_access_key_id
        and settings.supabase_storage_secret_access_key
        and settings.supabase_storage_bucket
    ):
        raise StorageNotConfigured(
            "S3 storage is not configured (set SUPABASE_STORAGE_ENDPOINT, "
            "SUPABASE_STORAGE_ACCESS_KEY_ID, SUPABASE_STORAGE_SECRET_ACCESS_KEY, "
            "SUPABASE_STORAGE_BUCKET)."
        )
    return boto3.client(
        "s3",
        endpoint_url=settings.supabase_storage_endpoint,
        region_name=settings.supabase_storage_region,
        aws_access_key_id=settings.supabase_storage_access_key_id,
        aws_secret_access_key=settings.supabase_storage_secret_access_key,
        config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
    )


class S3Storage(StorageBackend):
    name = "s3"

    def prepare_upload(self, *, file_id, key, content_type, size_bytes):
        client = _client()
        try:
            url = client.generate_presigned_url(
                "put_object",
                Params={
                    "Bucket": settings.supabase_storage_bucket,
                    "Key": key,
                    "ContentType": content_type,
                },
                ExpiresIn=BLOB_TOKEN_TTL,
                HttpMethod="PUT",
            )
        except ClientError as exc:
            raise StorageError(f"prepare_upload({key}): {exc}") from exc
        # The browser PUTs bytes directly to the bucket; Railway never sees
        # them, and the Clerk Authorization header must NOT be sent to it.
        return {"url": url, "headers": {"Content-Type": content_type}, "via_backend": False}

    def generate_presigned_get(self, key, filename=None, expires=300):
        client = _client()
        params: dict[str, object] = {
            "Bucket": settings.supabase_storage_bucket,
            "Key": key,
        }
        if filename:
            safe = filename.replace('"', "").replace("\n", " ")
            params["ResponseContentDisposition"] = f'inline; filename="{safe}"'
        try:
            return client.generate_presigned_url(
                "get_object", Params=params, ExpiresIn=expires, HttpMethod="GET"
            )
        except ClientError as exc:
            raise StorageError(f"generate_presigned_get({key}): {exc}") from exc

    def _head_sync(self, key: str) -> dict:
        client = _client()
        try:
            resp = client.head_object(Bucket=settings.supabase_storage_bucket, Key=key)
        except ClientError as exc:
            code = (exc.response or {}).get("Error", {}).get("Code")
            if code in {"404", "NoSuchKey", "NotFound"}:
                raise StorageError(f"Object not found: {key}") from exc
            raise StorageError(f"head_object({key}): {exc}") from exc
        return {
            "size": int(resp.get("ContentLength") or 0),
            "etag": (resp.get("ETag") or "").strip('"'),
            "content_type": resp.get("ContentType"),
        }

    async def head_object(self, key):
        return await anyio.to_thread.run_sync(self._head_sync, key)

    def _delete_sync(self, key: str) -> None:
        client = _client()
        try:
            client.delete_object(Bucket=settings.supabase_storage_bucket, Key=key)
        except ClientError as exc:
            raise StorageError(f"delete_object({key}): {exc}") from exc

    async def delete_object(self, key):
        await anyio.to_thread.run_sync(self._delete_sync, key)

    async def stream_object(self, key, chunk_size=64 * 1024):
        client = _client()

        def _open():
            try:
                return client.get_object(Bucket=settings.supabase_storage_bucket, Key=key)
            except ClientError as exc:
                raise StorageError(f"get_object({key}): {exc}") from exc

        obj = await anyio.to_thread.run_sync(_open)
        body = obj["Body"]
        try:
            while True:
                chunk = await anyio.to_thread.run_sync(body.read, chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            await anyio.to_thread.run_sync(body.close)


# ============================================================================
# Local filesystem backend (Railway volume)
# ============================================================================


def _rm_quiet(path: Path) -> None:
    try:
        path.unlink()
    except FileNotFoundError:
        pass


class LocalStorage(StorageBackend):
    name = "local"

    def _root(self) -> Path:
        return Path(settings.storage_local_path).resolve()

    def _abs(self, key: str) -> Path:
        """Resolve ``key`` under the storage root, rejecting path traversal."""
        root = self._root()
        target = (root / key).resolve()
        if target != root and root not in target.parents:
            raise StorageError(f"Illegal storage key: {key!r}")
        return target

    def prepare_upload(self, *, file_id, key, content_type, size_bytes):
        token = make_blob_token(file_id)
        # Absolute API path; the frontend prepends the origin of its API base
        # URL (which already ends in /api/v1) — see frontend/src/api/files.ts.
        url = f"{settings.api_v1_prefix}/files/{file_id}/blob?token={token}"
        return {"url": url, "headers": {"Content-Type": content_type}, "via_backend": True}

    def generate_presigned_get(self, key, filename=None, expires=300):
        # Local files are always stream-served; the redirect branch never runs.
        raise StorageError("Local backend serves files by streaming, not redirect.")

    async def head_object(self, key):
        path = self._abs(key)
        try:
            st = await anyio.to_thread.run_sync(os.stat, path)
        except FileNotFoundError as exc:
            raise StorageError(f"Object not found: {key}") from exc
        return {"size": int(st.st_size), "etag": None, "content_type": None}

    async def delete_object(self, key):
        path = self._abs(key)
        await anyio.to_thread.run_sync(_rm_quiet, path)

    async def stream_object(self, key, chunk_size=64 * 1024):
        path = self._abs(key)
        try:
            f = await anyio.open_file(path, "rb")
        except FileNotFoundError as exc:
            raise StorageError(f"Object not found: {key}") from exc
        try:
            while True:
                chunk = await f.read(chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            await f.aclose()

    async def write_stream(self, *, key, source, max_bytes):
        target = self._abs(key)
        tmp = target.parent / (target.name + ".part")
        await anyio.to_thread.run_sync(lambda: target.parent.mkdir(parents=True, exist_ok=True))
        total = 0
        try:
            f = await anyio.open_file(tmp, "wb")
            try:
                async for chunk in source:
                    if not chunk:
                        continue
                    total += len(chunk)
                    if total > max_bytes:
                        raise StorageFileTooLarge(
                            f"Upload exceeds the allowed size ({max_bytes} bytes)."
                        )
                    await f.write(chunk)
            finally:
                await f.aclose()
            await anyio.to_thread.run_sync(os.replace, tmp, target)
        except BaseException:
            await anyio.to_thread.run_sync(_rm_quiet, tmp)
            raise
        return total


# ============================================================================
# MongoDB GridFS backend (Railway Mongo plugin; no volume needed)
# ============================================================================


@lru_cache(maxsize=1)
def _mongo_bucket():
    """Build (once) a GridFS bucket. pymongo is imported lazily so deployments
    that don't use the mongo backend don't need it installed."""
    if not settings.mongo_url:
        raise StorageNotConfigured("MongoDB storage is not configured (set MONGO_URL).")
    from gridfs import GridFSBucket
    from pymongo import MongoClient

    client = MongoClient(settings.mongo_url)
    db = client[settings.mongo_db]
    return GridFSBucket(db, bucket_name=settings.mongo_bucket)


class MongoStorage(StorageBackend):
    """Stores blobs in GridFS. Like the local backend, bytes route through the
    API blob endpoint and serves stream back out — pymongo is sync so each call
    is bounced through anyio's thread pool to keep the event loop free."""

    name = "mongo"

    def prepare_upload(self, *, file_id, key, content_type, size_bytes):
        token = make_blob_token(file_id)
        url = f"{settings.api_v1_prefix}/files/{file_id}/blob?token={token}"
        return {"url": url, "headers": {"Content-Type": content_type}, "via_backend": True}

    def generate_presigned_get(self, key, filename=None, expires=300):
        raise StorageError("Mongo backend serves files by streaming, not redirect.")

    def _head_sync(self, key: str) -> dict:
        bucket = _mongo_bucket()
        for f in bucket.find({"filename": key}).sort("uploadDate", -1).limit(1):
            return {"size": int(f.length), "etag": getattr(f, "md5", None), "content_type": None}
        raise StorageError(f"Object not found: {key}")

    async def head_object(self, key):
        return await anyio.to_thread.run_sync(self._head_sync, key)

    def _delete_sync(self, key: str) -> None:
        bucket = _mongo_bucket()
        for f in bucket.find({"filename": key}):
            bucket.delete(f._id)

    async def delete_object(self, key):
        await anyio.to_thread.run_sync(self._delete_sync, key)

    async def stream_object(self, key, chunk_size=64 * 1024):
        bucket = _mongo_bucket()

        def _open():
            try:
                return bucket.open_download_stream_by_name(key)
            except Exception as exc:  # gridfs.NoFile and friends
                raise StorageError(f"Object not found: {key}") from exc

        grid_out = await anyio.to_thread.run_sync(_open)
        try:
            while True:
                chunk = await anyio.to_thread.run_sync(grid_out.read, chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            await anyio.to_thread.run_sync(grid_out.close)

    async def write_stream(self, *, key, source, max_bytes):
        bucket = _mongo_bucket()
        grid_in = await anyio.to_thread.run_sync(lambda: bucket.open_upload_stream(key))
        total = 0
        try:
            async for chunk in source:
                if not chunk:
                    continue
                total += len(chunk)
                if total > max_bytes:
                    raise StorageFileTooLarge(
                        f"Upload exceeds the allowed size ({max_bytes} bytes)."
                    )
                await anyio.to_thread.run_sync(grid_in.write, chunk)
            await anyio.to_thread.run_sync(grid_in.close)
        except BaseException:
            await anyio.to_thread.run_sync(grid_in.abort)
            raise
        return total


# ============================================================================
# Backend selection + module-level shims (the public surface)
# ============================================================================


def _backend() -> StorageBackend:
    """Return the active backend. Cheap to construct; any client it uses is
    cached separately (``_client`` / ``_mongo_bucket``). Not memoized so test
    suites can switch backends per process without a stale singleton."""
    backend = settings.storage_backend_normalized
    if backend == "local":
        return LocalStorage()
    if backend == "mongo":
        return MongoStorage()
    return S3Storage()


def backend_is_s3() -> bool:
    return settings.storage_backend_normalized == "s3"


def prepare_upload(file_id: str, key: str, content_type: str, size_bytes: int) -> dict:
    return _backend().prepare_upload(
        file_id=file_id, key=key, content_type=content_type, size_bytes=size_bytes
    )


def generate_presigned_get(key: str, filename: Optional[str] = None, expires: int = 300) -> str:
    return _backend().generate_presigned_get(key, filename=filename, expires=expires)


async def head_object(key: str) -> dict:
    return await _backend().head_object(key)


async def delete_object(key: str) -> None:
    await _backend().delete_object(key)


async def stream_object(key: str, chunk_size: int = 64 * 1024) -> AsyncIterator[bytes]:
    async for chunk in _backend().stream_object(key, chunk_size=chunk_size):
        yield chunk


async def write_stream(key: str, source, max_bytes: int) -> int:
    return await _backend().write_stream(key=key, source=source, max_bytes=max_bytes)
