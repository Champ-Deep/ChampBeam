"""QR code generation.

Renders a QR SVG for any short URL the client provides. The QR encodes the
permanent short link, so a scan resolves through /r or /f and is tracked
(device, geo, open count) exactly like a click or open. There is no separate
QR tracking system, and the code stays valid as long as the short link does,
which keeps QR creation stable and the tracking consistent over time.
"""

from __future__ import annotations

import io

import qrcode
import qrcode.image.svg
from fastapi import APIRouter, Query
from fastapi.responses import Response

router = APIRouter(tags=["QR"])

_MAX_LEN = 1024


@router.get("/qr.svg")
def qr_svg(
    data: str = Query(..., min_length=1, max_length=_MAX_LEN, description="Text or URL to encode"),
):
    """Return a QR code SVG encoding `data` (typically a short link or file URL).

    Public and hotlinkable so the QR can be embedded directly in emails, PDFs,
    decks, or print via an <img> tag.
    """
    qr = qrcode.QRCode(
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(image_factory=qrcode.image.svg.SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    return Response(
        content=buf.getvalue(),
        media_type="image/svg+xml",
        headers={"Cache-Control": "public, max-age=86400"},
    )
