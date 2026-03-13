"""
User service for database operations.

Handles user CRUD operations with PostgreSQL persistence.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.core.security import get_password_hash, verify_password


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


# Singleton instance
user_service = UserService()
