/** Port of backend/app/services/clerk_client.py: Clerk Backend API + svix webhook checks. */
import type { Settings } from "../env";
import { base64ToBytes, bytesToBase64, hmacSha256, timingSafeEqual } from "../lib/crypto";

const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ClerkUser = Record<string, any>;

/** GET the Clerk user record. Returns null on any failure (best-effort). */
export async function fetchUser(settings: Settings, clerkUserId: string): Promise<ClerkUser | null> {
  if (!settings.clerkSecretKey) return null;
  try {
    const resp = await fetch(`${settings.clerkApiUrl.replace(/\/+$/, "")}/v1/users/${clerkUserId}`, {
      headers: { Authorization: `Bearer ${settings.clerkSecretKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.status !== 200) {
      console.warn(`clerk fetch_user ${clerkUserId} -> HTTP ${resp.status}`);
      return null;
    }
    return (await resp.json()) as ClerkUser;
  } catch (err) {
    console.warn(`clerk fetch_user network error for ${clerkUserId}`, err);
    return null;
  }
}

export function primaryEmail(payload: ClerkUser | null | undefined): string | null {
  if (!payload) return null;
  const primaryId = payload.primary_email_address_id;
  const addresses: ClerkUser[] = payload.email_addresses ?? [];
  for (const a of addresses) if (a.id === primaryId && a.email_address) return a.email_address;
  for (const a of addresses) if (a.email_address) return a.email_address;
  return null;
}

export function fullName(payload: ClerkUser | null | undefined): string | null {
  if (!payload) return null;
  const name = `${(payload.first_name ?? "").trim()} ${(payload.last_name ?? "").trim()}`.trim();
  return name || null;
}

/**
 * Verify a Clerk (svix) webhook signature: HMAC-SHA256 over "{id}.{ts}.{body}"
 * keyed by the base64-decoded secret, compared against each "v1,<sig>" value.
 */
export async function verifyWebhook(settings: Settings, headers: Headers, body: string): Promise<boolean> {
  const secret = settings.clerkWebhookSecret;
  if (!secret) return false;
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const tsRaw = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const sigHeader = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !tsRaw || !sigHeader) return false;
  const ts = Number.parseInt(tsRaw, 10);
  if (!Number.isFinite(ts) || String(ts) !== tsRaw.trim()) return false;
  if (Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    console.warn("clerk webhook timestamp outside tolerance");
    return false;
  }
  const key = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = base64ToBytes(key);
  } catch {
    return false;
  }
  const expected = bytesToBase64(await hmacSha256(keyBytes, `${id}.${ts}.${body}`));
  for (const part of sigHeader.split(" ")) {
    const sig = part.slice(part.indexOf(",") + 1);
    if (part.includes(",") && sig && timingSafeEqual(sig, expected)) return true;
  }
  return false;
}
