/** Tests for src/services/fileExpiry.ts (lazy expiry + cron sweep against D1 + R2). */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../src/db/client";
import { getSettings } from "../src/env";
import { fileAssets } from "../src/db/schema";
import { expireAsset, sweepExpired, sweepExpiredFiles } from "../src/services/fileExpiry";
import { createUser, env } from "./helpers";

const db = getDb(env.DB);

async function asset(userId: string, expiresAt: string | null, status = "active") {
  const id = crypto.randomUUID();
  const key = `anon/${id}/f.txt`;
  await env.FILES.put(key, "x");
  await db.insert(fileAssets).values({
    id,
    userId,
    shortCode: id.slice(0, 8),
    filename: "f.txt",
    kind: "other",
    mimeType: "text/plain",
    storageKey: key,
    status,
    expiresAt,
  });
  return { id, key };
}

const statusOf = async (id: string) => (await db.select().from(fileAssets).where(eq(fileAssets.id, id)))[0].status;

describe("file expiry", () => {
  it("sweep reclaims only expired, non-deleted assets (rows soft-deleted, blobs removed)", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 3600_000).toISOString();
    const a = await asset(user.id, past);
    const b = await asset(user.id, past);
    const live = await asset(user.id, future);
    const forever = await asset(user.id, null);

    expect(await sweepExpiredFiles(env as never, getSettings(env as never), db)).toBe(2);
    expect(await statusOf(a.id)).toBe("deleted");
    expect(await statusOf(b.id)).toBe("deleted");
    expect(await env.FILES.head(a.key)).toBeNull();
    expect(await statusOf(live.id)).toBe("active");
    expect(await statusOf(forever.id)).toBe("active");
    expect(await env.FILES.head(live.key)).not.toBeNull();
    expect(await sweepExpired(env.FILES, db)).toBe(0);
  });

  it("sweep respects the batch limit", async () => {
    const user = await createUser();
    const past = new Date(Date.now() - 1000).toISOString();
    for (let i = 0; i < 3; i++) await asset(user.id, past);
    expect(await sweepExpired(env.FILES, db, 2)).toBe(2);
    expect(await sweepExpired(env.FILES, db, 2)).toBe(1);
  });

  it("expireAsset soft-deletes once and removes the blob; unknown id is a no-op", async () => {
    const user = await createUser();
    const a = await asset(user.id, new Date(Date.now() - 1000).toISOString());
    await expireAsset(env.FILES, db, a.id);
    expect(await statusOf(a.id)).toBe("deleted");
    expect(await env.FILES.head(a.key)).toBeNull();
    await expireAsset(env.FILES, db, a.id);
    await expireAsset(env.FILES, db, crypto.randomUUID());
  });
});
