/**
 * Share-plane guard. Hosted content is untrusted and executable, so the hosts
 * that serve it (SHARE_ORIGIN_HOSTS and org-owned verified domains) expose ONLY
 * the public serve routes: no SPA, no /api/v1. A script running there has no
 * signed-in control plane to talk to and shares no cookies with the app origin.
 * Legacy personal custom domains are deliberately left as they were.
 */
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env";
import { resolveDomain } from "../services/assetLookup";
import { requestHost } from "./request";

const SHARE_PLANE_PATHS: RegExp[] = [
  /^\/(f|p|r|s|rooms)\//,
  /^\/api\/pages\//, // Beam State used by hosted pages
  /^\/health$/,
  /^\/[a-z0-9][a-z0-9-]{1,58}[a-z0-9](\/unlock-code)?$/, // root slug
];

export const shareOriginGuard: MiddlewareHandler<AppEnv> = async (c, next) => {
  const { settings, db } = c.var;
  const host = requestHost(c);
  let plane = settings.isShareOrigin(host);
  if (!plane && !settings.isPlatformHost(host)) {
    plane = !!(await resolveDomain(db, settings, host))?.organizationId;
  }
  c.set("sharePlane", plane);
  if (plane && !SHARE_PLANE_PATHS.some((re) => re.test(new URL(c.req.url).pathname))) {
    return c.text("Not found.", 404);
  }
  return next();
};
