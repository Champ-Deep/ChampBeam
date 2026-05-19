"""
User service for database operations.

Handles user CRUD operations with PostgreSQL persistence, plus the
password-reset token lifecycle (create, validate, consume).
"""

from __future__ import annotations

import secrets
from datetime import datetime, timedelta
from typing import Optional, Tuple
from uuid import uuid4

from sqlalchemy import delete as sa_delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.security import get_password_hash, verify_password
from app.models.password_reset import PasswordResetToken
from app.models.user import User


class UserService:
    """Service for user-related database operations."""

    async def get_by_email(self, session: AsyncSession, email: str) -> Optional[User]:
        """Get a user by email address."""
        result = await session.execute(
            select(User).where(User.email == email)
        )
        return result.scalar_one_or_none()

    async def get_by_id(self, session: AsyncSession, user_id: str) -> Optional[User]:
        """Get a user by ID."""
        result = await session.execute(
            select(User).where(User.id == user_id)
        )
        return result.scalar_one_or_none()

    async def create(
        self,
        session: AsyncSession,
        email: str,
        password: str,
        full_name: str = "",
    ) -> User:
        """Create a new user."""
        user = User(
            id=uuid4(),
            email=email,
            hashed_password=get_password_hash(password),
            full_name=full_name or None,
            is_active=True,
        )
        session.add(user)
        await session.flush()
        return user

    async def authenticate(
        self,
        session: AsyncSession,
        email: str,
        password: str,
    ) -> Optional[User]:
        """Authenticate a user by email and password."""
        user = await self.get_by_email(session, email)
        if not user or not user.is_active:
            return None
        if not verify_password(password, user.hashed_password):
            return None
        return user

    async def update_last_login(self, session: AsyncSession, user: User) -> None:
        """Update the user's last login timestamp."""
        user.last_login = datetime.utcnow()
        await session.flush()

    async def update_profile(
        self,
        session: AsyncSession,
        user: User,
        full_name: Optional[str] = None,
    ) -> User:
        """Update user profile fields."""
        if full_name is not None:
            user.full_name = full_name
        user.updated_at = datetime.utcnow()
        await session.flush()
        return user

    async def email_exists(self, session: AsyncSession, email: str) -> bool:
        """Check if an email is already registered."""
        user = await self.get_by_email(session, email)
        return user is not None

    # ------------------------------------------------------------------
    # Password reset tokens
    # ------------------------------------------------------------------

    async def create_password_reset_token(
        self,
        session: AsyncSession,
        user: User,
    ) -> Tuple[PasswordResetToken, str]:
        """Issue a fresh password reset token for the given user.

        Returns the persisted row and the raw token string. The raw token
        is what gets emailed; only its bcrypt hash lives in the database.
        Any existing tokens for the user are invalidated first so a stolen
        old token can't be used after a new reset is requested.
        """
        await session.execute(
            sa_delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
        )

        raw_token = secrets.token_urlsafe(48)
        ttl = timedelta(minutes=settings.password_reset_token_ttl_minutes)

        row = PasswordResetToken(
            id=uuid4(),
            user_id=user.id,
            token_hash=get_password_hash(raw_token),
            expires_at=datetime.utcnow() + ttl,
        )
        session.add(row)
        await session.flush()
        return row, raw_token

    async def consume_password_reset_token(
        self,
        session: AsyncSession,
        raw_token: str,
        new_password: str,
    ) -> Optional[User]:
        """Validate a reset token and atomically rotate the user's password.

        Returns the updated user on success, or None if the token is
        unknown, already used, or expired. On success the token row is
        deleted so it cannot be replayed.
        """
        if not raw_token:
            return None

        now = datetime.utcnow()

        # Fetch live (non-used, non-expired) tokens and probe each one. We
        # cannot index a bcrypt-hashed value, so a small scan is the cost
        # of storing tokens hashed at rest. Volume is naturally bounded —
        # users issue at most one active token at a time.
        result = await session.execute(
            select(PasswordResetToken).where(
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.expires_at > now,
            )
        )
        candidates = result.scalars().all()

        match: Optional[PasswordResetToken] = None
        for row in candidates:
            try:
                if verify_password(raw_token, row.token_hash):
                    match = row
                    break
            except Exception:
                continue

        if match is None:
            return None

        user = await self.get_by_id(session, str(match.user_id))
        if not user or not user.is_active:
            return None

        user.hashed_password = get_password_hash(new_password)
        user.updated_at = now

        # Invalidate every reset token belonging to this user, including
        # the one we just consumed. Single-use, hard-delete.
        await session.execute(
            sa_delete(PasswordResetToken).where(PasswordResetToken.user_id == user.id)
        )
        await session.flush()
        return user


# Singleton instance
user_service = UserService()
