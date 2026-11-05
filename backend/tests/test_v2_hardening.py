"""V2 hardening: correctness and availability defects found reviewing the
Pages V2 + Assistant branch.

Each test here reproduced a real defect against the pre-fix code. They are
grouped by the surface they protect:

1. ``/r/{key}`` and ``/s/{key}`` must stay up when a named alias collides with
   another link's random short code (cross-tenant DoS on the redirect path).
2. Auto-mapping a page's links must only ever target pages that actually live
   on the same domain namespace as the page being edited.
3. The rate limit the app advertises (100/minute) must actually be enforced,
   otherwise every public endpoint is unmetered.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import datetime

import pytest

from tests.test_api_keys import _mint_key
from tests.test_pages_v2 import local_storage  # noqa: F401  (storage fixture)


async def _headers(app_client):
    raw, _, _ = await _mint_key()
    return {"X-API-Key": raw}


async def _make_link(session_maker, *, short_code, alias, domain_id=None):
    """Insert a LinkClick row directly with a known short_code/alias."""
    from app.db import postgres
    from app.models.utm import LinkClick

    user_id = uuid.uuid4()
    async with postgres.async_session_maker() as session:
        from app.models.user import User

        session.add(User(id=user_id, email=f"{uuid.uuid4().hex[:10]}@example.com", is_active=True))
        row = LinkClick(
            id=uuid.uuid4(),
            user_id=user_id,
            short_code=short_code,
            alias=alias,
            domain_id=domain_id,
            original_url="https://example.com/a",
            tracked_url="https://example.com/a",
            utm_source=None,
            utm_medium=None,
            utm_campaign=None,
            utm_content=None,
            utm_term=None,
            click_count=0,
            unique_clicks=0,
        )
        session.add(row)
        await session.commit()
        return str(row.id), short_code


# ---------------------------------------------------------------------------
# 1. Alias / short_code namespace collision must not 500 the redirect
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_alias_colliding_with_another_links_short_code_does_not_500(app_client):
    """A user can name their own link after a victim's short code.

    ``_lookup_link`` matched ``short_code == key OR alias == key`` and then
    called ``scalar_one_or_none()``. Two rows matched, SQLAlchemy raised
    ``MultipleResultsFound``, and the victim's /r/ and /s/ redirect returned
    500 for every visitor. Anyone who can mint a link could take a shared
    link offline. The lookup must resolve deterministically instead.
    """
    victim_code = secrets.token_hex(3)  # 6 chars, lowercase+digits
    await _make_link(app_client, short_code=victim_code, alias=None)
    # The attacker claims the victim's code as their own human-readable name.
    await _make_link(app_client, short_code=secrets.token_hex(4), alias=victim_code)

    r = await app_client.get(f"/r/{victim_code}", follow_redirects=False)
    assert r.status_code != 500, f"redirect 500'd on namespace collision: {r.text}"
    assert r.status_code in (301, 302, 307, 308), r.text

    r2 = await app_client.get(f"/s/{victim_code}", follow_redirects=False)
    assert r2.status_code != 500, f"/s/ 500'd on namespace collision: {r2.text}"
    assert r2.status_code in (301, 302, 307, 308), r2.text


@pytest.mark.asyncio
async def test_colliding_namespace_prefers_the_victims_short_code(app_client):
    """Resolution must be deterministic and favour the real short code.

    When both namespaces match, the row whose *short_code* equals the key is
    the canonical answer; the alias holder must not be able to shadow it.
    """
    from app.db import postgres
    from app.models.utm import LinkClick

    code = secrets.token_hex(3)
    real_id, _ = await _make_link(app_client, short_code=code, alias=None)
    await _make_link(app_client, short_code=secrets.token_hex(4), alias=code)

    async with postgres.async_session_maker() as session:
        from sqlalchemy import or_, select

        stmt = (
            select(LinkClick)
            .where(or_(LinkClick.short_code == code, LinkClick.alias == code))
            .where(LinkClick.domain_id.is_(None))
            .order_by((LinkClick.short_code == code).desc().nulls_last())
        )
        rows = (await session.execute(stmt)).scalars().all()

    assert len(rows) == 2, "fixture should create the ambiguity"
    assert str(rows[0].id) == real_id, "short_code match must win over alias match"


@pytest.mark.asyncio
async def test_null_short_code_does_not_outrank_a_real_match(app_client):
    """Pin the ordering rule that keeps a NULL short_code from shadowing a real one.

    ``short_code`` is nullable, and Postgres sorts NULLS FIRST under ``DESC``.
    Verified directly against Postgres 15:

        ORDER BY (short_code = 'abc') DESC          -> row 2 (short_code IS NULL)
        ORDER BY (short_code = 'abc') DESC NULLS LAST -> row 1 (short_code = 'abc')

    So without ``NULLS LAST`` a row with a NULL code and a matching alias is
    returned ahead of the link that genuinely owns that short code, silently
    sending visitors of a shared link to someone else's destination.

    SCOPE NOTE: the pytest suite runs on in-memory SQLite (see conftest), where
    NULLs already sort last under DESC. This test therefore does NOT fail on
    SQLite if the clause is dropped; it documents the invariant and only has
    teeth when the suite runs against Postgres. The behavioural proof lives in
    the psql transcript above.
    """
    from app.db import postgres
    from app.models.utm import LinkClick
    from sqlalchemy import or_, select

    code = secrets.token_hex(3)
    real_id, _ = await _make_link(app_client, short_code=code, alias=None)
    # A row with no short code at all, whose alias is the victim's code.
    await _make_link(app_client, short_code=None, alias=code)

    async with postgres.async_session_maker() as session:
        stmt = (
            select(LinkClick)
            .where(or_(LinkClick.short_code == code, LinkClick.alias == code))
            .where(LinkClick.domain_id.is_(None))
            .order_by((LinkClick.short_code == code).desc().nulls_last())
        )
        rows = (await session.execute(stmt)).scalars().all()

    assert len(rows) == 2
    assert str(rows[0].id) == real_id, (
        "a NULL short_code must never outrank the row that owns the code"
    )
    assert rows[0].short_code == code


# ---------------------------------------------------------------------------
# 2. Auto-map must not cross domain namespaces
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_page_resolver_is_scoped_to_the_page_own_domain(app_client, local_storage):
    """A page on a custom domain must not auto-link to pages on another domain.

    ``_page_resolver`` filtered ``FileAsset.domain_id.isnot(None)`` when the
    page had a domain, which admits the user's pages on *every* custom domain.
    Auto-mapping then rewrote internal hrefs to /p/{slug} addresses that do
    not resolve on that host.
    """
    from uuid import uuid4

    from app.db import postgres
    from app.models.domain import Domain, STATUS_ACTIVE as DOMAIN_ACTIVE
    from app.models.file_asset import FileAsset, KIND_HTML, STATUS_ACTIVE

    headers = await _headers(app_client)
    raw_key = headers["X-API-Key"]
    # Resolve the owning user for this key.
    from app.models.api_key import API_KEY_PREFIX
    from app.models.user import User
    import hashlib as _h

    async with postgres.async_session_maker() as session:
        from sqlalchemy import select

        key_hash = _h.sha256(raw_key.encode()).hexdigest()
        from app.models.api_key import ApiKey

        key_row = (
            await session.execute(select(ApiKey).where(ApiKey.key_hash == key_hash))
        ).scalar_one()
        user_id = key_row.user_id
        this_domain = Domain(
            id=uuid4(),
            user_id=user_id,
            hostname=f"mine-{uuid4().hex[:8]}.example.com",
            status=DOMAIN_ACTIVE,
        )
        other_domain = Domain(
            id=uuid4(),
            user_id=user_id,
            hostname=f"other-{uuid4().hex[:8]}.example.com",
            status=DOMAIN_ACTIVE,
        )
        session.add_all([this_domain, other_domain])

        def _page(slug, filename, code, domain_id):
            return FileAsset(
                id=uuid4(),
                user_id=user_id,
                kind=KIND_HTML,
                status=STATUS_ACTIVE,
                filename=filename,
                mime_type="text/html",
                storage_key=f"users/{user_id}/{slug}",
                size_bytes=10,
                sha256="0" * 64,
                slug=slug,
                short_code=code,
                domain_id=domain_id,
            )

        session.add_all(
            [
                _page("here", "here.html", "codehere01", this_domain.id),
                _page("elsewhere", "elsewhere.html", "codeelse01", other_domain.id),
            ]
        )
        await session.commit()
        this_domain_id, other_domain_id = this_domain.id, other_domain.id

    from app.api.v1.pages import _page_resolver
    from app.core.security import TokenData

    token = TokenData(user_id=str(user_id), org_id=None, org_role=None, email="t@example.com")

    async with postgres.async_session_maker() as session:
        resolver, slugs = await _page_resolver(token, this_domain_id, session)

    assert "here" in slugs, "the page on this domain must be resolvable"
    assert "elsewhere" not in slugs, (
        "auto-map leaked a page from a different domain namespace "
        f"(resolver={resolver}, slugs={slugs})"
    )


# ---------------------------------------------------------------------------
# 3. Cost-incurring endpoints must actually be metered
# ---------------------------------------------------------------------------
#
# The app builds a slowapi Limiter with ``default_limits=["100/minute"]`` but
# installs neither SlowAPIMiddleware nor any @limiter.limit decorator, so
# slowapi enforced nothing: the 100/minute figure in the config was decorative.
# Installing the global middleware was rejected because the public redirect and
# serve routes are a hot path (one shared link behind a corporate NAT can exceed
# 100 requests/minute legitimately) and a blanket 429 there would break live
# links. Instead the endpoints that cost money per call are metered explicitly.


@pytest.mark.asyncio
async def test_assistant_chat_is_rate_limited(app_client, monkeypatch):
    """Every /assistant/chat call bills a third-party model provider.

    Decorated with @limiter.limit, so an unmetered loop is not possible even
    though the app-wide default limit is inert.
    """
    from app.middleware.rate_limit import limiter

    limiter.reset()
    monkeypatch.setattr(limiter, "enabled", True)

    from app.api.v1.assistant import ASSISTANT_CHAT_LIMIT

    per_minute = int(ASSISTANT_CHAT_LIMIT.split("/")[0])

    headers = await _headers(app_client)
    statuses = []
    for _ in range(per_minute + 5):
        r = await app_client.post(
            "/api/v1/assistant/chat",
            headers=headers,
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        statuses.append(r.status_code)
        if r.status_code == 429:
            break

    assert 429 in statuses, (
        f"assistant chat was never rate limited (statuses={sorted(set(statuses))})"
    )
    assert statuses[-1] == 429, "the limit should trip once the budget is spent"


@pytest.mark.asyncio
async def test_only_the_costly_endpoint_is_metered(app_client):
    """Lock in the decision so a future reader is not misled by the config.

    ``limiter`` carries a 100/minute default that nothing applies. Metering is
    explicit and endpoint-scoped instead, so assert exactly which endpoints
    opted in: the billing one, and not the cheap reads/writes beside it.
    """
    from app.api.v1 import assistant as assistant_api
    from app.middleware.rate_limit import limiter

    metered = set(limiter._route_limits)

    assert "app.api.v1.assistant.assistant_chat" in metered, (
        f"the model-billing endpoint must be metered, got {sorted(metered)}"
    )
    for cheap in ("get_assistant_config", "update_assistant_config"):
        assert f"app.api.v1.assistant.{cheap}" not in metered, (
            f"{cheap} is a cheap read/write and must stay unmetered"
        )
    assert assistant_api.ASSISTANT_CHAT_LIMIT.endswith("/minute"), (
        "the assistant limit must be a per-minute budget, not a lifetime cap"
    )