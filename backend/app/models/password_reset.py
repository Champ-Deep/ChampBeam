"""
Password reset token model.

Tokens are generated as cryptographically random URL-safe strings; only their
bcrypt hash is persisted so the database can never reveal a usable token.
Each row has a short TTL (default 30 minutes) and is single-use — successful
validation deletes the row.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


class PasswordResetToken(Base):
    """A single-use password reset token (hashed at rest)."""

    __tablename__ = "password_reset_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )

    # bcrypt hash of the raw token. Never store the raw token itself.
    token_hash = Column(String(255), nullable=False)

    # Short window for use; rows past this point are inert.
    expires_at = Column(DateTime, nullable=False)

    # Audit timestamps
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    used_at = Column(DateTime, nullable=True)

    user = relationship("User", backref="password_reset_tokens")
