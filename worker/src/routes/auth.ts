/** Port of backend/app/api/v1/auth.py — mounted at /api/v1/auth. */
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { users } from "../db/schema";
import { requireAuth } from "../auth/security";
import { httpError } from "../lib/errors";
import { parseJson } from "../lib/validate";
import { nowIso } from "../lib/time";
import * as userService from "../services/user";

export const router = new Hono<AppEnv>({ strict: false });

const userResponse = (u: userService.User) => ({ user_id: u.id, email: u.email, full_name: u.fullName ?? null });

router.get("/me", async (c) => {
  const user = await requireAuth(c);
  const dbUser = await userService.getById(c.var.db, user.userId);
  if (!dbUser) httpError(404, "User not found");
  return c.json(userResponse(dbUser!));
});

const ProfileUpdate = z.object({
  full_name: z.string().nullish(),
  email: z.string().nullish(),
});

router.put("/profile", async (c) => {
  const body = await parseJson(c, ProfileUpdate);
  const user = await requireAuth(c);
  const db = c.var.db;
  const dbUser = await userService.getById(db, user.userId);
  if (!dbUser) httpError(404, "User not found");
  const patch: Partial<userService.User> = { updatedAt: nowIso() };
  if (body.full_name != null) patch.fullName = body.full_name;
  if (body.email != null) patch.email = body.email;
  await db.update(users).set(patch).where(eq(users.id, dbUser!.id));
  return c.json(userResponse({ ...dbUser!, ...patch }));
});
