"""Assistant API: guided feature helper with an admin provider picker.

- ``GET /assistant/config``: current provider/model/enabled plus which
  providers have keys configured and the suggested free models per provider.
- ``PUT /assistant/config``: admin-only provider/model/enabled update (a
  singleton row; API keys stay in the environment).
- ``POST /assistant/chat``: runs the guided helper against the chosen
  provider (OpenRouter or Vercel AI Gateway, mock for dev/tests). Requires
  auth and returns a plain JSON reply. 503 when disabled or the provider key
  is missing.
"""

from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import TokenData, require_auth
from app.db.postgres import get_db_session
from app.models.assistant_config import (
    ASSISTANT_PROVIDERS,
    SUGGESTED_FREE_MODELS,
    AssistantConfig,
)
from app.models.file_asset import FileAsset, KIND_HTML, STATUS_DELETED
from app.models.utm import LinkClick
from app.services import assistant as _as

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/assistant", tags=["Assistant"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str = Field(..., min_length=1, max_length=8000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(..., min_length=1, max_length=40)
    max_tokens: Optional[int] = Field(default=None, ge=64, le=2048)


class ChatResponse(BaseModel):
    reply: str
    provider: str
    model: str
    usage: dict = Field(default_factory=dict)


class AssistantConfigPut(BaseModel):
    provider: Literal["openrouter", "vercel", "mock"] = "openrouter"
    model: Optional[str] = Field(default=None, max_length=160)
    enabled: Optional[bool] = None


def _is_admin(user: TokenData) -> bool:
    # Org admins manage the shared assistant; personal-account owners manage
    # their own. Everyone else gets read-only.
    return user.org_id is None or user.org_role == "admin"


async def _overview(user_id: str, session: AsyncSession) -> dict:
    """Usage counts injected into the system prompt so the assistant can
    suggest what the user has NOT tried yet."""
    links = (
        await session.execute(select(func.count(LinkClick.id)).where(LinkClick.user_id == user_id))
    ).scalar_one()
    files = (
        await session.execute(
            select(func.count(FileAsset.id)).where(
                FileAsset.user_id == user_id, FileAsset.status != STATUS_DELETED
            )
        )
    ).scalar_one()
    pages = (
        await session.execute(
            select(func.count(FileAsset.id)).where(
                FileAsset.user_id == user_id,
                FileAsset.kind == KIND_HTML,
                FileAsset.status != STATUS_DELETED,
            )
        )
    ).scalar_one()
    return {"links": int(links or 0), "files": int(files or 0), "pages": int(pages or 0)}


async def _config_payload(row: AssistantConfig) -> dict:
    enabled = bool(settings.assistant_enabled and row.enabled)
    provider = str(row.provider)
    model = str(row.model) if row.model is not None else ""
    return {
        "provider": provider,
        "model": model,
        "enabled": enabled,
        "providers": [
            {
                "id": p,
                "configured": _as.provider_configured(p),
                "free_models": SUGGESTED_FREE_MODELS.get(p, []),
            }
            for p in sorted(ASSISTANT_PROVIDERS)
        ],
    }


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("/config")
async def get_assistant_config(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Current config + capability flags (which providers have keys set)."""
    row = await _as.config_row(session)
    await session.commit()
    return await _config_payload(row)


@router.put("/config")
async def update_assistant_config(
    data: AssistantConfigPut,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Admin-only: pick the provider (OpenRouter / Vercel AI Gateway / mock)
    and the model, or toggle the assistant off."""
    if not _is_admin(user):
        raise HTTPException(status_code=403, detail="Only organization admins can configure the assistant.")
    row = await _as.config_row(session)
    row.provider = data.provider
    if data.model is not None and data.model.strip():
        row.model = data.model.strip()
    if data.enabled is not None:
        row.enabled = data.enabled
    await session.commit()
    return await _config_payload(row)


@router.post("/chat", response_model=ChatResponse)
async def assistant_chat(
    data: ChatRequest,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """One guided reply. The user's message history comes in with the request
    (the frontend keeps the thread); the backend keeps the prompt + feature
    map and injects the user's usage counts so suggestions land on what they
    have not tried yet."""
    row = await _as.config_row(session)
    if not settings.assistant_enabled or not bool(row.enabled):
        raise HTTPException(status_code=503, detail="The assistant is disabled.")
    provider_id = str(row.provider)
    if not _as.provider_configured(provider_id):
        raise HTTPException(
            status_code=503,
            detail=(
                f"The {provider_id} provider has no API key configured. "
                "Add it in the backend environment, then pick the provider in Settings > Assistant."
            ),
        )

    provider = _as.provider_for(provider_id)
    model = str(row.model) if row.model is not None else settings.assistant_model
    overview = await _overview(str(user.user_id), session)
    messages = _as.build_messages([m.model_dump() for m in data.messages], overview)
    try:
        reply, usage = await provider.complete(
            messages,
            model,
            max_tokens=data.max_tokens or settings.assistant_max_tokens,
            timeout_s=settings.assistant_timeout_s,
        )
    except _as.AssistantError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.detail)

    return ChatResponse(reply=reply, provider=provider_id, model=model, usage=usage)