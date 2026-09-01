"""Retained content versions of a hosted asset (Beam Pages rollback)."""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import BigInteger, Column, DateTime, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID

from app.db.postgres import Base


class FileVersion(Base):
    """One retained blob of a FileAsset. The asset's live ``storage_key`` always
    equals the ``storage_key`` of its current version; older versions keep their
    blobs until pruned (``settings.pages_versions_keep``)."""

    __tablename__ = "file_versions"
    __table_args__ = (UniqueConstraint("file_id", "version_no", name="uq_file_versions_file_no"),)

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("file_assets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    version_no = Column(Integer, nullable=False)
    storage_key = Column(String(255), nullable=False)
    size_bytes = Column(BigInteger, nullable=False, default=0)
    sha256 = Column(String(64), nullable=True)
    filename = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
