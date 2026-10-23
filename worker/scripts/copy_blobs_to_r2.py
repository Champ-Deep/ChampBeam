"""Copy file bytes from the old storage backend into R2.

One-time migration for the move to Cloudflare. Every blob referenced by
file_assets.storage_key and file_versions.storage_key is copied to the same key
in the R2 bucket, so the D1 rows (exported by export_postgres_to_d1.py) point
at valid objects with no rewriting. Objects already present in R2 with the
same size are skipped, so the script is safe to re-run (e.g. a final resync
right before cutover).

Sources (pick the one the old deployment used — STORAGE_BACKEND):
  --source mongo  MONGO_URL [+ MONGO_DB, MONGO_BUCKET]       (GridFS; Railway)
  --source s3     SUPABASE_STORAGE_ENDPOINT/_REGION/_ACCESS_KEY_ID/
                  _SECRET_ACCESS_KEY/_BUCKET                  (any S3 store)
  --source local  --local-root /path/to/STORAGE_LOCAL_PATH    (VPS disk)

Destination: R2's S3 API, from R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME (an R2 API token with Object Read & Write).

Usage (backend Python deps installed):
    python worker/scripts/copy_blobs_to_r2.py --database-url "$DATABASE_URL" --source mongo
"""

from __future__ import annotations

import argparse
import asyncio
import mimetypes
import os
import re
import sys
from pathlib import Path

import asyncpg
import boto3
from botocore.client import Config
from botocore.exceptions import ClientError


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        sys.exit(f"missing environment variable {name}")
    return value


async def storage_keys(dsn: str) -> list[tuple[str, str | None]]:
    conn = await asyncpg.connect(re.sub(r"^postgresql\+\w+://", "postgresql://", dsn))
    try:
        rows = await conn.fetch(
            """
            SELECT storage_key, mime_type FROM file_assets WHERE status <> 'deleted'
            UNION
            SELECT v.storage_key, a.mime_type FROM file_versions v JOIN file_assets a ON a.id = v.file_id
            """
        )
    finally:
        await conn.close()
    return [(r["storage_key"], r["mime_type"]) for r in rows]


def r2_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{env('R2_ACCOUNT_ID')}.r2.cloudflarestorage.com",
        region_name="auto",
        aws_access_key_id=env("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=env("R2_SECRET_ACCESS_KEY"),
        config=Config(signature_version="s3v4"),
    )


def make_reader(source: str, local_root: str | None):
    """Return read(key) -> bytes | None for the chosen source backend."""
    if source == "mongo":
        import gridfs
        from pymongo import MongoClient

        client = MongoClient(env("MONGO_URL"))
        bucket = gridfs.GridFSBucket(
            client[os.environ.get("MONGO_DB", "champbeam_files")],
            bucket_name=os.environ.get("MONGO_BUCKET", "fs"),
        )

        def read(key: str) -> bytes | None:
            try:
                return bucket.open_download_stream_by_name(key).read()
            except gridfs.errors.NoFile:
                return None

        return read
    if source == "s3":
        s3 = boto3.client(
            "s3",
            endpoint_url=env("SUPABASE_STORAGE_ENDPOINT"),
            region_name=os.environ.get("SUPABASE_STORAGE_REGION", "us-east-1"),
            aws_access_key_id=env("SUPABASE_STORAGE_ACCESS_KEY_ID"),
            aws_secret_access_key=env("SUPABASE_STORAGE_SECRET_ACCESS_KEY"),
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )
        src_bucket = env("SUPABASE_STORAGE_BUCKET")

        def read(key: str) -> bytes | None:
            try:
                return s3.get_object(Bucket=src_bucket, Key=key)["Body"].read()
            except ClientError:
                return None

        return read
    if source == "local":
        if not local_root:
            sys.exit("--local-root is required with --source local")
        root = Path(local_root).resolve()

        def read(key: str) -> bytes | None:
            path = (root / key).resolve()
            if root not in path.parents or not path.is_file():
                return None
            return path.read_bytes()

        return read
    sys.exit(f"unknown source {source}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--source", choices=["mongo", "s3", "local"], required=True)
    parser.add_argument("--local-root")
    args = parser.parse_args()

    keys = asyncio.run(storage_keys(args.database_url))
    read = make_reader(args.source, args.local_root)
    r2 = r2_client()
    bucket = env("R2_BUCKET_NAME", "champbeam-files")

    copied = skipped = missing = 0
    for key, mime in keys:
        data = read(key)
        if data is None:
            missing += 1
            print(f"MISSING in source: {key}")
            continue
        try:
            head = r2.head_object(Bucket=bucket, Key=key)
            if int(head.get("ContentLength") or -1) == len(data):
                skipped += 1
                continue
        except ClientError:
            pass
        content_type = mime or mimetypes.guess_type(key)[0] or "application/octet-stream"
        r2.put_object(Bucket=bucket, Key=key, Body=data, ContentType=content_type)
        copied += 1
    print(f"copied={copied} already_present={skipped} missing_in_source={missing} total={len(keys)}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
