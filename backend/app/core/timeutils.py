"""Datetime serialization helpers.

The DB stores naive UTC timestamps (``datetime.utcnow()``). A bare
``.isoformat()`` omits the timezone, so browsers parse the string as *local*
time — which made clicks render at the wrong hour (e.g. "6 hours ago" right
after a click). ``iso_utc`` stamps an explicit UTC designator so the frontend's
``new Date(...)`` / ``formatDistanceToNow`` convert correctly.

Use this only for instant-in-time values (clicked_at, created_at, ...). Do NOT
use it for day-bucket labels coming from ``date_trunc`` — those are meant to be
read as calendar days, not UTC instants, and stamping a timezone would shift
them across midnight.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional


def iso_utc(dt: Optional[datetime]) -> Optional[str]:
    """ISO-8601 string with an explicit UTC offset (``...Z``), or None."""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
