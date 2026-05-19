"""
End-to-end integration test for UTM generation + click tracking in the
signed-in application.

Covers the full happy path:
  1. Register a user (token returned)
  2. Generate a UTM link as the authenticated user
  3. Verify the tracked link is persisted and a short_code is issued
  4. Hit the /r/{short_code} redirect endpoint twice from different IPs
     and confirm click_count + unique_clicks update correctly
  5. Query the analytics endpoints and verify the recorded data shows up
  6. Public (unauthenticated) UTM generation still works but does NOT
     create a tracked link
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_public_generate_does_not_track(app_client):
    """An unauthenticated /utm/generate call returns a tracked URL but does
    not persist a LinkClick row (link_id is None)."""
    resp = await app_client.post(
        "/api/v1/utm/generate",
        json={
            "base_url": "example.com",
            "utm_source": "google",
            "utm_medium": "cpc",
            "utm_campaign": "spring_sale",
        },
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["original_url"] == "example.com"
    assert "utm_source=google" in data["tracked_url"]
    assert "utm_campaign=spring_sale" in data["tracked_url"]
    assert data["link_id"] is None
    assert data["short_code"] is None


async def _register(client, email: str = "tester@example.com", password: str = "supersecret123"):
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "name": "Test User"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["access_token"]
    return body["access_token"], body["user"]["user_id"]


@pytest.mark.asyncio
async def test_register_login_generate_track_analytics(app_client):
    token, user_id = await _register(app_client)
    auth = {"Authorization": f"Bearer {token}"}

    # ---- generate a tracked link ----
    gen_resp = await app_client.post(
        "/api/v1/utm/generate",
        headers=auth,
        json={
            "base_url": "https://champutm.com/pricing",
            "utm_source": "newsletter",
            "utm_medium": "email",
            "utm_campaign": "may-launch",
            "utm_content": "header-cta",
        },
    )
    assert gen_resp.status_code == 200, gen_resp.text
    data = gen_resp.json()
    short_code = data["short_code"]
    assert short_code and len(short_code) == 7, data
    assert data["link_id"]
    assert "utm_source=newsletter" in data["tracked_url"]

    # ---- simulate two clicks from different IPs ----
    redirect_resp = await app_client.get(
        f"/r/{short_code}",
        headers={
            "X-Forwarded-For": "203.0.113.10",
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": "https://news.example.com/",
        },
        follow_redirects=False,
    )
    assert redirect_resp.status_code == 302
    assert "utm_source=newsletter" in redirect_resp.headers["location"]

    # second click from the *same* IP — should not bump unique_clicks
    repeat_resp = await app_client.get(
        f"/r/{short_code}",
        headers={"X-Forwarded-For": "203.0.113.10", "User-Agent": "curl/8"},
        follow_redirects=False,
    )
    assert repeat_resp.status_code == 302

    # third click from a *different* IP — should bump unique_clicks
    other_resp = await app_client.get(
        f"/r/{short_code}",
        headers={
            "X-Forwarded-For": "198.51.100.42",
            "User-Agent": (
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
                "Mobile/15E148 Safari/604.1"
            ),
        },
        follow_redirects=False,
    )
    assert other_resp.status_code == 302

    # ---- analytics: overview ----
    overview = await app_client.get("/api/v1/utm/analytics/overview", headers=auth)
    assert overview.status_code == 200, overview.text
    ov = overview.json()
    assert ov["total_tracked_links"] == 1
    assert ov["total_clicks"] == 3
    assert ov["unique_clicks"] == 2
    # top_sources should contain newsletter
    sources = {s["source"]: s["clicks"] for s in ov["top_sources"]}
    assert sources.get("newsletter") == 3
    campaigns = {c["campaign"]: c["clicks"] for c in ov["top_campaigns"]}
    assert campaigns.get("may-launch") == 3

    # ---- analytics: breakdown by source ----
    breakdown = await app_client.get(
        "/api/v1/utm/analytics/breakdown?group_by=source", headers=auth
    )
    assert breakdown.status_code == 200, breakdown.text
    items = breakdown.json()
    assert len(items) == 1
    assert items[0]["group_value"] == "newsletter"
    assert items[0]["total_clicks"] == 3
    assert items[0]["unique_clicks"] == 2

    # ---- link performance ----
    perf = await app_client.get("/api/v1/utm/analytics/links", headers=auth)
    assert perf.status_code == 200, perf.text
    perf_data = perf.json()
    assert len(perf_data) == 1
    link = perf_data[0]
    assert link["click_count"] == 3
    assert link["unique_clicks"] == 2
    assert link["utm_campaign"] == "may-launch"
    assert link["short_code"] == short_code


@pytest.mark.asyncio
async def test_generate_dedupes_identical_link(app_client):
    """Generating the same UTM combo twice returns the same LinkClick row."""
    token, _ = await _register(app_client, email="dedupe@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    payload = {
        "base_url": "https://example.com/product",
        "utm_source": "twitter",
        "utm_medium": "social",
        "utm_campaign": "launch",
    }

    first = await app_client.post("/api/v1/utm/generate", headers=auth, json=payload)
    second = await app_client.post("/api/v1/utm/generate", headers=auth, json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["link_id"] == second.json()["link_id"]
    assert first.json()["short_code"] == second.json()["short_code"]


@pytest.mark.asyncio
async def test_unknown_short_code_redirects_home(app_client):
    """A redirect for an unknown short_code falls back to '/'."""
    resp = await app_client.get("/r/doesnotexist", follow_redirects=False)
    assert resp.status_code == 302
    assert resp.headers["location"] == "/"


@pytest.mark.asyncio
async def test_preset_apply_to_generate(app_client):
    """A preset's UTM values are merged into generated links."""
    token, _ = await _register(app_client, email="preset@example.com")
    auth = {"Authorization": f"Bearer {token}"}

    create = await app_client.post(
        "/api/v1/utm/presets",
        headers=auth,
        json={
            "name": "Email default",
            "utm_source": "newsletter",
            "utm_medium": "email",
            "utm_campaign": "weekly",
        },
    )
    assert create.status_code == 201, create.text
    preset_id = create.json()["id"]

    gen = await app_client.post(
        "/api/v1/utm/generate",
        headers=auth,
        json={
            "base_url": "https://champutm.com",
            "preset_id": preset_id,
            # override one of the preset values to confirm precedence
            "utm_campaign": "may-special",
        },
    )
    assert gen.status_code == 200, gen.text
    body = gen.json()
    assert "utm_source=newsletter" in body["tracked_url"]
    assert "utm_medium=email" in body["tracked_url"]
    assert "utm_campaign=may-special" in body["tracked_url"]
    assert "utm_campaign=weekly" not in body["tracked_url"]
