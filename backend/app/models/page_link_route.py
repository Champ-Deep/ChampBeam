"""Literal-href → target override for one hosted page.

One row per reroute: when the owner changes "where this link goes" from the
Links panel without touching the HTML, the change lands here and is baked into
the next produced version by the link rewriter. Route rows outlive individual
versions so a later replace keeps honoring them.

``src_href`` is the literal (normalized) href from the page's HTML; the
rewriter matches exact equality. ``target_url`` may be a hosted /p/ URL, any
absolute URL, or a relative path.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, Text
from sqlalchemy.dialects.postgresql import UUID

from app.db.postgres import Base


class PageLinkRoute(Base):
    __tablename__ = "page_link_routes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    page_id = Column(
        UUID(as_uuid=True),
        ForeignKey("file_assets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    src_href = Column(Text, nullable=False)
    target_url = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)