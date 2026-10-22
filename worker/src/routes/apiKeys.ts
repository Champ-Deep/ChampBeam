/**
 * Port of backend/app/api/v1/api_keys.py — mounted at /api/v1/api-keys.
 * TODO(port): not yet ported.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });
