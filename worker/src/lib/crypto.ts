/**
 * Crypto helpers on WebCrypto, matching the Python stdlib calls they replace
 * (hashlib.sha256, hmac.new(..., sha256), secrets.token_urlsafe/hex,
 * hmac.compare_digest) so stored hashes/tokens stay compatible after the data
 * migration.
 */

const enc = new TextEncoder();

function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === "string") return enc.encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

export function bytesToBase64(bytes: ArrayBuffer | Uint8Array): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** hashlib.sha256(data).hexdigest() */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  return bytesToHex(await crypto.subtle.digest("SHA-256", toBytes(data)));
}

async function hmacKey(secret: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    toBytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/** hmac.new(secret, msg, sha256).digest() */
export async function hmacSha256(secret: string | Uint8Array, msg: string | Uint8Array): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, toBytes(msg)));
}

/** hmac.new(secret, msg, sha256).hexdigest() */
export async function hmacSha256Hex(secret: string | Uint8Array, msg: string | Uint8Array): Promise<string> {
  return bytesToHex(await hmacSha256(secret, msg));
}

/** hmac.compare_digest for strings. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** secrets.token_urlsafe(nbytes) */
export function tokenUrlsafe(nbytes = 32): string {
  return bytesToBase64Url(randomBytes(nbytes));
}

/** secrets.token_hex(nbytes) */
export function tokenHex(nbytes = 32): string {
  return bytesToHex(randomBytes(nbytes));
}

/** Uniform random string from an alphabet (secrets.choice loop). */
export function randomString(length: number, alphabet: string): string {
  const out: string[] = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte < max) out.push(alphabet[byte % alphabet.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

export function uuid(): string {
  return crypto.randomUUID();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a canonical UUID string (FastAPI's `UUID` path-param validation). */
export function isUuid(v: string | null | undefined): v is string {
  return !!v && UUID_RE.test(v);
}
