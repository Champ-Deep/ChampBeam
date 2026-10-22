/** /api/v1/qr.svg (no Python test file exists; covers the router contract). */
import { describe, expect, it } from "vitest";
import QRCode from "qrcode";
import { api } from "./helpers";
import { qrSvg } from "../src/routes/qr";

describe("qr.svg", () => {
  it("renders a public, cacheable SVG", async () => {
    const r = await api("/api/v1/qr.svg?data=" + encodeURIComponent("https://share.example.com/r/abc1234"));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(r.headers.get("cache-control")).toBe("public, max-age=86400");
    const svg = await r.text();
    expect(svg.startsWith("<?xml version='1.0' encoding='UTF-8'?>\n<svg")).toBe(true);
    expect(svg).toContain('id="qr-path"');
    // box_size 10 -> 1mm modules, border 2 on each side.
    const size = QRCode.create("https://share.example.com/r/abc1234", { errorCorrectionLevel: "M" }).modules.size;
    expect(svg).toContain(`width="${size + 4}mm" height="${size + 4}mm"`);
    expect(svg).toContain(`viewBox="0 0 ${size + 4} ${size + 4}"`);
  });

  it("draws one unit square per dark module, offset by the border", () => {
    const svg = qrSvg("x");
    const { modules } = QRCode.create("x", { errorCorrectionLevel: "M" });
    let dark = 0;
    for (let i = 0; i < modules.size * modules.size; i++) if (modules.data[i]) dark++;
    expect(svg.match(/M\d+,\d+H\d+V\d+H\d+z/g)!.length).toBe(dark);
    expect(svg).toContain("M2,2H3V3H2z"); // finder pattern corner
  });

  it("validates data", async () => {
    expect((await api("/api/v1/qr.svg")).status).toBe(422);
    expect((await api("/api/v1/qr.svg?data=")).status).toBe(422);
    expect((await api("/api/v1/qr.svg?data=" + "a".repeat(1025))).status).toBe(422);
  });
});
