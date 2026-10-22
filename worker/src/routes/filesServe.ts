/**
 * Port of backend/app/api/files.py — mounted at / (/f/..., /p/...).
 * TODO(port): not yet ported.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });
