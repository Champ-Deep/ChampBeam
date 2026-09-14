"""Deterministic link inventory and rewriting for Beam Pages.

Scope: only ``<a href>`` attributes are touched. Single-file pages carry no
external assets by design, so ``img``/``script``/``link`` srcs are out of
scope.

Rules:

- External hrefs (absolute URLs, ``//``, ``mailto:``, ``tel:``, ``data:``,
  ``#fragment``) are left byte-identical and never rewritten.
- Already-canonical platform page links (``/p/{slug}``) are left alone.
- Everything else is matched against a caller-supplied resolver map
  (basename or ``/f/{code}`` -> target URL). Matched links are rewritten;
  unmatched internal links stay byte-identical and are reported as
  ``unresolved`` so the UI can flag them.
- Rewrites preserve query strings and fragments.
- Rewriting is surgical: only the href attribute value changes. The rest of
  the document is byte-for-byte identical (no HTML re-serialization), so a
  publish with no matches produces no diff.

The resolver is pure: no DB, no network. Callers (batch publish, the page
links panel) build it from the pages they control.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

_A_TAG_RE = re.compile(r"<a\b[^>]*>", re.IGNORECASE | re.DOTALL)
_HREF_ATTR_RE = re.compile(
    r"""\bhref\s*=\s*(?P<q>["'])(?P<val>.*?)(?P=q)""", re.IGNORECASE | re.DOTALL
)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title\s*>", re.IGNORECASE | re.DOTALL)
_TAG_STRIP_RE = re.compile(r"<[^>]+>")

EXTERNAL_SCHEMES = frozenset(
    {"http", "https", "mailto", "tel", "data", "javascript", "ftp", "ftps"}
)
PLATFORM_FILE_RE = re.compile(r"^/f/([A-Za-z0-9]+)(?:/|$)")
PLATFORM_PAGE_RE = re.compile(r"^/p/([^/?#]+)")


def normalize_href(href: str) -> str:
    return (href or "").strip()


def classify_href(href: str) -> str:
    """external | platform-page | platform-file | internal | fragment."""
    h = normalize_href(href)
    if not h or h.startswith("#"):
        return "fragment"
    if h.startswith("//"):
        return "external"
    scheme = urlparse(h).scheme.lower()
    if scheme in EXTERNAL_SCHEMES:
        return "external"
    path = urlparse(h).path
    if PLATFORM_PAGE_RE.match(path):
        return "platform-page"
    if PLATFORM_FILE_RE.match(path):
        return "platform-file"
    return "internal"


def page_title(html: str) -> str | None:
    """Inline <title> text (tags stripped, whitespace collapsed), or None."""
    m = _TITLE_RE.search(html or "")
    if not m:
        return None
    title = _TAG_STRIP_RE.sub(" ", m.group(1))
    title = re.sub(r"\s+", " ", title).strip()
    return title or None


def _anchor_text(html: str, tag_end: int) -> str:
    tail = html[tag_end:]
    close = tail.find("</a")
    if close == -1:
        return ""
    text = _TAG_STRIP_RE.sub(" ", tail[:close])
    return re.sub(r"\s+", " ", text).strip()[:200]


def link_inventory(html: str) -> list[dict]:
    """One row per <a href="...">: href, anchor text, classification."""
    rows: list[dict] = []
    for m in _A_TAG_RE.finditer(html or ""):
        attr = _HREF_ATTR_RE.search(m.group(0))
        if not attr:
            continue
        href = normalize_href(attr.group("val"))
        if not href:
            continue
        rows.append(
            {
                "href": href,
                "anchor_text": _anchor_text(html, m.end()),
                "kind": classify_href(href),
            }
        )
    return rows


def _slugify_candidate(text: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")[:80]
    return base


def _build_target(
    href: str,
    resolver: dict[str, str],
    slugs: list[str],
    routes: dict[str, str] | None,
) -> tuple[str | None, str]:
    """Return (target, kind). target None means "leave the href alone" and
    kind explains why (external / platform-page / unresolved)."""
    parsed = urlparse(href)
    path = parsed.path

    # Explicit user override wins over everything, including external links
    # (the reroute panel must be able to repoint any href).
    if routes and href in routes and routes[href]:
        return routes[href] + _suffix(parsed), "routed"

    kind = classify_href(href)
    if kind in ("external", "fragment", "platform-page"):
        return None, kind

    file_match = PLATFORM_FILE_RE.match(path)
    if file_match:
        code = file_match.group(1)
        target = resolver.get(code) or resolver.get(f"/f/{code}")
        if target:
            return target + _suffix(parsed), "platform"
        return None, "unresolved"

    basename = path.rsplit("/", 1)[-1] if "/" in path else path
    for key in (basename, basename.lower()):
        if key in resolver:
            return resolver[key] + _suffix(parsed), "mapped"
    stem = basename.rsplit(".", 1)[0] if "." in basename else basename
    for key in (stem, stem.lower()):
        if key in resolver:
            return resolver[key] + _suffix(parsed), "mapped"

    # Fuzzy pass: the reference stem is usually a human filename
    # ("Event Scout 2026 - Harshil Plan.html") while the page slug is terse
    # ("harshil-plan"). Match when exactly one slug is a substring of the
    # slugified stem or vice versa; ambiguity stays unresolved.
    if slugs:
        ref_slug = _slugify_candidate(stem)
        if ref_slug:
            matches = [
                slug
                for slug in slugs
                if slug and (slug in ref_slug or ref_slug in slug)
            ]
            if len(matches) == 1:
                return resolver[matches[0]] + _suffix(parsed), "mapped"

    return None, "unresolved"


def _suffix(parsed) -> str:
    suffix = ""
    if parsed.query:
        suffix += "?" + parsed.query
    if parsed.fragment:
        suffix += "#" + parsed.fragment
    return suffix


def resolve_links(
    html: str,
    resolver: dict[str, str] | None = None,
    slugs: list[str] | None = None,
    routes: dict[str, str] | None = None,
) -> tuple[str, list[dict]]:
    """Rewrite matching hrefs in place; return (new_html, report).

    ``resolver`` maps a basename, basename-lowercased, or ``/f/{code}`` (with
    or without the prefix) to a full target URL (typically ``/p/{slug}``).
    ``slugs`` are the page slugs available for the fuzzy filename pass.
    ``routes`` are literal-href overrides that win over every other rule.

    Report rows: ``{from_href, to: str | None, kind}`` where ``to`` is None
    for unresolved links (external/fragment/platform-page links are not
    reported at all; they were never candidates).
    """
    resolver = resolver or {}
    slugs = slugs or []
    routes = routes or {}
    report: list[dict] = []
    pieces: list[str] = []
    last = 0
    for m in _A_TAG_RE.finditer(html or ""):
        pieces.append(html[last : m.start()])
        tag = m.group(0)
        attr = _HREF_ATTR_RE.search(tag)
        if not attr:
            pieces.append(tag)
            last = m.end()
            continue
        href = normalize_href(attr.group("val"))
        target, kind = _build_target(href, resolver, slugs, routes)
        if target is not None and target != href:
            new_tag = tag[: attr.start("val")] + target + tag[attr.end("val") :]
            pieces.append(new_tag)
            report.append({"from_href": href, "to": target, "kind": kind})
        else:
            if target is None and kind == "unresolved":
                report.append({"from_href": href, "to": None, "kind": "unresolved"})
            pieces.append(tag)
        last = m.end()
    pieces.append(html[last:])
    return "".join(pieces), report