/**
 * Timestamp helpers. Port of backend/app/core/timeutils.py plus the storage
 * convention for D1.
 *
 * STORAGE: every timestamp column holds ISO-8601 UTC text with millisecond
 * precision and a trailing "Z" ("2026-10-22T16:14:12.123Z", i.e.
 * Date#toISOString()). One fixed format means text comparison == time
 * comparison, so `WHERE expires_at <= ?` and ORDER BY work in SQL.
 *
 * SERIALIZATION (match the Python responses exactly, the SPA depends on it):
 *  - the Python code that called `iso_utc(dt)`      -> use `isoUtc(v)`   ("...Z")
 *  - a Pydantic model field typed `datetime`        -> use `isoNaive(v)` (no "Z";
 *    Pydantic emitted naive UTC datetimes without an offset)
 *  - day buckets from `date_trunc('day', ...)`      -> `dayKey(v)` ("YYYY-MM-DD")
 */

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse a stored timestamp (also tolerates legacy "YYYY-MM-DD HH:MM:SS[.ffffff]"). */
export function parseIso(v: string | null | undefined): Date | null {
  if (!v) return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(" ", "T");
  // Trim sub-millisecond digits (Postgres microseconds) for Date.parse.
  s = s.replace(/(\.\d{3})\d+/, "$1");
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) && s.includes("T")) s += "Z";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Normalize any stored/parsed timestamp to the canonical storage format. */
export function toStored(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  const d = typeof v === "string" ? parseIso(v) : v;
  return d ? d.toISOString() : null;
}

/** ISO string with an explicit UTC designator ("...Z"), or null. (iso_utc) */
export function isoUtc(v: string | Date | null | undefined): string | null {
  return toStored(v);
}

/** ISO string WITHOUT offset — matches Pydantic's naive-datetime output. */
export function isoNaive(v: string | Date | null | undefined): string | null {
  const s = toStored(v);
  return s ? s.slice(0, -1) : null;
}

/** "YYYY-MM-DD" calendar-day bucket of a timestamp (UTC). */
export function dayKey(v: string | Date): string {
  const s = toStored(v);
  return s ? s.slice(0, 10) : "";
}

export function addSeconds(v: string | Date, seconds: number): string {
  const d = typeof v === "string" ? parseIso(v)! : v;
  return new Date(d.getTime() + seconds * 1000).toISOString();
}

export function secondsFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/** True when the timestamp is set and at/before now. */
export function isPast(v: string | null | undefined, now: Date = new Date()): boolean {
  const d = parseIso(v);
  return d !== null && d.getTime() <= now.getTime();
}

/** Seconds between two timestamps (b - a). */
export function diffSeconds(a: string | Date, b: string | Date): number {
  const da = typeof a === "string" ? parseIso(a)! : a;
  const db = typeof b === "string" ? parseIso(b)! : b;
  return (db.getTime() - da.getTime()) / 1000;
}
