/**
 * Port of backend/app/api/v1/internal_provisioning.py — mounted at /api/v1/internal/provisioning.
 * TODO(port): not yet ported.
 */
import { Hono } from "hono";
import type { AppEnv } from "../env";

export const router = new Hono<AppEnv>({ strict: false });
