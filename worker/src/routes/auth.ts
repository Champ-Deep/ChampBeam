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
  // Email comes from Clerk (verified), never from the caller: users.email is an identity key (the
  // X-Service-Key principal is looked up by it), so a self-asserted value could claim another identity.
  if (body.email != null && body.email !== dbUser!.email) httpError(400, "Email is managed by your sign-in provider.");
  if (body.full_name != null) patch.fullName = body.full_name;
  await db.update(users).set(patch).where(eq(users.id, dbUser!.id));
  return c.json(userResponse({ ...dbUser!, ...patch }));
});
