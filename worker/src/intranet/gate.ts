/**
 * INTRANET_MODE=true turns this Worker into the intranet: only the intranet API, Better Auth, health, the
 * blob upload target and the SPA are served. Every marketing and public route (/r, /s, /f, /p, rooms,
 * pages, UTM, analytics ...) answers 404, so nothing outside the review gate can hand out a file.
 * With the flag off, the intranet API itself answers 404.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";

const BLOB_PUT = /^\/api\/v1\/files\/[0-9a-fA-F-]{36}\/blob\/?$/;

export const intranetGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  const intranetApi = path === "/api/v1/intranet" || path.startsWith("/api/v1/intranet/");
  if (!c.var.settings.intranetMode) {
    if (intranetApi) return c.json({ detail: "Not Found" }, 404);
    return next();
  }
  if (intranetApi || path.startsWith("/api/auth/") || path === "/health" || path === "/favicon.ico") return next();
  if (c.req.method === "PUT" && BLOB_PUT.test(path)) return next();
  const isApi = path === "/api" || path.startsWith("/api/");
  if (!isApi && (c.req.method === "GET" || c.req.method === "HEAD") && c.env.ASSETS) {
    // SPA routes and static files; never the Worker's public serve paths.
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ detail: "Not Found" }, 404);
};
