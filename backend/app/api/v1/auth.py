"""
Authentication endpoints.

JWT-based auth with PostgreSQL user persistence.
"""

from __future__ import annotations

import logging
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
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
from app.middleware.rate_limit import limiter
from app.services.email_service import email_service
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


class ForgotPasswordRequest(BaseModel):
    """Request a password reset email."""
    email: EmailStr


class ForgotPasswordResponse(BaseModel):
    """Generic response — always the same wording regardless of whether
    the email matched an account, to prevent user enumeration."""
    message: str = (
        "If this email is in our system, you will receive a reset link shortly."
    )


class ResetPasswordRequest(BaseModel):
    """Submit a new password using a reset token from the email link."""
    token: str = Field(..., min_length=10, description="Raw token from the reset link.")
    new_password: str = Field(..., min_length=8, description="The new password.")


class ResetPasswordResponse(BaseModel):
    """Outcome of a password reset."""
    success: bool
    message: str


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
    if not db_user or not db_user.is_active:
        raise HTTPException(status_code=404, detail="User not found")

    if not user_service.jwt_iat_is_current(db_user, user.iat):
        raise HTTPException(
            status_code=401,
            detail="Session invalidated. Please sign in again.",
        )

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


@router.post("/forgot-password", response_model=ForgotPasswordResponse)
@limiter.limit("5/15minutes")
async def forgot_password(
    request: Request,
    payload: ForgotPasswordRequest,
    background_tasks: BackgroundTasks,
    session: AsyncSession = Depends(get_db_session),
):
    """Step 1 of the password reset flow.

    Always returns the same generic success message regardless of whether
    the email matches an account — prevents leaking which addresses are
    registered. If the user does exist, a token is generated, hashed, and
    persisted, and an email with the reset link is dispatched via Resend.

    Rate limited to 5 requests / 15 min per key (IP or authenticated user)
    so this endpoint can't be used to flood an inbox or enumerate emails.
    """
    user = await user_service.get_by_email(session, payload.email)

    if user and user.is_active:
        _row, raw_token = await user_service.create_password_reset_token(session, user)
        await session.commit()

        # Dispatch the email out-of-band so the request returns immediately
        # and the response timing doesn't reveal whether the account exists.
        background_tasks.add_task(
            email_service.send_password_reset_email,
            to=user.email,
            token=raw_token,
        )
        logger.info("Password reset requested for user_id=%s", user.id)
    else:
        logger.info(
            "Password reset requested for unknown email=%s (responding generically)",
            payload.email,
        )

    return ForgotPasswordResponse()


@router.post("/reset-password", response_model=ResetPasswordResponse)
@limiter.limit("10/15minutes")
async def reset_password(
    request: Request,
    payload: ResetPasswordRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """Step 2 of the password reset flow.

    Validates the raw token against the stored bcrypt hash + expiry,
    rotates the user's password, and deletes the token so it cannot be
    replayed. Rate limited to defeat brute-force guessing.
    """
    user = await user_service.consume_password_reset_token(
        session, payload.token, payload.new_password
    )
    if not user:
        # Generic 400 — don't leak whether the token was expired, unknown,
        # or matched a disabled account.
        raise HTTPException(
            status_code=400,
            detail="This reset link is invalid or has expired.",
        )

    await session.commit()
    logger.info("Password reset completed for user_id=%s", user.id)
    return ResetPasswordResponse(
        success=True,
        message="Your password has been reset. You can now sign in with your new password.",
    )
