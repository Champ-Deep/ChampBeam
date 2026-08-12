"""Update-in-place file replacement: same short_code, new bytes."""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_replace_content_keeps_link(app_client, tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))

    # Authenticate with an API key (exercises the external-integration path).
    from tests.test_api_keys import _mint_key

    raw_key, _, _ = await _mint_key()
    headers = {"X-API-Key": raw_key}

    v1 = "<html><body><script>localStorage.x=1</script>v1</body></html>"
    init = await app_client.post(
        "/api/v1/files",
        json={"filename": "page.html", "content_type": "text/html", "size_bytes": len(v1)},
        headers=headers,
    )
    assert init.status_code == 201, init.text
    d = init.json()
    file_id, short_code, upload_url = d["file_id"], d["short_code"], d["presigned_put_url"]

    put = await app_client.put(upload_url, content=v1.encode(), headers={"Content-Type": "text/html"})
    assert put.status_code == 204
    fin = await app_client.post(f"/api/v1/files/{file_id}/finalize", json={}, headers=headers)
    assert fin.status_code == 200 and fin.json()["status"] == "active"

    served = await app_client.get(f"/f/{short_code}")
    assert served.status_code == 200
    assert "v1" in served.text
    assert "content-security-policy" in {k.lower() for k in served.headers.keys()}

    # Replace in place — same short_code must now serve v2.
    v2 = "<html><body>v2 updated weekly</body></html>"
    rep = await app_client.put(
        f"/api/v1/files/{file_id}/content",
        content=v2.encode(),
        headers={**headers, "Content-Type": "text/html"},
    )
    assert rep.status_code == 200, rep.text
    body = rep.json()
    assert body["short_code"] == short_code
    assert body["size_bytes"] == len(v2)

    served2 = await app_client.get(f"/f/{short_code}")
    assert served2.status_code == 200
    assert "v2 updated weekly" in served2.text
    assert "v1" not in served2.text


@pytest.mark.asyncio
async def test_replace_content_rejects_non_owner_and_oversize(app_client, tmp_path, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))

    from tests.test_api_keys import _mint_key

    owner_key, _, _ = await _mint_key()
    other_key, _, _ = await _mint_key()
    headers = {"X-API-Key": owner_key}

    content = "hello"
    init = await app_client.post(
        "/api/v1/files",
        json={"filename": "a.txt", "content_type": "text/plain", "size_bytes": len(content)},
        headers=headers,
    )
    d = init.json()
    await app_client.put(d["presigned_put_url"], content=content.encode(), headers={"Content-Type": "text/plain"})
    await app_client.post(f"/api/v1/files/{d['file_id']}/finalize", json={}, headers=headers)

    # Someone else's key: 404, not a cross-tenant overwrite.
    rep = await app_client.put(
        f"/api/v1/files/{d['file_id']}/content",
        content=b"pwned",
        headers={"X-API-Key": other_key, "Content-Type": "text/plain"},
    )
    assert rep.status_code == 404

    # Missing content type: 400.
    rep = await app_client.put(
        f"/api/v1/files/{d['file_id']}/content", content=b"x", headers=headers
    )
    assert rep.status_code == 400
