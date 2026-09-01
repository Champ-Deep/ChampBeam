"""Beam Pages P0: slugs, /p/ serving, serve-time injection, guardrails,
visitor/revisit, dwell beacon, versions/rollback, kill switch."""

from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.core.config import settings
from app.services import pages_service

HTML = "<!doctype html><html><head><title>T</title></head><body><p>hello</p><script>localStorage.x=1</script></body></html>"


@pytest.fixture()
def local_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    return tmp_path


async def _key(app_client):
    from tests.test_api_keys import _mint_key

    raw, _, user = await _mint_key()
    return {"X-API-Key": raw}, user


async def _publish(app_client, headers, **body):
    payload = {"html": HTML, "title": "Pallab North Star"}
    payload.update(body)
    r = await app_client.post("/api/v1/pages", json=payload, headers=headers)
    assert r.status_code == 201, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Publish + serve
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_publish_serves_on_slug_and_legacy_code(app_client, local_storage):
    headers, _ = await _key(app_client)
    page = await _publish(app_client, headers)
    assert page["slug"] == "pallab-north-star"
    assert page["url"].endswith("/p/pallab-north-star")
    assert page["legacy_url"].endswith(f"/f/{page['short_code']}")
    assert page["current_version"] == 1

    r = await app_client.get("/p/pallab-north-star")
    assert r.status_code == 200
    assert "cb_vid=" in r.headers.get("set-cookie", "")
    assert r.headers["cache-control"] == "no-store"
    assert "content-security-policy" in r.headers
    assert "<script>(function(){var C=" in r.text  # injected snippet
    assert "localStorage.x=1" in r.text  # original inline JS preserved
    assert r.headers["content-length"] == str(len(r.content))

    legacy = await app_client.get(f"/f/{page['short_code']}")
    assert legacy.status_code == 200 and "<script>(function(){var C=" in legacy.text


@pytest.mark.asyncio
async def test_stored_blob_is_byte_identical(app_client, local_storage):
    headers, _ = await _key(app_client)
    await _publish(app_client, headers)
    files = [p for p in local_storage.rglob("*.html")]
    assert len(files) == 1
    assert files[0].read_bytes() == HTML.encode()


def test_injection_placement():
    snip = "<script>x</script>"
    assert pages_service.inject_snippet(b"<HTML><HEAD lang=en><title>a</title>", snip) == b"<HTML><HEAD lang=en>" + snip.encode() + b"<title>a</title>"
    assert pages_service.inject_snippet(b"<html><body>no head</body></html>", snip) == b"<html>" + snip.encode() + b"<body>no head</body></html>"
    assert pages_service.inject_snippet(b"plain text", snip) == snip.encode() + b"plain text"


def test_snippet_escapes_script_close():
    s = pages_service.tracking_snippet(visitor_id="v</script><b>", page_id="p", beacon_url="/f/x/page-events")
    assert "</script><b>" not in s.split("</script>")[0]


# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_multipart_upload_and_rejections(app_client, local_storage, monkeypatch):
    headers, _ = await _key(app_client)
    ok = await app_client.post(
        "/api/v1/pages/upload",
        files={"file": ("board.html", HTML.encode(), "text/html")},
        data={"title": "APAC Handover"},
        headers=headers,
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["slug"] == "apac-handover"

    bad_ext = await app_client.post("/api/v1/pages/upload", files={"file": ("x.php", b"<html>", "text/html")}, headers=headers)
    assert bad_ext.status_code == 400 and "server-side" in bad_ext.json()["detail"]

    bad_type = await app_client.post("/api/v1/pages/upload", files={"file": ("x.html", b"<html>", "text/plain")}, headers=headers)
    assert bad_type.status_code == 400

    php = await app_client.post("/api/v1/pages", json={"html": "<html><?php echo 1; ?></html>", "title": "x"}, headers=headers)
    assert php.status_code == 400 and "server-side" in php.json()["detail"]

    asp = await app_client.post("/api/v1/pages", json={"html": "<html><% x %></html>", "title": "x"}, headers=headers)
    assert asp.status_code == 400

    monkeypatch.setattr(settings, "pages_max_bytes", 64)
    big = await app_client.post("/api/v1/pages", json={"html": "<html>" + "a" * 100 + "</html>", "title": "big"}, headers=headers)
    assert big.status_code == 413


@pytest.mark.asyncio
async def test_slug_rules(app_client, local_storage):
    headers, _ = await _key(app_client)
    for bad in ("ab", "Bad Slug", "-lead", "api", "trail-"):
        r = await app_client.post("/api/v1/pages", json={"html": HTML, "title": "t", "slug": bad}, headers=headers)
        assert r.status_code == 400, bad
    first = await _publish(app_client, headers, slug="weekly-plan")
    dup = await app_client.post("/api/v1/pages", json={"html": HTML, "title": "t", "slug": "weekly-plan"}, headers=headers)
    assert dup.status_code == 409
    # PATCH to a taken slug -> 409; to a fresh one -> 200 and /p/ follows
    second = await _publish(app_client, headers, title="Other")
    taken = await app_client.patch(f"/api/v1/pages/{second['page_id']}", json={"slug": "weekly-plan"}, headers=headers)
    assert taken.status_code == 409
    moved = await app_client.patch(f"/api/v1/pages/{first['page_id']}", json={"slug": "weekly-plan-v2"}, headers=headers)
    assert moved.status_code == 200 and moved.json()["url"].endswith("/p/weekly-plan-v2")
    assert (await app_client.get("/p/weekly-plan-v2")).status_code == 200
    assert (await app_client.get("/p/weekly-plan")).status_code == 404


# ---------------------------------------------------------------------------
# List / delete / kill switch
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_get_delete_and_kill_switch(app_client, local_storage):
    headers, _ = await _key(app_client)
    page = await _publish(app_client, headers)
    pid = page["page_id"]

    listed = await app_client.get("/api/v1/pages", headers=headers)
    assert [p["page_id"] for p in listed.json()] == [pid]
    assert (await app_client.get(f"/api/v1/pages/{pid}", headers=headers)).status_code == 200

    off = await app_client.patch(f"/api/v1/pages/{pid}", json={"enabled": False}, headers=headers)
    assert off.status_code == 200 and off.json()["enabled"] is False
    gone = await app_client.get(f"/p/{page['slug']}")
    assert gone.status_code == 410 and "revoked" in gone.text.lower()
    assert (await app_client.get(f"/f/{page['short_code']}")).status_code == 410

    on = await app_client.patch(f"/api/v1/pages/{pid}", json={"enabled": True}, headers=headers)
    assert on.json()["enabled"] is True
    assert (await app_client.get(f"/p/{page['slug']}")).status_code == 200

    assert (await app_client.delete(f"/api/v1/pages/{pid}", headers=headers)).status_code == 204
    assert (await app_client.get(f"/p/{page['slug']}")).status_code == 404
    assert (await app_client.get(f"/f/{page['short_code']}")).status_code == 404
    assert (await app_client.get(f"/api/v1/pages/{pid}", headers=headers)).status_code == 404
    assert list(local_storage.rglob("*.html")) == []


# ---------------------------------------------------------------------------
# Visitor identity, revisit, dwell
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_visitor_revisit_and_dwell(app_client, local_storage):
    from app.db import postgres
    from app.models.utm import ClickEvent
    from sqlalchemy import select, update

    headers, _ = await _key(app_client)
    page = await _publish(app_client, headers)
    pid, slug, code = page["page_id"], page["slug"], page["short_code"]

    first = await app_client.get(f"/p/{slug}", headers={"CF-Connecting-IP": "24.48.0.1"})
    vid = first.cookies.get("cb_vid")
    assert vid
    second = await app_client.get(f"/p/{slug}", cookies={"cb_vid": vid})
    assert second.status_code == 200

    async with postgres.async_session_maker() as s:
        evs = (await s.execute(select(ClickEvent).where(ClickEvent.file_id == pid).order_by(ClickEvent.clicked_at))).scalars().all()
        assert [e.visitor_id for e in evs] == [vid, vid]
        assert [e.is_revisit for e in evs] == [False, False]
        assert evs[0].ip_address == "24.48.0.1"
        # backdate both views past the revisit window
        await s.execute(update(ClickEvent).where(ClickEvent.file_id == pid).values(clicked_at=datetime.utcnow() - timedelta(minutes=31)))
        await s.commit()

    third = await app_client.get(f"/p/{slug}", cookies={"cb_vid": vid})
    assert third.status_code == 200
    app_client.cookies.clear()  # the client keeps a jar; drop it to act as a new visitor
    other = await app_client.get(f"/p/{slug}")
    assert other.cookies.get("cb_vid") not in (None, vid)

    # dwell beacons from two sessions
    for sid, ms in (("s1", 12000), ("s2", 4000)):
        r = await app_client.post(f"/f/{code}/page-events", json={"session_id": sid, "events": [{"page": 0, "dwell_ms": ms}]}, cookies={"cb_vid": vid})
        assert r.status_code == 204
    clamp = await app_client.post(f"/f/{code}/page-events", json={"session_id": "s1", "events": [{"page": 0, "dwell_ms": 999999}]})
    assert clamp.status_code == 204

    a = (await app_client.get(f"/api/v1/pages/{pid}/analytics", headers=headers)).json()
    assert a["views"] == 4 and a["unique_visitors"] == 2 and a["revisits"] == 1
    assert a["sessions"] == 2 and a["total_dwell_ms"] == 12000 + 4000 + 60000
    assert a["median_dwell_ms"] == int((72000 + 4000) / 2)

    listed = (await app_client.get("/api/v1/pages", headers=headers)).json()[0]
    assert listed["unique_visitors"] == 2 and listed["revisits"] == 1 and listed["total_dwell_ms"] == 76000


@pytest.mark.asyncio
async def test_beacon_and_unlock_scoped_by_custom_host_owner_fallback(app_client, local_storage):
    """A page stored with domain_id NULL but reached via the owner's active
    custom domain must accept beacons/unlock (previously 404)."""
    from uuid import uuid4

    from app.db import postgres
    from app.models.domain import Domain, STATUS_ACTIVE

    headers, user = await _key(app_client)
    page = await _publish(app_client, headers)
    async with postgres.async_session_maker() as s:
        s.add(Domain(id=uuid4(), user_id=user.id, hostname="links.example.com", status=STATUS_ACTIVE))
        await s.commit()

    r = await app_client.post(
        f"/f/{page['short_code']}/page-events",
        json={"session_id": "s", "events": [{"page": 0, "dwell_ms": 100}]},
        headers={"host": "links.example.com"},
    )
    assert r.status_code == 204
    r = await app_client.get(f"/p/{page['slug']}", headers={"host": "links.example.com"})
    assert r.status_code == 200
    r = await app_client.get(f"/p/{page['slug']}", headers={"host": "nobody.example.com"})
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Versions
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_versions_rollback_and_prune(app_client, local_storage, monkeypatch):
    headers, _ = await _key(app_client)
    page = await _publish(app_client, headers)
    pid, slug = page["page_id"], page["slug"]

    for n in (2, 3, 4):
        r = await app_client.put(f"/api/v1/pages/{pid}", json={"html": f"<html><head></head><body>v{n}</body></html>"}, headers=headers)
        assert r.status_code == 200 and r.json()["current_version"] == n

    versions = (await app_client.get(f"/api/v1/pages/{pid}/versions", headers=headers)).json()
    assert [v["version_no"] for v in versions] == [4, 3, 2, 1]
    assert [v["current"] for v in versions] == [True, False, False, False]
    assert "v4" in (await app_client.get(f"/p/{slug}")).text

    rb = await app_client.post(f"/api/v1/pages/{pid}/versions/1/rollback", headers=headers)
    assert rb.status_code == 200 and rb.json()["current_version"] == 5
    served = await app_client.get(f"/p/{slug}")
    assert "hello" in served.text and "v4" not in served.text

    monkeypatch.setattr(settings, "pages_versions_keep", 2)
    await app_client.put(f"/api/v1/pages/{pid}", json={"html": "<html><head></head><body>v6</body></html>"}, headers=headers)
    versions = (await app_client.get(f"/api/v1/pages/{pid}/versions", headers=headers)).json()
    assert [v["version_no"] for v in versions] == [6, 5]
    assert len(list(local_storage.rglob("*.html"))) == 2


@pytest.mark.asyncio
async def test_non_html_file_is_not_injected(app_client, local_storage):
    from tests.test_api_keys import _mint_key

    raw, _, _ = await _mint_key()
    h = {"X-API-Key": raw}
    content = "just text"
    init = await app_client.post("/api/v1/files", json={"filename": "a.txt", "content_type": "text/plain", "size_bytes": len(content)}, headers=h)
    d = init.json()
    await app_client.put(d["presigned_put_url"], content=content.encode(), headers={"Content-Type": "text/plain"})
    await app_client.post(f"/api/v1/files/{d['file_id']}/finalize", json={}, headers=h)
    r = await app_client.get(f"/f/{d['short_code']}")
    assert r.status_code == 200 and r.text == content
    assert r.headers["cache-control"] == "private, max-age=300"
    assert "cb_vid=" in r.headers.get("set-cookie", "")
