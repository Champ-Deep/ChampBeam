/**
 * QR code generation. Port of backend/app/api/v1/qr.py — mounted at /api/v1
 * (/api/v1/qr.svg).
 *
 * Renders a QR SVG for any short URL the client provides. The QR encodes the
 * permanent short link, so a scan resolves through /r or /f and is tracked
 * (device, geo, open count) exactly like a click or open. There is no separate
 * QR tracking system, and the code stays valid as long as the short link does.
 *
 * The SVG mirrors python-qrcode's SvgPathImage (error correction M,
 * box_size=10 -> 1mm modules, border=2): one <path id="qr-path"> made of a
 * unit square per dark module.
 */
import { Hono } from "hono";
import QRCode from "qrcode";
import { z } from "zod";
import type { AppEnv } from "../env";
import { parseQuery } from "../lib/validate";

export const router = new Hono<AppEnv>({ strict: false });

const MAX_LEN = 1024;
const BORDER = 2;

/** python-qrcode SvgPathImage output for `data`. */
export function qrSvg(data: string): string {
  const { modules } = QRCode.create(data, { errorCorrectionLevel: "M" });
  const n = modules.size;
  const dim = n + BORDER * 2;
  const parts: string[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (!modules.get(row, col)) continue;
      const x = col + BORDER;
      const y = row + BORDER;
      parts.push(`M${x},${y}H${x + 1}V${y + 1}H${x}z`);
    }
  }
  return (
    "<?xml version='1.0' encoding='UTF-8'?>\n" +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}mm" height="${dim}mm" version="1.1" viewBox="0 0 ${dim} ${dim}">` +
    `<path d="${parts.join("")}" id="qr-path" fill="#000000" fill-opacity="1" fill-rule="nonzero" stroke="none"/>` +
    "</svg>"
  );
}

/**
 * Return a QR code SVG encoding `data` (typically a short link or file URL).
 * Public and hotlinkable so the QR can be embedded directly in emails, PDFs,
 * decks, or print via an <img> tag.
 */
router.get("/qr.svg", (c) => {
  const { data } = parseQuery(c, z.object({ data: z.string().min(1).max(MAX_LEN) }));
  return new Response(qrSvg(data), {
    status: 200,
    headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" },
  });
});
