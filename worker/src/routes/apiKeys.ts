/**
 * Port of backend/app/api/v1/api_keys.py — mounted at /api/v1/api-keys.
 *
 * Keys authenticate external integrations against the rest of the API (see
 * auth/security.ts). Management itself requires an interactive Clerk session —
 * a leaked key must not be able to mint or revoke other keys.
 */
import { Hono } from "hono";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import type { TokenData } from "../auth/security";
import { requireClerkAuth } from "../auth/security";
import { API_KEY_PREFIX, apiKeys } from "../db/schema";
import { httpError } from "../lib/errors";
import { parseJson } from "../lib/validate";
import { sha256Hex, tokenUrlsafe } from "../lib/crypto";
import { isoNaive, nowIso } from "../lib/time";

export const router = new Hono<AppEnv>({ strict: false });

export const MAX_ACTIVE_KEYS = 10;

const ApiKeyCreate = z.object({ name: z.string().min(1).max(100) });

type ApiKeyRow = typeof apiKeys.$inferSelect;

function toResponse(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    last_used_at: isoNaive(row.lastUsedAt),
    revoked_at: isoNaive(row.revokedAt),
    created_at: isoNaive(row.createdAt) ?? "",
  };
}

/** Lenient UUID parse (like Python's UUID()): canonical lowercase, or null. */
function canonicalUuid(v: string): string | null {
  let s = v.trim().toLowerCase();
  if (s.startsWith("urn:uuid:")) s = s.slice(9);
  s = s.replace(/^\{|\}$/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function getOwnedKey(c: Ctx, keyId: string, user: TokenData): Promise<ApiKeyRow> {
  const id = canonicalUuid(keyId);
  if (!id) httpError(404, "API key not found");
  const row = await c.var.db
    .select()
    .from(apiKeys)
    .where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.userId)))
    .get();
  if (!row) httpError(404, "API key not found");
  return row;
}

/** Create a new API key. The full key is returned once; store it safely. */
router.post("/", async (c) => {
  const user = await requireClerkAuth(c);
  const data = await parseJson(c, ApiKeyCreate);
  const db = c.var.db;

  const active = await db
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.userId, user.userId), isNull(apiKeys.revokedAt)))
    .all();
  if (active.length >= MAX_ACTIVE_KEYS) {
    httpError(400, `Limit of ${MAX_ACTIVE_KEYS} active API keys reached; revoke one first`);
  }

  const rawKey = API_KEY_PREFIX + tokenUrlsafe(32);
  const [row] = await db
    .insert(apiKeys)
    .values({
      id: crypto.randomUUID(),
      userId: user.userId,
      name: data.name.trim(),
      keyPrefix: rawKey.slice(0, 12),
      keyHash: await sha256Hex(rawKey),
      createdAt: nowIso(),
    })
    .returning();

  return c.json({ ...toResponse(row), api_key: rawKey }, 201);
});

/** List the caller's API keys (prefix only — full keys are never shown again). */
router.get("/", async (c) => {
  const user = await requireClerkAuth(c);
  const rows = await c.var.db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, user.userId))
    .orderBy(desc(apiKeys.createdAt))
    .all();
  return c.json(rows.map(toResponse));
});

/** Revoke a key immediately. Revoked keys are kept for the audit trail. */
async function revoke(c: Ctx) {
  const user = await requireClerkAuth(c);
  const row = await getOwnedKey(c, c.req.param("key_id") ?? "", user);
  if (row.revokedAt == null) {
    row.revokedAt = nowIso();
    await c.var.db.update(apiKeys).set({ revokedAt: row.revokedAt }).where(eq(apiKeys.id, row.id));
  }
  return c.json(toResponse(row));
}

router.post("/:key_id/revoke", (c) => revoke(c));

/** Alias for revoke — keys are soft-deleted, never removed. */
router.delete("/:key_id", (c) => revoke(c));
