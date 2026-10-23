"""Served disposition: sent files download as the full original, hosted kinds render."""

from __future__ import annotations

import pytest


async def _upload(app_client, headers, filename, content_type, data: bytes) -> str:
    init = await app_client.post(
        "/api/v1/files",
        json={"filename": filename, "content_type": content_type, "size_bytes": len(data)},
        headers=headers,
    )
    assert init.status_code == 201, init.text
    d = init.json()
    put = await app_client.put(d["presigned_put_url"], content=data, headers={"Content-Type": content_type})
    assert put.status_code == 204
    fin = await app_client.post(f"/api/v1/files/{d['file_id']}/finalize", json={}, headers=headers)
    assert fin.status_code == 200, fin.text
    return d["short_code"]


@pytest.mark.asyncio
async def test_disposition_defaults_and_dl_override(app_client, tmp_path, monkeypatch):
    from app.core.config import settings
    from tests.test_api_keys import _mint_key

    monkeypatch.setattr(settings, "storage_backend", "local")
    monkeypatch.setattr(settings, "storage_local_path", str(tmp_path))
    key, _, _ = await _mint_key()
    headers = {"X-API-Key": key}

    cases = {  # filename, mime -> default disposition
        ("pic.png", "image/png"): "attachment",
        ("bundle.zip", "application/zip"): "attachment",
        ("doc.pdf", "application/pdf"): "inline",
        ("clip.mp4", "video/mp4"): "inline",
        ("page.html", "text/html"): "inline",
    }
    for (name, mime), default in cases.items():
        code = await _upload(app_client, headers, name, mime, b"<html></html>" if mime == "text/html" else b"x" * 64)
        cd = lambda r: r.headers["content-disposition"].split(";")[0]  # noqa: E731
        r = await app_client.get(f"/f/{code}")
        assert r.status_code == 200 and cd(r) == default, (name, r.headers["content-disposition"])
        assert cd(await app_client.get(f"/f/{code}?dl=1")) == "attachment", name
        assert cd(await app_client.get(f"/f/{code}?dl=0")) == "inline", name
        assert name in (await app_client.get(f"/f/{code}?dl=1")).headers["content-disposition"]
