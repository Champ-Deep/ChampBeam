"""
Authentication endpoints.

JWT-based auth with PostgreSQL user persistence.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends
from pydantic import BaseModel, EmailStr
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.core.config import settings
from app.core.security import (
    create_access_token,
    Token,
    TokenData,
    require_auth,
)
from app.db.postgres import get_db_session
from app.services.user_service import user_service

router = APIRouter(prefix="/auth", tags=["Authentication"])


# ============================================================================
# Request/Response Models
# ============================================================================


class LoginRequest(BaseModel):
    """Login credentials."""
    email: EmailStr
    password: str


class RegisterRequest(BaseModel):
    """Registration request."""
    email: EmailStr
    password: str
    name: str = ""


class UserResponse(BaseModel):
    """User info response."""
    user_id: str
    email: str
    full_name: Optional[str] = None


class AuthResponse(BaseModel):
    """Login/register response with token + user data."""
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserResponse


class ProfileUpdateRequest(BaseModel):
    """Profile update request."""
    full_name: Optional[str] = None


# ============================================================================
# Endpoints
# ============================================================================


@router.post("/login", response_model=AuthResponse)
async def login(
    request: LoginRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """Authenticate and receive JWT token."""
    try:
        user = await user_service.authenticate(session, request.email, request.password)
    except Exception as e:
        logger.error("Login DB error for %s: %s: %s", request.email, type(e).__name__, e)
        raise HTTPException(status_code=500, detail=f"Internal error: {type(e).__name__}")

    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")

    await user_service.update_last_login(session, user)
    await session.commit()

    access_token = create_access_token(
        data={"user_id": str(user.id), "email": user.email},
        expires_delta=timedelta(minutes=settings.jwt_access_token_expire_minutes),
    )

    return AuthResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=settings.jwt_access_token_expire_minutes * 60,
        user=UserResponse(
            user_id=str(user.id),
            email=user.email,
            full_name=user.full_name,
        ),
    )


@router.post("/register", response_model=AuthResponse)
async def register(
    request: RegisterRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """Register a new user and return JWT token."""
    if await user_service.email_exists(session, request.email):
        raise HTTPException(status_code=409, detail="User already exists")

    user = await user_service.create(
        session,
        email=request.email,
        password=request.password,
        full_name=request.name,
    )
    await session.commit()

    access_token = create_access_token(
        data={"user_id": str(user.id), "email": user.email},
        expires_delta=timedelta(minutes=settings.jwt_access_token_expire_minutes),
    )

    return AuthResponse(
        access_token=access_token,
        token_type="bearer",
        expires_in=settings.jwt_access_token_expire_minutes * 60,
        user=UserResponse(
            user_id=str(user.id),
            email=user.email,
            full_name=user.full_name,
        ),
    )


@router.get("/me", response_model=UserResponse)
async def get_current_user_info(
    user: TokenData = Depends(require_auth),
    session: AsyncSession = Depends(get_db_session),
):
    """Get current authenticated user info."""
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
    """Update the current user's profile."""
    db_user = await user_service.get_by_id(session, user.user_id)
    if not db_user:
        raise HTTPException(status_code=404, detail="User not found")

    updated_user = await user_service.update_profile(
        session, db_user, full_name=request.full_name,
    )
    await session.commit()

    return UserResponse(
        user_id=str(updated_user.id),
        email=updated_user.email,
        full_name=updated_user.full_name,
    )


@router.post("/refresh", response_model=Token)
async def refresh_token(user: TokenData = Depends(require_auth)):
    """Refresh the access token."""
    access_token = create_access_token(
        data={"user_id": user.user_id, "email": user.email},
        expires_delta=timedelta(minutes=settings.jwt_access_token_expire_minutes),
    )

    return Token(
        access_token=access_token,
        token_type="bearer",
        expires_in=settings.jwt_access_token_expire_minutes * 60,
    )
