"""
User service for database operations.

Handles user CRUD operations with PostgreSQL persistence.
"""

from __future__ import annotations

from datetime import datetime
from typing import Optional
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

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
        password: Optional[str] = None,
        full_name: str = "",
    ) -> User:
        """Create a new user."""
        user = User(
            id=uuid4(),
            email=email,
            hashed_password=password,
            full_name=full_name or None,
            is_active=True,
        )
        session.add(user)
        await session.flush()
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
        email: Optional[str] = None,
    ) -> User:
        """Update user profile fields."""
        if full_name is not None:
            user.full_name = full_name
        if email is not None:
            user.email = email
        user.updated_at = datetime.utcnow()
        await session.flush()
        return user

    async def email_exists(self, session: AsyncSession, email: str) -> bool:
        """Check if an email is already registered."""
        user = await self.get_by_email(session, email)
        return user is not None

    @staticmethod
    def has_placeholder_email(user: User) -> bool:
        """True while the user still carries the stub email minted on first auth."""
        return bool(user.email) and user.email.endswith("@clerk.placeholder")

    async def apply_identity(
        self,
        session: AsyncSession,
        user: User,
        email: Optional[str] = None,
        full_name: Optional[str] = None,
    ) -> bool:
        """Fill in real email/name from Clerk, overwriting only the placeholder.

        Returns True when something changed. Email is only replaced while it is
        still the ``@clerk.placeholder`` stub, so a user who later edits their
        profile here isn't clobbered. Guards against the unique-email constraint
        by skipping an email already taken by a different row.
        """
        changed = False
        if email and self.has_placeholder_email(user) and email != user.email:
            clash = await session.execute(
                select(User).where(User.email == email, User.id != user.id)
            )
            if clash.scalar_one_or_none() is None:
                user.email = email
                changed = True
        if full_name and not user.full_name:
            user.full_name = full_name
            changed = True
        if changed:
            user.updated_at = datetime.utcnow()
            await session.flush()
        return changed

    async def get_or_create_by_clerk_id(self, session: AsyncSession, clerk_id: str) -> User:
        """Look up a user by Clerk ID, creating a stub row on first auth.

        Race-safe: if two concurrent requests for a brand-new Clerk ID try to
        INSERT at the same time, one will hit the unique constraint on
        ``clerk_id``. We catch that, roll back, and re-SELECT to return the
        row the winner just created.
        """
        result = await session.execute(
            select(User).where(User.clerk_id == clerk_id)
        )
        user = result.scalar_one_or_none()
        if user:
            return user

        user = User(
            id=uuid4(),
            clerk_id=clerk_id,
            email=f"{clerk_id}@clerk.placeholder",
            is_active=True,
        )
        session.add(user)
        try:
            await session.flush()
            return user
        except IntegrityError:
            await session.rollback()
            result = await session.execute(
                select(User).where(User.clerk_id == clerk_id)
            )
            existing = result.scalar_one_or_none()
            if existing is None:
                raise
            return existing


# Singleton instance
user_service = UserService()
