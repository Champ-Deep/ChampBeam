/**
 * Port of backend/app/api/v1/short_links.py — mounted at / (/s/{short_code}).
 *
 * `/s/{code}` (the path used by the `short_url` field) is a full alias of
 * `/r/{code}`: same Host-scoped lookup, same access gates (email gate, VPN
 * block, revoke/expiry/view caps) and the same click-event recording with geo
 * enrichment. It was historically a "light" endpoint that only bumped an
 * aggregate counter, which starved analytics and skipped the access controls,
 * so the two paths were unified.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { redirectLink } from "./redirect";

export const router = new Hono<AppEnv>({ strict: false });

router.get("/s/:short_code", (c) => redirectLink(c, c.req.param("short_code")));
