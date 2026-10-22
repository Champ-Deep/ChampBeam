/**
 * Port of backend/app/api/v1/short_links.py — mounted at / (/s/{short_code}).
 * TODO(port): not yet ported.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });
