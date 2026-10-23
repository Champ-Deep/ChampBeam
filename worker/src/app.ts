/**
 * The API application. Port of backend/app/main.py.
 *
 * Request flow: settings/db injection -> CORS -> service-key gate -> routers.
 * Unmatched non-API paths fall through to the static SPA (ASSETS binding).
 */
import { Hono } from "hono";
import type { AppEnv } from "./env";
import { getSettings } from "./env";
import { getDb } from "./db/client";
import { HTTPError } from "./lib/errors";
import { allowedOrigin, cors, withCors } from "./lib/cors";
import { serviceKeyGate } from "./auth/serviceAuth";

import { router as health } from "./routes/health";
import { router as redirect } from "./routes/redirect";
import { router as shortLinks } from "./routes/shortLinks";
import { router as filesServe } from "./routes/filesServe";
import { router as pageState } from "./routes/pageState";
import { router as auth } from "./routes/auth";
import { router as utm } from "./routes/utm";
import { router as projects } from "./routes/projects";
import { router as domains } from "./routes/domains";
import { router as files } from "./routes/files";
import { router as qr } from "./routes/qr";
import { router as webhooks } from "./routes/webhooks";
import { router as org } from "./routes/org";
import { router as content } from "./routes/content";
import { router as champvault } from "./routes/champvault";
import { router as rooms } from "./routes/rooms";
import { router as apiKeys } from "./routes/apiKeys";
import { router as internalProvisioning } from "./routes/internalProvisioning";
import { router as pages } from "./routes/pages";
import { router as system } from "./routes/system";

export const app = new Hono<AppEnv>({ strict: false });

app.use("*", async (c, next) => {
  c.set("settings", getSettings(c.env));
  c.set("db", getDb(c.env.DB));
  await next();
});
app.use("*", cors);
app.use("*", serviceKeyGate);

app.onError((err, c) => {
  let res: Response;
  if (err instanceof HTTPError) {
    res = c.json({ detail: err.detail }, err.status as 400);
    for (const [k, v] of Object.entries(err.headers)) res.headers.set(k, v);
  } else {
    console.error(`Unhandled exception on ${c.req.method} ${new URL(c.req.url).pathname}`, err);
    res = c.json({ detail: "Internal server error" }, 500);
  }
  return withCors(res, allowedOrigin(c.var.settings ?? getSettings(c.env), c.req.header("origin")));
});

app.notFound(async (c) => {
  const path = new URL(c.req.url).pathname;
  const isApi = path === "/api" || path.startsWith("/api/") || path === "/health";
  if (!isApi && c.env.ASSETS && (c.req.method === "GET" || c.req.method === "HEAD")) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ detail: "Not Found" }, 404);
});

const v1 = "/api/v1";
app.route("/", health);
app.route("/", redirect);
app.route("/", shortLinks);
app.route("/", filesServe);
app.route("/api/pages", pageState);
app.route(`${v1}/auth`, auth);
app.route(`${v1}/utm`, utm);
app.route(`${v1}/projects`, projects);
app.route(`${v1}/domains`, domains);
app.route(`${v1}/files`, files);
app.route(v1, qr);
app.route(`${v1}/webhooks`, webhooks);
app.route(`${v1}/org`, org);
app.route(`${v1}/content`, content);
app.route(`${v1}/champvault`, champvault);
app.route(`${v1}/rooms`, rooms);
app.route(`${v1}/api-keys`, apiKeys);
app.route(`${v1}/internal/provisioning`, internalProvisioning);
app.route(`${v1}/pages`, pages);
app.route(`${v1}/system`, system);
