"""User agent parsing service."""

from __future__ import annotations

from typing import Optional

from user_agents import parse


def parse_user_agent(ua_string: str) -> dict[str, Optional[str]]:
    """Parse a User-Agent string into device type, browser, and OS.

    Returns dict with keys: device_type, browser, os.
    """
    if not ua_string:
        return {"device_type": None, "browser": None, "os": None}

    ua = parse(ua_string)

    if ua.is_mobile:
        device_type = "mobile"
    elif ua.is_tablet:
        device_type = "tablet"
    elif ua.is_bot:
        device_type = "bot"
    else:
        device_type = "desktop"

    return {
        "device_type": device_type,
        "browser": ua.browser.family,
        "os": ua.os.family,
    }
