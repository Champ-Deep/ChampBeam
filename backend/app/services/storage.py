"""S3-compatible object storage client for the file-hosting feature.

Targets Supabase Storage via its S3-compatible endpoint
(``https://<project>.supabase.co/storage/v1/s3``). The module is named
``storage`` rather than ``supabase`` so a later swap to a different
S3-compatible backend (B2, S3, MinIO) only touches the env-var names
and the endpoint URL — call sites don't change.

When ``settings.storage_configured`` is False, the helpers raise
``StorageNotConfigured`` so callers can return a 503 with a setup hint.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import AsyncIterator

import anyio
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from app.core.config import settings

logger = logging.getLogger(__name__)


class StorageError(Exception):
    """Raised when the underlying S3 API returns an unexpected error."""


class StorageNotConfigured(Exception):
    """Raised when storage env vars are missing — caller should 503."""


@lru_cache(maxsize=1)
def _client():
    """Build (once) the boto3 S3 client pointed at Supabase Storage.

    Path-style addressing is required: Supabase doesn't do virtual-hosted
    bucket subdomains. Signature v4 is the only thing they sign with.
    """
    if not settings.storage_configured:
        raise StorageNotConfigured(
            "Storage is not configured (set SUPABASE_STORAGE_ENDPOINT, "
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


def generate_presigned_put(
    key: str, content_type: str, expires: int = 600
) -> dict[str, object]:
    """Return a presigned PUT URL + headers the browser must send.

    The browser uploads bytes directly to Supabase; Railway never sees
    them. The presigned URL self-authenticates, so the frontend must
    NOT send the Clerk Authorization header to it.
    """
    client = _client()
    try:
        url = client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": settings.supabase_storage_bucket,
                "Key": key,
                "ContentType": content_type,
            },
            ExpiresIn=expires,
            HttpMethod="PUT",
        )
    except ClientError as exc:
        raise StorageError(f"generate_presigned_put({key}): {exc}") from exc
    return {"url": url, "headers": {"Content-Type": content_type}}


def generate_presigned_get(
    key: str, filename: str | None = None, expires: int = 300
) -> str:
    """Return a short-lived signed URL the redirect handler can 302 to.

    Sets ``response-content-disposition`` so the browser proposes a
    sensible filename for downloads.
    """
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
            "get_object",
            Params=params,
            ExpiresIn=expires,
            HttpMethod="GET",
        )
    except ClientError as exc:
        raise StorageError(f"generate_presigned_get({key}): {exc}") from exc


def head_object_sync(key: str) -> dict[str, object]:
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


async def head_object(key: str) -> dict[str, object]:
    return await anyio.to_thread.run_sync(head_object_sync, key)


def delete_object_sync(key: str) -> None:
    client = _client()
    try:
        client.delete_object(Bucket=settings.supabase_storage_bucket, Key=key)
    except ClientError as exc:
        raise StorageError(f"delete_object({key}): {exc}") from exc


async def delete_object(key: str) -> None:
    await anyio.to_thread.run_sync(delete_object_sync, key)


async def stream_object(key: str, chunk_size: int = 64 * 1024) -> AsyncIterator[bytes]:
    """Async generator that yields object bytes in chunks.

    Used by the inline-stream serve mode. boto3's streaming reader is
    sync, so each chunk read is bounced through anyio's thread pool to
    keep the event loop unblocked.
    """
    client = _client()

    def _open():
        try:
            return client.get_object(
                Bucket=settings.supabase_storage_bucket, Key=key
            )
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
