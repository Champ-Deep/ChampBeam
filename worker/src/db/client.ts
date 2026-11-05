/**
 * D1 access via Drizzle.
 *
 * D1 differences from the Postgres/SQLAlchemy code being ported:
 *  - No interactive transactions. Where Python did several writes then
 *    `commit()`, use `db.batch([...])` (atomic) or order writes so a partial
 *    failure is harmless.
 *  - At most 100 bound parameters per statement: chunk big `IN (...)` lists
 *    and multi-row inserts with `chunk()` below.
 *  - Unique-constraint violations surface as errors whose message contains
 *    "UNIQUE constraint failed" — test with `isUniqueViolation(err)`.
 */
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof getDb>;

export function isUniqueViolation(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err) + String((err as { cause?: unknown })?.cause ?? "");
  return msg.includes("UNIQUE constraint failed");
}

export function chunk<T>(items: T[], size = 90): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export { schema };
