"""
UTM tracking models for presets and link click tracking.

Simplified for ChampUTM — no team/campaign coupling.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import UUID, JSON
from sqlalchemy.orm import relationship

from app.db.postgres import Base


class UTMPreset(Base):
    """Reusable UTM parameter presets scoped to a user."""

    __tablename__ = "utm_presets"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    is_default = Column(Boolean, default=False)
    is_shared = Column(Boolean, default=False)

    # UTM fields
    utm_source = Column(String(255), nullable=True)
    utm_medium = Column(String(255), nullable=True)
    utm_campaign = Column(String(255), nullable=True)
    utm_content = Column(String(255), nullable=True)
    utm_term = Column(String(255), nullable=True)

    # Additional custom parameters
    custom_params = Column(JSON, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", backref="utm_presets")


class LinkClick(Base):
    """Per-link click tracking with UTM attribution."""

    __tablename__ = "link_clicks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    # Optional grouping
    project_name = Column(String(255), nullable=True)

    # Link details
    original_url = Column(Text, nullable=False)
    tracked_url = Column(Text, nullable=True)
    short_code = Column(String(50), unique=True, index=True, nullable=True)
    anchor_text = Column(String(500), nullable=True)
    link_position = Column(Integer, nullable=True)

    # UTM attribution
    utm_source = Column(String(255), nullable=True)
    utm_medium = Column(String(255), nullable=True)
    utm_campaign = Column(String(255), nullable=True)
    utm_content = Column(String(255), nullable=True)
    utm_term = Column(String(255), nullable=True)

    # Click metrics
    click_count = Column(Integer, default=0)
    unique_clicks = Column(Integer, default=0)
    first_clicked_at = Column(DateTime, nullable=True)
    last_clicked_at = Column(DateTime, nullable=True)

    # Timestamps
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", backref="link_clicks")
