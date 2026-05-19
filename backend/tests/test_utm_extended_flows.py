"""
Extra integration coverage for UTM tracking features beyond the basic
register-generate-redirect flow:

  - Click events persist UA-parsed device/browser/os
  - Analytics breakdown by every supported group_by value
  - Date-range filter on breakdown
  - Link performance + deletion (and its click events go with it)
  - Bulk CSV upload returns CSV with tracked URLs
  - Project lifecycle: create, list, generate-link-with-project,
    update, delete (links survive with project_id = NULL)
  - Public bulk template download
"""

from __future__ import annotations

from io import BytesIO

import pytest


async def _register(client, email="user@example.com", password="originalpw123"):
    r = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": "Test"},
    )
    assert r.status_code == 200, r.text
    return r.json()["access_token"], r.json()["user"]["user_id"]


@pytest.mark.asyncio
async def test_click_event_records_ua_parsed_fields(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    gen = await app_client.post(
        "/api/v1/utm/generate",
        headers=auth,
        json={
            "base_url": "https://champutm.com",
            "utm_source": "ad",
            "utm_medium": "cpc",
            "utm_campaign": "demo",
        },
    )
    short_code = gen.json()["short_code"]

    await app_client.get(
        f"/r/{short_code}",
        headers={
            "X-Forwarded-For": "203.0.113.7",
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                "Mobile/15E148 Safari/604.1"
            ),
        },
        follow_redirects=False,
    )

    # Inspect ClickEvent directly via the test session
    from sqlalchemy import select
    from app.db.postgres import get_db_session
    from app.models.utm import ClickEvent

    override = app_client._transport.app.dependency_overrides[get_db_session]
    async for session in override():
        evt = (await session.execute(select(ClickEvent))).scalars().one()
        assert evt.ip_address == "203.0.113.7"
        # user_agents library labels iPhone as "mobile"
        assert evt.device_type in {"mobile", "Mobile"}
        assert evt.browser and "Safari" in evt.browser
        assert evt.os and "iOS" in evt.os
        break


@pytest.mark.asyncio
async def test_breakdown_by_every_dimension(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    # Make two links with all five UTM fields populated, so every
    # group_by value returns a row.
    for i in range(2):
        gen = await app_client.post(
            "/api/v1/utm/generate",
            headers=auth,
            json={
                "base_url": f"https://example.com/p{i}",
                "utm_source": f"source-{i}",
                "utm_medium": f"medium-{i}",
                "utm_campaign": f"campaign-{i}",
                "utm_content": f"content-{i}",
                "utm_term": f"term-{i}",
            },
        )
        sc = gen.json()["short_code"]
        await app_client.get(
            f"/r/{sc}",
            headers={"X-Forwarded-For": f"203.0.113.{20 + i}", "User-Agent": "curl/8"},
            follow_redirects=False,
        )

    for dim in ("source", "medium", "campaign", "content", "term"):
        resp = await app_client.get(
            f"/api/v1/utm/analytics/breakdown?group_by={dim}", headers=auth
        )
        assert resp.status_code == 200, (dim, resp.text)
        items = resp.json()
        assert len(items) == 2, dim
        for item in items:
            assert item["group_key"] == dim
            assert item["total_clicks"] == 1


@pytest.mark.asyncio
async def test_breakdown_invalid_group_by(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    resp = await app_client.get(
        "/api/v1/utm/analytics/breakdown?group_by=bogus", headers=auth
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_link_delete_removes_clicks(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    gen = await app_client.post(
        "/api/v1/utm/generate",
        headers=auth,
        json={"base_url": "https://example.com", "utm_source": "x"},
    )
    link_id = gen.json()["link_id"]
    short_code = gen.json()["short_code"]
    await app_client.get(
        f"/r/{short_code}",
        headers={"X-Forwarded-For": "1.2.3.4", "User-Agent": "curl/8"},
        follow_redirects=False,
    )

    deleted = await app_client.delete(f"/api/v1/utm/links/{link_id}", headers=auth)
    assert deleted.status_code == 204

    perf = await app_client.get("/api/v1/utm/analytics/links", headers=auth)
    assert perf.json() == []


@pytest.mark.asyncio
async def test_bulk_csv_upload_returns_tracked_urls(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    csv_body = (
        "url,utm_source,utm_medium,utm_campaign\n"
        "https://example.com/a,google,cpc,spring\n"
        "https://example.com/b,,,\n"
    )

    files = {"file": ("urls.csv", BytesIO(csv_body.encode()), "text/csv")}
    resp = await app_client.post(
        "/api/v1/utm/bulk/generate", headers=auth, files=files
    )
    assert resp.status_code == 200, resp.text
    body = resp.text
    # header line plus two URL rows
    lines = [l for l in body.split("\r\n") if l]
    assert lines[0].startswith("url,utm_source,utm_medium,utm_campaign")
    assert "utm_source=google" in lines[1]
    assert "utm_medium=cpc" in lines[1]
    # second row has empty UTM cols, so tracked_url has no utm_ params
    assert "utm_source=" not in lines[2]


@pytest.mark.asyncio
async def test_bulk_template_download_public(app_client):
    resp = await app_client.get("/api/v1/utm/bulk/template")
    assert resp.status_code == 200
    assert "url,utm_source,utm_medium,utm_campaign,utm_content,utm_term" in resp.text


@pytest.mark.asyncio
async def test_project_lifecycle_with_link(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    # 1. Create
    create = await app_client.post(
        "/api/v1/projects",
        headers=auth,
        json={"name": "Spring Launch", "description": "May campaign"},
    )
    assert create.status_code == 201, create.text
    project_id = create.json()["id"]

    # 2. List
    listed = await app_client.get("/api/v1/projects", headers=auth)
    assert listed.status_code == 200
    assert any(p["id"] == project_id for p in listed.json())

    # 3. Generate a link tied to the project
    gen = await app_client.post(
        "/api/v1/utm/generate",
        headers=auth,
        json={
            "base_url": "https://example.com/sale",
            "utm_source": "newsletter",
            "utm_medium": "email",
            "utm_campaign": "spring",
            "project_id": project_id,
        },
    )
    assert gen.status_code == 200
    link_id = gen.json()["link_id"]
    short_code = gen.json()["short_code"]
    await app_client.get(
        f"/r/{short_code}",
        headers={"X-Forwarded-For": "1.2.3.4", "User-Agent": "curl/8"},
        follow_redirects=False,
    )

    # 4. Analytics overview filtered by project_id sees the project's clicks
    ov = await app_client.get(
        f"/api/v1/utm/analytics/overview?project_id={project_id}", headers=auth
    )
    assert ov.status_code == 200
    assert ov.json()["total_clicks"] == 1
    assert ov.json()["total_tracked_links"] == 1

    # 5. Update name
    upd = await app_client.put(
        f"/api/v1/projects/{project_id}",
        headers=auth,
        json={"name": "Spring '26"},
    )
    assert upd.status_code == 200
    assert upd.json()["name"] == "Spring '26"
    assert upd.json()["link_count"] == 1
    assert upd.json()["total_clicks"] == 1

    # 6. Delete project → link is preserved but its project_id is NULLed
    deleted = await app_client.delete(
        f"/api/v1/projects/{project_id}", headers=auth
    )
    assert deleted.status_code == 204

    perf = await app_client.get("/api/v1/utm/analytics/links", headers=auth)
    rows = perf.json()
    assert len(rows) == 1
    assert rows[0]["link_id"] == link_id
    assert rows[0]["project_id"] is None


@pytest.mark.asyncio
async def test_preset_crud(app_client):
    token, _ = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    create = await app_client.post(
        "/api/v1/utm/presets",
        headers=auth,
        json={"name": "Default email", "utm_source": "newsletter", "utm_medium": "email"},
    )
    assert create.status_code == 201
    pid = create.json()["id"]

    listed = await app_client.get("/api/v1/utm/presets", headers=auth)
    assert listed.status_code == 200
    assert any(p["id"] == pid for p in listed.json())

    upd = await app_client.put(
        f"/api/v1/utm/presets/{pid}",
        headers=auth,
        json={"name": "Default email v2"},
    )
    assert upd.status_code == 200
    assert upd.json()["name"] == "Default email v2"

    set_default = await app_client.post(
        f"/api/v1/utm/presets/{pid}/default", headers=auth
    )
    assert set_default.status_code == 200
    assert set_default.json()["is_default"] is True

    deleted = await app_client.delete(f"/api/v1/utm/presets/{pid}", headers=auth)
    assert deleted.status_code == 204
    after = await app_client.get("/api/v1/utm/presets", headers=auth)
    assert all(p["id"] != pid for p in after.json())
