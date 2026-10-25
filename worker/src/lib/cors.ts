/**
 * CORS, ported from the CORSMiddleware setup in backend/app/main.py.
 *
 * When the SPA is served by this same Worker (the default Cloudflare setup),
 * API calls are same-origin and CORS never comes into play; this keeps the
 * old cross-origin behaviour for Vercel previews, local dev and other hosts.
 * Headers are applied AFTER the handler and also to error responses, so a 500
 * never masquerades as a CORS failure in the browser.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Settings } from "../env";

const DEFAULT_ORIGIN_REGEX =
  "^https://(champbeam(-[a-z0-9-]+)?|champ-utm(-[a-z0-9-]+)?|[a-z0-9-]+-deep-5245s-projects)\\.vercel\\.app$";

const ALLOW_METHODS = "GET, POST, PUT, DELETE, PATCH, OPTIONS";
const ALLOW_HEADERS = "Authorization, Content-Type, X-Requested-With, Accept, X-Beam-Token";

const cache = new WeakMap<Settings, { origins: Set<string>; re: RegExp | null }>();

function config(settings: Settings) {
  let cfg = cache.get(settings);
  if (!cfg) {
    const origins = new Set(
      [
        "https://app.champbeam.com",
        "https://champbeam.com",
        "https://www.champbeam.com",
        "https://champ-utm.vercel.app",
        settings.frontendUrl.replace(/\/+$/, ""),
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:5173",
        ...settings.corsAllowOrigins.split(",").map((o) => o.trim().replace(/\/+$/, "")),
      ].filter(Boolean),
    );
    let re: RegExp | null = null;
    try {
      re = new RegExp(settings.corsAllowOriginRegex || DEFAULT_ORIGIN_REGEX);
    } catch {
      re = null;
    }
    cfg = { origins, re };
    cache.set(settings, cfg);
  }
  return cfg;
}

export function allowedOrigin(settings: Settings, origin: string | undefined | null): string | null {
  if (!origin) return null;
  const { origins, re } = config(settings);
  if (origins.has(origin) || (re && re.test(origin))) return origin;
  return null;
}

/**
 * Sandboxed hosted HTML runs in an opaque origin and sends `Origin: null`. Allow that origin ONLY on
 * the two public endpoints the injected snippet calls (Beam State, dwell beacon). Both authenticate
 * by page token or carry no secret, and a null origin carries no cookies.
 */
const SANDBOX_PUBLIC = /^\/(api\/pages\/|f\/[^/]+\/page-events$)/;

export function requestOrigin(settings: Settings, origin: string | undefined | null, url: string): string | null {
  if (origin === "null") return SANDBOX_PUBLIC.test(new URL(url).pathname) ? "null" : null;
  return allowedOrigin(settings, origin);
}

export function withCors(res: Response, origin: string | null): Response {
  if (!origin) return res;
  let out = res;
  try {
    out.headers.set("Access-Control-Allow-Origin", origin);
  } catch {
    out = new Response(res.body, res); // immutable headers (e.g. fetched/redirect responses)
    out.headers.set("Access-Control-Allow-Origin", origin);
  }
  out.headers.set("Access-Control-Allow-Credentials", "true");
  out.headers.append("Vary", "Origin");
  return out;
}

export const cors: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = requestOrigin(c.var.settings, c.req.header("origin"), c.req.url);
  if (c.req.method === "OPTIONS" && c.req.header("access-control-request-method")) {
    if (!origin) return c.text("Disallowed CORS origin", 400);
    return new Response("OK", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": ALLOW_METHODS,
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      },
    });
  }
  await next();
  c.res = withCors(c.res, origin);
};
