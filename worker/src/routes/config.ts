/** GET /api/v1/config: what the UI needs to decide which screens to offer. */
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { getCurrentUser } from "../auth/security";

export const router = new Hono<AppEnv>({ strict: false });

router.get("/", async (c) => {
  const s = c.var.settings;
  const u = await getCurrentUser(c);
  return c.json({
    email_enabled: s.emailEnabled,
    custom_domains_enabled: s.cloudflareConfigured,
    is_super_admin: !!u?.isSuperAdmin,
    // The UI keys off this, not is_super_admin; a paid tier widens it later.
    can_create_org: !!u?.isSuperAdmin,
    platform_host: s.platformHost,
  });
});
