"""
UTM tracking models for presets, link click tracking, projects, and click events.
"""

from __future__ import annotations

from datetime import datetime
from uuid import uuid4

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text
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


class Project(Base):
    """User project for grouping tracked links."""

    __tablename__ = "projects"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    user = relationship("User", backref="projects")
    links = relationship("LinkClick", back_populates="project")


class LinkClick(Base):
    """Per-link click tracking with UTM attribution."""

    __tablename__ = "link_clicks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)

    # Short code for redirect-based tracking
    short_code = Column(String(20), unique=True, nullable=True, index=True)

    # Project grouping
    project_id = Column(UUID(as_uuid=True), ForeignKey("projects.id", ondelete="SET NULL"), nullable=True)
    project_name = Column(String(255), nullable=True)  # kept for backward compatibility

    # Link details
    original_url = Column(Text, nullable=False)
    tracked_url = Column(Text, nullable=True)
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
    project = relationship("Project", back_populates="links")
    click_events = relationship("ClickEvent", back_populates="link", cascade="all, delete-orphan")
    tags = relationship("LinkTag", secondary="link_tag_associations", back_populates="links")


class ClickEvent(Base):
    """Individual click event recorded when a redirect link is visited."""

    __tablename__ = "click_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    link_id = Column(UUID(as_uuid=True), ForeignKey("link_clicks.id", ondelete="CASCADE"), nullable=False, index=True)

    # Visitor information
    ip_address = Column(String(45), nullable=True)
    user_agent = Column(Text, nullable=True)
    referrer = Column(Text, nullable=True)

    # Parsed from user agent
    device_type = Column(String(50), nullable=True)
    browser = Column(String(100), nullable=True)
    os = Column(String(100), nullable=True)

    # GeoIP data (resolved via background task)
    country = Column(String(100), nullable=True)
    country_code = Column(String(2), nullable=True)
    region = Column(String(100), nullable=True)
    city = Column(String(100), nullable=True)
    latitude = Column(Float, nullable=True)
    longitude = Column(Float, nullable=True)

    # VPN/Proxy detection
    is_vpn = Column(Boolean, default=False, nullable=False)
    asn_org = Column(String(255), nullable=True)  # ISP/ASN organization name

    # Timestamp
    clicked_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    # Relationships
    link = relationship("LinkClick", back_populates="click_events")


class LinkTag(Base):
    """User-defined tag for organizing links."""

    __tablename__ = "link_tags"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    name = Column(String(100), nullable=False)
    color = Column(String(7), nullable=True)  # hex color, e.g. "#3b82f6"
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    user = relationship("User", backref="link_tags")
    links = relationship("LinkClick", secondary="link_tag_associations", back_populates="tags")


class LinkTagAssociation(Base):
    """Many-to-many association between links and tags."""

    __tablename__ = "link_tag_associations"

    link_id = Column(UUID(as_uuid=True), ForeignKey("link_clicks.id", ondelete="CASCADE"), primary_key=True)
    tag_id = Column(UUID(as_uuid=True), ForeignKey("link_tags.id", ondelete="CASCADE"), primary_key=True)
