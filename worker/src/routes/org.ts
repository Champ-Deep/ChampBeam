/**
 * Port of backend/app/api/v1/org.py — mounted at /api/v1/org.
 * TODO(port): not yet ported.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });
