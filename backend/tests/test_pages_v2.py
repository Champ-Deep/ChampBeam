"""Pages V2: batch publish with cross-link rewriting, link inventory, and the
reroute-without-editing-HTML apply flow.
"""

from __future__ import annotations

import pytest

from tests.test_api_keys import _mint_key

MISSION = b"""<!doctype html><html><head><title>Event Scout Mission Control</title></head>
<body>
<a href="Event Scout 2026 - Harshil Plan.html" class="btn">Harshil's plan</a>
<a href="Event Scout 2026 - Harsha Plan.html">Harsha's plan</a>
<a href="https://example.com">external</a>
<a href="missing.html">broken</a>
</body></html>"""

HARSHIL = b"""<!doctype html><html><head><title>Harshil Plan</title></head>
<body><a href="index.html">Back</a></body></html>"""


async def _headers(app_client):
    raw, _, _ = await _mint_key()
    return {"X-API-Key": raw}


@pytest.fixture()
def local_storage(tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    return tmp_path


# ---------------------------------------------------------------------------
# Batch publish
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_batch_publish_rewrites_cross_links(app_client, local_storage):
    headers = await _headers(app_client)
    r = await app_client.post(
        "/api/v1/pages/batch",
        headers=headers,
        files=[
            ("files", ("Mission Control.html", MISSION, "text/html")),
            ("files", ("Event Scout 2026 - Harshil Plan.html", HARSHIL, "text/html")),
        ],
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert len(data) == 2
    by_slug = {d["slug"]: d for d in data}
    assert "harshil-plan" in by_slug

    mission = by_slug["event-scout-mission-control"]
    rewrote = {x["from_href"]: x["to"] for x in mission["rewritten"]}
    assert "Event Scout 2026 - Harshil Plan.html" in rewrote
    assert rewrote["Event Scout 2026 - Harshil Plan.html"] == "/p/harshil-plan"
    assert all(k == "mapped" for x in mission["rewritten"] for k in [x["kind"]])
    # The truly-broken link stays flagged, with the byte left alone.
    unresolved = [x["from_href"] for x in mission["unresolved"]]
    assert "missing.html" in unresolved
    assert "https://example.com" not in unresolved

    # Served bytes contain the new links.
    served = await app_client.get(mission["url"].replace("https://test", ""))
    assert served.status_code == 200
    assert "/p/harshil-plan" in served.text
    assert "https://example.com" in served.text  # external untouched


@pytest.mark.asyncio
async def test_batch_publish_single_file_without_links(app_client, local_storage):
    headers = await _headers(app_client)
    r = await app_client.post(
        "/api/v1/pages/batch",
        headers=headers,
        files=[("files", ("Standalone.html", b"<html><title>Standalone</title><p>hi</p></html>", "text/html"))],
    )
    assert r.status_code == 201, r.text
    assert r.json()[0]["rewritten"] == []


# ---------------------------------------------------------------------------
# Link inventory + apply
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_link_inventory_endpoint(app_client, local_storage):
    headers = await _headers(app_client)
    r = await app_client.post(
        "/api/v1/pages", headers=headers,
        json={"html": '<a href="https://x.com">a</a><a href="sibling.html">b</a>', "title": "Inv Test"},
    )
    assert r.status_code == 201, r.text
    page_id = r.json()["page_id"]

    r = await app_client.get(f"/api/v1/pages/{page_id}/links", headers=headers)
    assert r.status_code == 200, r.text
    links = r.json()["links"]
    assert links[0]["kind"] == "external"
    assert links[1]["kind"] == "internal"
    assert links[1]["href"] == "sibling.html"
    assert r.json()["routes"] == []


@pytest.mark.asyncio
async def test_apply_reroutes_to_existing_page(app_client, local_storage):
    headers = await _headers(app_client)
    # Two pages exist; the first references the second by its /f/ code.
    page_b = await app_client.post(
        "/api/v1/pages", headers=headers,
        json={"html": "<html><title>Harshil Plan</title><p>tasks</p></html>", "title": "Harshil Plan"},
    )
    page_b = page_b.json()
    html = f'<html><title>Mission</title><a href="/f/{page_b["short_code"]}">Harshil\'s plan</a></html>'
    page_a = await app_client.post(
        "/api/v1/pages", headers=headers,
        json={"html": html, "title": "Mission Control"},
    )
    page_a = page_a.json()

    r = await app_client.post(f"/api/v1/pages/{page_a['page_id']}/links/apply", headers=headers, json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["unresolved"] == []
    assert body["rewritten"][0]["to"] == f"/p/{page_b['slug']}"
    assert body["page"]["current_version"] == 2

    # The new version is what gets served.
    served = await app_client.get(f"/p/{page_a['slug']}")
    assert served.status_code == 200
    assert f"/p/{page_b['slug']}" in served.text


@pytest.mark.asyncio
async def test_apply_route_override_wins(app_client, local_storage):
    headers = await _headers(app_client)
    page = await app_client.post(
        "/api/v1/pages", headers=headers,
        json={"html": '<a href="https://example.com">go</a>', "title": "Routes"},
    )
    page = page.json()

    r = await app_client.post(
        f"/api/v1/pages/{page['page_id']}/links/apply",
        headers=headers,
        json={"routes": [{"src_href": "https://example.com", "target_url": "/p/somewhere"}]},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["rewritten"][0]["kind"] == "routed"

    served = await app_client.get(f"/p/{page['slug']}")
    assert served.status_code == 200
    assert "/p/somewhere" in served.text

    # Route rows persist and the inventory shows them.
    inv = await app_client.get(f"/api/v1/pages/{page['page_id']}/links", headers=headers)
    assert inv.status_code == 200
    assert inv.json()["routes"] == [{"src_href": "https://example.com", "target_url": "/p/somewhere"}]


@pytest.mark.asyncio
async def test_apply_with_no_matches_creates_no_change_version(app_client, local_storage):
    headers = await _headers(app_client)
    page = await app_client.post(
        "/api/v1/pages", headers=headers,
        json={"html": "<html><title>Clean</title><p>no links</p></html>", "title": "Clean Page"},
    )
    page = page.json()
    r = await app_client.post(f"/api/v1/pages/{page['page_id']}/links/apply", headers=headers, json={})
    assert r.status_code == 200, r.text
    assert r.json()["page"]["current_version"] == 1


@pytest.mark.asyncio
async def test_apply_requires_ownership(app_client, local_storage):
    headers = await _headers(app_client)
    page = await app_client.post(
        "/api/v1/pages", headers=headers,
        json={"html": "<html><title>Mine</title></html>", "title": "Mine"},
    )
    page = page.json()
    other_headers = await _headers(app_client)
    r = await app_client.post(
        f"/api/v1/pages/{page['page_id']}/links/apply", headers=other_headers, json={}
    )
    assert r.status_code == 404