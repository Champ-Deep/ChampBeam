"""Per-page engagement events for hosted documents (PDF / HTML).

An instrumented viewer reports how long each page (PDF) or scroll-section (HTML)
was actually visible, so the owner sees where viewers spend attention across a
document — the heatmap in the analytics mockup. One row per (view session, page)
report; aggregation rolls them up to avg-time-per-page.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Column, DateTime, ForeignKey, Integer, String
from sqlalchemy.dialects.postgresql import UUID

from app.db.postgres import Base


class PageEngagement(Base):
    __tablename__ = "page_engagements"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    file_id = Column(
        UUID(as_uuid=True),
        ForeignKey("file_assets.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # Client-generated per-view session id, so repeat views don't merge.
    session_id = Column(String(64), nullable=False, index=True)
    page = Column(Integer, nullable=False)          # page no (PDF) / section (HTML)
    dwell_ms = Column(Integer, nullable=False)      # ms the page was visible
    ip_address = Column(String(45), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
