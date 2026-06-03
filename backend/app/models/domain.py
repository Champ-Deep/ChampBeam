"""Domain model for Bring-Your-Own-Domain short links.

A Domain represents a customer-owned hostname (e.g. track.acme.com) that the
user has attached to their account. Verified, active domains can be selected
when generating a tracked link; the resulting short URL is served from the
custom hostname and click events are recorded with the domain_id.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, String
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


STATUS_PENDING_CNAME = "pending_cname"
STATUS_PENDING_SSL = "pending_ssl"
STATUS_ACTIVE = "active"
STATUS_FAILED = "failed"


class Domain(Base):
    """User-attached custom hostname for short links."""

    __tablename__ = "domains"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Lowercased, no scheme, no port. Globally unique — a hostname can only be
    # claimed by one account.
    hostname = Column(String(253), unique=True, nullable=False, index=True)

    status = Column(String(32), nullable=False, default=STATUS_PENDING_CNAME, index=True)

    # Cloudflare for SaaS Custom Hostname id, when CF integration is configured.
    cf_custom_hostname_id = Column(String(64), nullable=True)
    # Mirrored from CF for the UI; e.g. "pending_validation", "active", "deleted".
    ssl_status = Column(String(64), nullable=True)
    # Last CF status payload when in `failed` state; surfaced in the UI.
    verification_errors = Column(JSONB, nullable=True)

    # When true, this is the user's default domain for new link generation.
    is_primary = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    verified_at = Column(DateTime, nullable=True)
    last_checked_at = Column(DateTime, nullable=True)

    user = relationship("User", backref="domains")
