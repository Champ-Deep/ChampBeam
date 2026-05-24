"""Authentication endpoints — Clerk-managed auth."""

from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import TokenData, require_auth
from app.db.postgres import get_db_session
from app.services.user_service import user_service

router = APIRouter(prefix="/auth", tags=["Authentication"])


class UserResponse(BaseModel):
    user_id: str
    email: str
    full_name: Optional[str] = None


class ProfileUpdateRequest(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    db_user = await user_service.get_by_id(session, user.user_id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")
    return UserResponse(
        user_id=str(db_user.id),
        email=db_user.email,
        full_name=db_user.full_name,
    )


@router.put("/profile", response_model=UserResponse)
async def update_profile(
    request: ProfileUpdateRequest,
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    db_user = await user_service.get_by_id(session, user.user_id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")
    updated = await user_service.update_profile(
        session, db_user,
        full_name=request.full_name,
        email=request.email,
    )
    await session.commit()
    return UserResponse(
        user_id=str(updated.id),
        email=updated.email,
        full_name=updated.full_name,
    )
