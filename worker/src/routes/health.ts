/** Port of backend/app/api/v1/health.py — mounted at / (GET /health). */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });

router.get("/health", async (c) => {
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ status: "healthy", database: "connected" });
  } catch (err) {
    return c.json({ status: "unhealthy", database: `error: ${String((err as Error)?.message ?? err)}` });
  }
});

/** API root (the Python app served this at "/", which now belongs to the SPA). */
router.get("/api", (c) => {
  const s = c.var.settings;
  return c.json({ name: s.appName, version: s.appVersion, docs: "/docs", health: "/health" });
});
