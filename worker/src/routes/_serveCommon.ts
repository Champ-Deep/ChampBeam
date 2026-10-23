/**
 * Small Starlette-compatible response helpers shared by the public serve
 * routers (redirect.ts, filesServe.ts).
 *
 * Exports:
 *   starletteCookie(name, value, { maxAge, httpOnly?, sameSite?, secure?, path? }): string
 *        (Set-Cookie value in Starlette/SimpleCookie attribute order)
 *   isHttps(c): boolean                    (files.py `_is_https`)
 *   redirectResponse(url, status): Response (RedirectResponse: Location quoted like Starlette)
 *   formField(c, name): Promise<string>     (`Form(default="")`)
 */
import type { Context } from "hono";

/**
 * Starlette `Response.set_cookie` output. SimpleCookie renders attributes in
 * sorted key order: HttpOnly, Max-Age, Path, SameSite, Secure.
 */
export function starletteCookie(
  name: string,
  value: string,
  opts: { maxAge: number; httpOnly?: boolean; sameSite?: string; secure?: boolean; path?: string },
): string {
  const parts = [`${name}=${value}`];
  if (opts.httpOnly) parts.push("HttpOnly");
  parts.push(`Max-Age=${opts.maxAge}`);
  parts.push(`Path=${opts.path ?? "/"}`);
  parts.push(`SameSite=${opts.sameSite ?? "lax"}`);
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/** files.py `_is_https`: X-Forwarded-Proto first, else the request URL scheme. */
export function isHttps(c: Context): boolean {
  const proto = (c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "") || "").toLowerCase();
  return proto.split(",")[0].trim() === "https";
}

const SAFE = new Set(
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~" + ":/%#?=@[]!$&'()*+,;",
);

/** urllib.parse.quote(url, safe=":/%#?=@[]!$&'()*+,;") — what RedirectResponse does to the URL. */
function quoteUrl(url: string): string {
  let out = "";
  for (const ch of url) {
    if (SAFE.has(ch)) {
      out += ch;
      continue;
    }
    for (const b of new TextEncoder().encode(ch)) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Starlette RedirectResponse(url, status_code): empty body, quoted Location. */
export function redirectResponse(url: string, status: number): Response {
  return new Response(null, { status, headers: { location: quoteUrl(url) } });
}

/** A single urlencoded/multipart form field, "" when absent or the body isn't a form. */
export async function formField(c: Context, name: string): Promise<string> {
  try {
    const body = await c.req.parseBody();
    const v = body[name];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}
