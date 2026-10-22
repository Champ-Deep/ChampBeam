/**
 * Port of backend/app/api/redirect.py — mounted at / (/r/{short_code}).
 * TODO(port): not yet ported.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });
