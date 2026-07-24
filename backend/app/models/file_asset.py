"""FileAsset model, uploaded files served via tracked short links.

Mirrors the BYOD short-link pattern: a FileAsset belongs to a user and
optionally to a custom Domain. ``short_code`` is unique within its
``domain_id`` namespace (NULL for the platform-default host), enforced
by the partial unique indexes created in migration 009.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import (
    BigInteger,
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from app.db.postgres import Base


KIND_PDF = "pdf"
KIND_VIDEO = "video"
KIND_HTML = "html"
KIND_IMAGE = "image"
KIND_OTHER = "other"

STATUS_PENDING_UPLOAD = "pending_upload"
STATUS_ACTIVE = "active"
STATUS_FAILED = "failed"
STATUS_DELETED = "deleted"

SERVE_STREAM = "stream"
SERVE_REDIRECT = "redirect"


class FileAsset(Base):
    """An uploaded asset served via /f/{short_code}."""

    __tablename__ = "file_assets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    # NULL = anonymous (signed-out) upload. Guest assets carry an expiry and an
    # owner_token_hash so the uploader can poll "have they opened it?" without
    # an account.
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)

    # NULL = platform-default host. Uniqueness of short_code is enforced
    # per-domain via the partial indexes in migration 009.
    domain_id = Column(UUID(as_uuid=True), ForeignKey("domains.id", ondelete="SET NULL"), nullable=True, index=True)

    short_code = Column(String(20), nullable=False, index=True)

    filename = Column(String(255), nullable=False)
    kind = Column(String(16), nullable=False)
    mime_type = Column(String(127), nullable=False)
    size_bytes = Column(BigInteger, nullable=False, default=0)
    sha256 = Column(String(64), nullable=True)

    storage_key = Column(String(255), nullable=False)
    status = Column(String(32), nullable=False, default=STATUS_PENDING_UPLOAD, index=True)
    serve_mode = Column(String(16), nullable=False, default=SERVE_STREAM)

    view_count = Column(Integer, nullable=False, default=0)
    last_viewed_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Anonymous uploads auto-expire; NULL = never expires (authenticated users).
    # Authed users can also set an expiry via self-destruct controls.
    expires_at = Column(DateTime, nullable=True, index=True)
    # Self-destruct: view cap (burn-after-N; remaining = max_views - view_count)
    # and a manual kill. Time expiry reuses expires_at above. Enforced at serve.
    max_views = Column(Integer, nullable=True)
    revoked_at = Column(DateTime, nullable=True)
    # Access controls (see app/api/files.py serve): email gate (lead capture),
    # block VPN/proxy opens, and branded gate/expired pages.
    require_email = Column(Boolean, nullable=False, default=False)
    block_vpn = Column(Boolean, nullable=False, default=False)
    branded = Column(Boolean, nullable=False, default=False)
    # sha256 of the raw owner token handed to an anonymous uploader (once).
    owner_token_hash = Column(String(64), nullable=True)

    # Optional organizational grouping (folders). Mirrors LinkClick.project_id.
    project_id = Column(
        UUID(as_uuid=True),
        ForeignKey("projects.id", ondelete="SET NULL"),
        nullable=True,
        index=True,
    )

    user = relationship("User", backref="file_assets")
    click_events = relationship(
        "ClickEvent",
        back_populates="file",
        primaryjoin="ClickEvent.file_id == FileAsset.id",
    )
