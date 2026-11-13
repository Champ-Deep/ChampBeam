"""Read the stored page out of a served HTML response.

HTML serves inject a tracking snippet before ``<body>``. That snippet embeds a
random visitor id and a page state token (url-safe strings), so a short marker
such as ``v1`` can appear in the full document by chance.
"""

from __future__ import annotations

import re

_BODY_RE = re.compile(r"<body(?:\s[^>]*)?>(.*)</body>", re.IGNORECASE | re.DOTALL)


def document_body(html: str) -> str:
    """Return the ``<body>`` contents. The tracking snippet is outside the body."""
    match = _BODY_RE.search(html)
    if match is None:
        raise AssertionError("served HTML has no <body>")
    return match.group(1)
