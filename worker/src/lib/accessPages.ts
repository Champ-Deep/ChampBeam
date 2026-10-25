/**
 * Branded HTML pages served on the redirect/file hot path when a self-destruct
 * control blocks or gates a view (expired, revoked, view-cap hit, VPN blocked,
 * the email gate, the access-code gate). Port of backend/app/api/access_pages.py.
 * Dependency-free and inline-styled so they render even when the SPA is down.
 *
 * Each function returns a ready `Response` (text/html) — `return blockedPage(...)`
 * straight from a Hono handler.
 *
 * Exports:
 *   blockedPage(reason: "expired"|"revoked"|"maxed"|"vpn"|"gone"|string, opts?: { brand?: string | null }): Response   (410)
 *   emailGatePage({ action: string, brand?: string | null, error?: boolean }): Response                                  (200)
 *   codeGatePage({ action: string, brand?: string | null, error?: "wrong" | "too_many" | null }): Response              (200, or 429 for too_many)
 *   escapeHtml(s: string): string                                                                                        (html.escape, quote=True)
 */

const BLOCK_COPY: Record<string, [string, string]> = {
  expired: ["Link expired", "This link is no longer available — it passed its expiry date."],
  revoked: ["Link revoked", "The sender has turned off access to this link."],
  maxed: ["View limit reached", "This link self-destructed after reaching its view limit."],
  vpn: ["Access blocked", "Opens from VPNs or anonymizing proxies aren’t allowed for this link."],
  gone: ["Link unavailable", "This link is no longer available."],
};

/** Python html.escape(s, quote=True). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function shell(title: string, body: string, status: number, brand: string | null | undefined): Response {
  const brandHtml = brand ? `<div class="brand">${escapeHtml(brand)}</div>` : '<div class="brand">Champbeam</div>';
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; background:#0f172a; color:#e2e8f0; }
  .card { max-width:420px; padding:40px 32px; text-align:center; background:#111c33;
    border:1px solid #1e293b; border-radius:16px; }
  .brand { font-weight:700; color:#34d399; margin-bottom:20px; letter-spacing:-.01em; }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:#94a3b8; font-size:14px; line-height:1.5; margin:0 0 20px; }
  form { display:flex; gap:8px; }
  input { flex:1; padding:10px 12px; border-radius:10px; border:1px solid #334155;
    background:#0b1425; color:#e2e8f0; font-size:14px; }
  button { padding:10px 16px; border:0; border-radius:10px; background:#34d399; color:#04120b;
    font-weight:600; font-size:14px; cursor:pointer; }
</style></head><body><div class="card">${brandHtml}${body}</div></body></html>`;
  return new Response(page, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

export function blockedPage(reason: string, { brand = null }: { brand?: string | null } = {}): Response {
  const [title, msg] = BLOCK_COPY[reason] ?? BLOCK_COPY.gone;
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(msg)}</p>`, 410, brand);
}

/** The 'enter your email to view' gate. `action` is the POST unlock URL. */
export function emailGatePage({
  action,
  brand = null,
  error = false,
}: {
  action: string;
  brand?: string | null;
  error?: boolean;
}): Response {
  const err = error ? '<p style="color:#f87171">Please enter a valid email.</p>' : "";
  const body =
    "<h1>Enter your email to view</h1>" +
    "<p>The sender asked for your email before granting access.</p>" +
    err +
    `<form method="post" action="${escapeHtml(action)}">` +
    '<input type="email" name="email" placeholder="you@company.com" required autofocus>' +
    '<button type="submit">View</button></form>';
  return shell("Enter your email to view", body, 200, brand);
}

/**
 * The 'enter the access code' gate for Beam Pages. `error` is null, "wrong"
 * (re-render with a message) or "too_many" (429, no form).
 */
export function codeGatePage({
  action,
  brand = null,
  error = null,
}: {
  action: string;
  brand?: string | null;
  error?: string | null;
}): Response {
  if (error === "too_many") {
    const body = "<h1>Too many attempts</h1><p>Please wait a few minutes before trying the access code again.</p>";
    return shell("Too many attempts", body, 429, brand);
  }
  const err = error === "wrong" ? '<p style="color:#f87171">That code isn’t right.</p>' : "";
  const body =
    "<h1>Enter the access code</h1>" +
    "<p>The sender protected this page with a code.</p>" +
    err +
    `<form method="post" action="${escapeHtml(action)}">` +
    '<input type="text" name="code" inputmode="numeric" pattern="[0-9]{4,8}" ' +
    'autocomplete="one-time-code" placeholder="Access code" required autofocus>' +
    '<button type="submit">View</button></form>';
  return shell("Enter the access code", body, 200, brand);
}
