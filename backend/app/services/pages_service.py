"""Beam Pages helpers: slugs, upload guardrails, serve-time injection, versions.

Pure functions plus a few session-taking helpers, kept out of the routers so
the public serve path (app/api/files.py) and the owner API (app/api/v1/pages.py)
share exactly one implementation of each rule.
"""

from __future__ import annotations

import json
import re
import secrets
import string
from typing import Optional, Sequence
from uuid import UUID

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.file_asset import FileAsset, STATUS_DELETED
from app.models.file_version import FileVersion

# ---------------------------------------------------------------------------
# Slugs
# ---------------------------------------------------------------------------

# 3–60 chars, lowercase alphanumerics and hyphens, no leading/trailing hyphen.
SLUG_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$")

# Path prefixes the app itself owns on the serving hosts, plus words that would
# be confusing as a public page address.
RESERVED_SLUGS = frozenset(
    {
        "api", "f", "p", "r", "s", "rooms", "health", "docs", "redoc", "openapi.json",
        "static", "assets", "admin", "login", "logout", "sign-in", "sign-up",
        "unlock", "unlock-code", "page-events", "_beam", "beam", "www", "null",
        "undefined",
    }
)

_SLUG_ALPHABET = string.ascii_lowercase + string.digits


def validate_slug(raw: str) -> str:
    """Normalize and validate a user-supplied slug; 400 on any rule violation."""
    slug = (raw or "").strip().lower()
    if not SLUG_RE.match(slug):
        raise HTTPException(
            status_code=400,
            detail=(
                "Slug must be 3–60 characters of lowercase letters, numbers and "
                "hyphens, and cannot start or end with a hyphen."
            ),
        )
    if slug in RESERVED_SLUGS:
        raise HTTPException(status_code=400, detail=f"'{slug}' is reserved.")
    return slug


def slugify(title: str) -> str:
    """Derive a slug candidate from a title (never raises; may need a suffix)."""
    base = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:60]
    if len(base) < 3:
        base = f"{base}-page".strip("-") if base else "page"
    if base in RESERVED_SLUGS:
        base = f"{base}-page"
    return base


def _rand(n: int = 6) -> str:
    return "".join(secrets.choice(_SLUG_ALPHABET) for _ in range(n))


async def slug_taken(
    session: AsyncSession,
    slug: str,
    domain_id: Optional[UUID],
    *,
    exclude_id: Optional[UUID] = None,
) -> bool:
    """Is ``slug`` already used in this domain namespace (NULL = platform)?

    The partial unique indexes from migration 024 are the source of truth; this
    pre-check gives a clean 409 instead of a 500 and works on sqlite tests.
    """
    stmt = select(FileAsset.id).where(
        FileAsset.slug == slug, FileAsset.status != STATUS_DELETED
    )
    stmt = (
        stmt.where(FileAsset.domain_id.is_(None))
        if domain_id is None
        else stmt.where(FileAsset.domain_id == domain_id)
    )
    if exclude_id is not None:
        stmt = stmt.where(FileAsset.id != exclude_id)
    return (await session.execute(stmt.limit(1))).scalar_one_or_none() is not None


async def unique_slug(session: AsyncSession, title: str, domain_id: Optional[UUID]) -> str:
    """Title-derived slug, unique in its namespace (random suffix on collision)."""
    base = slugify(title)
    for candidate in (base, *(f"{base[:52]}-{_rand()}" for _ in range(8))):
        if not await slug_taken(session, candidate, domain_id):
            return candidate
    raise HTTPException(status_code=503, detail="Could not allocate a unique slug.")


# ---------------------------------------------------------------------------
# Upload guardrails (PRD P0-7)
# ---------------------------------------------------------------------------

BLOCKED_EXTENSIONS = frozenset({"php", "phtml", "asp", "aspx", "jsp", "jspx", "cgi", "pl", "py", "rb"})
_HTML_EXTENSIONS = frozenset({"html", "htm"})
# Server-side templating markers. `<%` can false-positive on legitimate
# client-side templates; the error message says so.
_SERVER_CODE_MARKERS: Sequence[bytes] = (b"<?php", b"<%")


def validate_html_upload(
    filename: Optional[str], content_type: Optional[str], payload: bytes
) -> None:
    """Reject anything that is not a plain HTML document; never modify bytes."""
    name = (filename or "").strip().lower()
    ext = name.rsplit(".", 1)[-1] if "." in name else ""
    if ext in BLOCKED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f".{ext} files can't be hosted: Beam Pages serves static HTML only, "
                "no server-side code."
            ),
        )
    ctype = (content_type or "").split(";", 1)[0].strip().lower()
    if ctype and ctype != "text/html":
        raise HTTPException(
            status_code=400,
            detail=f"Content type must be text/html (got {ctype}).",
        )
    if not ctype and ext and ext not in _HTML_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Only .html files can be published.")
    if not payload.strip():
        raise HTTPException(status_code=400, detail="The page is empty.")
    if len(payload) > settings.pages_max_bytes:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Page exceeds the {settings.pages_max_bytes // (1024 * 1024)} MB limit. "
                "Pages must be a single HTML file."
            ),
        )
    lowered = payload[: 2 * 1024 * 1024].lower()
    for marker in _SERVER_CODE_MARKERS:
        if marker in lowered:
            raise HTTPException(
                status_code=400,
                detail=(
                    "This looks like server-side code "
                    f"(found {marker.decode()!r}). Beam Pages serves static HTML only; "
                    "if this is a client-side template, rename the delimiter."
                ),
            )


# ---------------------------------------------------------------------------
# Visitor identity + serve-time injection (PRD P0-3 / P0-4)
# ---------------------------------------------------------------------------

VISITOR_COOKIE = "cb_vid"
VISITOR_COOKIE_MAX_AGE = 60 * 60 * 24 * 365


def new_visitor_id() -> str:
    return secrets.token_urlsafe(16)[:22]


def valid_visitor_id(value: Optional[str]) -> Optional[str]:
    if value and 8 <= len(value) <= 32 and re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return value
    return None


_HEAD_RE = re.compile(rb"<head(?:\s[^>]*)?>", re.IGNORECASE)
_HTML_RE = re.compile(rb"<html(?:\s[^>]*)?>", re.IGNORECASE)


def inject_snippet(payload: bytes, snippet: str) -> bytes:
    """Splice ``snippet`` right after ``<head…>`` (else ``<html…>``, else at the
    very start). The stored blob is never touched; this is per-response only."""
    blob = snippet.encode("utf-8")
    m = _HEAD_RE.search(payload) or _HTML_RE.search(payload)
    if m:
        return payload[: m.end()] + blob + payload[m.end():]
    return blob + payload


def _json_for_script(obj: dict) -> str:
    # `</` inside a <script> would close the tag early; escape it.
    return json.dumps(obj, separators=(",", ":")).replace("</", "<\\/")


# Dwell heartbeat: accumulates visible time, reports on hide/unload and every
# 15 s via sendBeacon (fetch keepalive fallback). Same-origin, so it satisfies
# the hosted-HTML CSP (connect-src 'self'; inline script allowed).
_TRACKING_JS = (
    "(function(){var C=%(cfg)s;"
    "var S=(self.crypto&&crypto.randomUUID?crypto.randomUUID():String(Math.random()).slice(2)+Date.now()).slice(0,64);"
    "var acc=0,last=Date.now(),vis=document.visibilityState!=='hidden';"
    "function tick(){var n=Date.now();if(vis){acc+=n-last;}last=n;}"
    "function send(){tick();if(acc<250)return;var d=Math.min(acc,60000);acc=0;"
    "var body=JSON.stringify({session_id:S,visitor_id:C.v,events:[{page:0,dwell_ms:d}]});"
    "var blob=new Blob([body],{type:'application/json'});"
    "if(!(navigator.sendBeacon&&navigator.sendBeacon(C.u,blob))){"
    "try{fetch(C.u,{method:'POST',body:blob,keepalive:true,credentials:'same-origin',headers:{'Content-Type':'application/json'}}).catch(function(){});}catch(e){}}}"
    "document.addEventListener('visibilitychange',function(){tick();vis=document.visibilityState!=='hidden';if(!vis)send();});"
    "addEventListener('pagehide',send);setInterval(send,15000);"
    "%(extra)s})();"
)


def tracking_snippet(
    *, visitor_id: str, page_id: str, beacon_url: str, extra_js: str = ""
) -> str:
    cfg = _json_for_script({"v": visitor_id, "p": page_id, "u": beacon_url})
    return "<script>" + _TRACKING_JS % {"cfg": cfg, "extra": extra_js} + "</script>"


# ---------------------------------------------------------------------------
# Versions (PRD P0-5 / P1 rollback)
# ---------------------------------------------------------------------------


async def list_versions(session: AsyncSession, asset: FileAsset) -> list[FileVersion]:
    rows = await session.execute(
        select(FileVersion)
        .where(FileVersion.file_id == asset.id)
        .order_by(FileVersion.version_no.desc())
    )
    return list(rows.scalars().all())


async def next_version_no(session: AsyncSession, asset: FileAsset) -> int:
    current = (
        await session.execute(
            select(func.max(FileVersion.version_no)).where(FileVersion.file_id == asset.id)
        )
    ).scalar_one()
    return int(current or 0) + 1


async def record_version(
    session: AsyncSession,
    asset: FileAsset,
    *,
    storage_key: str,
    size_bytes: int,
    sha256: Optional[str],
    filename: str,
) -> FileVersion:
    version = FileVersion(
        file_id=asset.id,
        version_no=await next_version_no(session, asset),
        storage_key=storage_key,
        size_bytes=size_bytes,
        sha256=sha256,
        filename=filename,
    )
    session.add(version)
    await session.flush()
    return version


async def prune_versions(
    session: AsyncSession, asset: FileAsset, keep: Optional[int] = None
) -> list[str]:
    """Drop version rows beyond ``keep`` newest; return blob keys safe to delete
    (never the asset's live key, never a key still referenced by a kept row)."""
    keep = settings.pages_versions_keep if keep is None else keep
    versions = await list_versions(session, asset)
    kept_keys = {v.storage_key for v in versions[:keep]} | {asset.storage_key}
    doomed = versions[keep:]
    keys: list[str] = []
    for v in doomed:
        if v.storage_key not in kept_keys:
            keys.append(v.storage_key)
        await session.delete(v)
    await session.flush()
    return keys


async def current_version_no(session: AsyncSession, asset: FileAsset) -> int:
    row = (
        await session.execute(
            select(FileVersion.version_no)
            .where(FileVersion.file_id == asset.id, FileVersion.storage_key == asset.storage_key)
            .order_by(FileVersion.version_no.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    return int(row or 0)



# Beam State helper exposed to the page as window.beam (see docs/API.md). Runs
# inside the tracking IIFE; promise-based (no async/await) for older engines.
_STATE_JS = (
    "window.__BEAM__={page:%(page)s,token:%(token)s,api:'/api/pages'};"
    "(function(){var B=window.__BEAM__,H={'Content-Type':'application/json','X-Beam-Token':B.token};"
    "function u(p){return B.api+'/'+encodeURIComponent(B.page)+p}"
    "function j(m,p,b){return fetch(u(p),{method:m,headers:H,credentials:'same-origin',body:b===undefined?undefined:JSON.stringify(b)})"
    ".then(function(r){if(r.status===410){window.beam.dead=true;throw new Error('page disabled')}"
    "if(!r.ok)throw new Error('beam '+r.status);return r.status===204?null:r.json()})}"
    "window.beam={dead:false,"
    "comments:{list:function(a){return j('GET','/comments'+(a?'?after='+encodeURIComponent(a):''))},"
    "add:function(author,body){return j('POST','/comments',{author:author,body:body})}},"
    "state:{get:function(k){return j('GET','/state/'+encodeURIComponent(k)).then(function(x){return x.value})},"
    "set:function(k,v){return j('PUT','/state/'+encodeURIComponent(k),v)},"
    "all:function(){return j('GET','/state').then(function(x){return x.state})}},"
    "poll:function(ms,cb){ms=Math.max(ms||8000,3000);var t=setInterval(function(){"
    "Promise.all([window.beam.state.all(),window.beam.comments.list()]).then(function(r){cb(r[0],r[1].comments)}).catch(function(){})},ms);"
    "return function(){clearInterval(t)}}};})();"
)


def state_snippet_js(asset: FileAsset) -> str:
    """Extra JS appended inside the tracking IIFE: the Beam State helper.
    Empty when the page has no token yet (never for served pages: the serve
    path mints one before rendering)."""
    token = getattr(asset, "state_token", None)
    if not token:
        return ""
    ident = asset.slug or asset.short_code
    return _STATE_JS % {
        "page": _json_for_script({"i": ident})[5:-1],   # bare JSON string literal
        "token": _json_for_script({"t": token})[5:-1],
    }
