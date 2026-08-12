"""API key management endpoints.

Keys authenticate external integrations against the rest of the API (see
app.core.security). Management itself requires an interactive Clerk session —
a leaked key must not be able to mint or revoke other keys.
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_clerk_auth
from app.db.postgres import get_db_session
from app.models.api_key import API_KEY_PREFIX, ApiKey

router = APIRouter(prefix="/api-keys", tags=["API Keys"])

MAX_ACTIVE_KEYS = 10


# --- Schemas ---


class ApiKeyCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class ApiKeyResponse(BaseModel):
    id: str
    name: str
    key_prefix: str
    last_used_at: Optional[str] = None
    revoked_at: Optional[str] = None
    created_at: str


class ApiKeyCreatedResponse(ApiKeyResponse):
    # Full key, returned exactly once at creation time.
    api_key: str


def _to_response(row: ApiKey) -> ApiKeyResponse:
    return ApiKeyResponse(
        id=str(row.id),
        name=row.name,
        key_prefix=row.key_prefix,
        last_used_at=row.last_used_at.isoformat() if row.last_used_at else None,
        revoked_at=row.revoked_at.isoformat() if row.revoked_at else None,
        created_at=row.created_at.isoformat() if row.created_at else "",
    )


async def _get_owned_key(key_id: str, user: TokenData, session: AsyncSession) -> ApiKey:
    try:
        key_uuid = UUID(key_id)
    except ValueError:
        raise HTTPException(status_code=404, detail="API key not found")
    result = await session.execute(
        select(ApiKey).where(ApiKey.id == key_uuid, ApiKey.user_id == UUID(user.user_id))
    )
    row = result.scalar_one_or_none()
    if row is None:
        raise HTTPException(status_code=404, detail="API key not found")
    return row


# --- Endpoints ---


@router.post("", response_model=ApiKeyCreatedResponse, status_code=201)
async def create_api_key(
    data: ApiKeyCreate,
    user: TokenData = Depends(require_clerk_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new API key. The full key is returned once; store it safely."""
    result = await session.execute(
        select(ApiKey).where(
            ApiKey.user_id == UUID(user.user_id), ApiKey.revoked_at.is_(None)
        )
    )
    if len(result.scalars().all()) >= MAX_ACTIVE_KEYS:
        raise HTTPException(
            status_code=400,
            detail=f"Limit of {MAX_ACTIVE_KEYS} active API keys reached; revoke one first",
        )

    raw_key = API_KEY_PREFIX + secrets.token_urlsafe(32)
    row = ApiKey(
        user_id=UUID(user.user_id),
        name=data.name.strip(),
        key_prefix=raw_key[:12],
        key_hash=hashlib.sha256(raw_key.encode()).hexdigest(),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)

    response = _to_response(row)
    return ApiKeyCreatedResponse(**response.model_dump(), api_key=raw_key)


@router.get("", response_model=List[ApiKeyResponse])
async def list_api_keys(
    user: TokenData = Depends(require_clerk_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """List the caller's API keys (prefix only — full keys are never shown again)."""
    result = await session.execute(
        select(ApiKey)
        .where(ApiKey.user_id == UUID(user.user_id))
        .order_by(ApiKey.created_at.desc())
    )
    return [_to_response(row) for row in result.scalars().all()]


@router.post("/{key_id}/revoke", response_model=ApiKeyResponse)
async def revoke_api_key(
    key_id: str,
    user: TokenData = Depends(require_clerk_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Revoke a key immediately. Revoked keys are kept for the audit trail."""
    row = await _get_owned_key(key_id, user, session)
    if row.revoked_at is None:
        row.revoked_at = datetime.utcnow()
        await session.commit()
        await session.refresh(row)
    return _to_response(row)


@router.delete("/{key_id}", response_model=ApiKeyResponse)
async def delete_api_key(
    key_id: str,
    user: TokenData = Depends(require_clerk_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Alias for revoke — keys are soft-deleted, never removed."""
    return await revoke_api_key(key_id, user, session)
