/**
 * Cloudflare for SaaS, Custom Hostnames API client. Port of
 * backend/app/services/cloudflare.py.
 *
 * Thin wrapper around the three CF API calls we need:
 * - create a custom hostname (sets up cert issuance + SNI routing)
 * - read its current SSL/validation status
 * - delete it
 *
 * When `settings.cloudflareConfigured` is false the calls throw
 * `CloudflareNotConfigured` so callers can fall back to local-only mode
 * (useful for development without a CF account).
 *
 * Exports:
 *   API_BASE
 *   class CloudflareError, class CloudflareNotConfigured
 *   type FetchFn, type CfOptions = { fetch?: FetchFn }
 *   createCustomHostname(settings, hostname, opts?)        -> Promise<CfResult>
 *   getCustomHostname(settings, customHostnameId, opts?)   -> Promise<CfResult>
 *   deleteCustomHostname(settings, customHostnameId, opts?) -> Promise<void>  (404 = success)
 *   deriveStatus(cfResult) -> [status, sslStatus | null]
 *
 * `opts.fetch` is injectable for tests; it defaults to the global fetch,
 * resolved at call time (so `vi.spyOn(globalThis, "fetch")` also works).
 */
import type { Settings } from "../env";

export const API_BASE = "https://api.cloudflare.com/client/v4";

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface CfOptions {
  fetch?: FetchFn;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CfResult = Record<string, any>;

/** Raised when the CF API returns a non-success response. */
export class CloudflareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareError";
  }
}

/** Raised when CF credentials are missing, caller should fall back. */
export class CloudflareNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareNotConfigured";
  }
}

type CfSettings = Pick<Settings, "cloudflareConfigured" | "cloudflareApiToken" | "cloudflareZoneId">;

function requireConfigured(settings: CfSettings): [string, string] {
  if (!settings.cloudflareConfigured) {
    throw new CloudflareNotConfigured(
      "Cloudflare integration is not configured (set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ZONE_ID).",
    );
  }
  return [settings.cloudflareApiToken, settings.cloudflareZoneId];
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function fetcher(opts?: CfOptions): FetchFn {
  return opts?.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

const TIMEOUT_MS = 15_000;

/** Register a Custom Hostname with HTTP-validated SSL. Returns the CF result (id, status, ssl). */
export async function createCustomHostname(settings: CfSettings, hostname: string, opts?: CfOptions): Promise<CfResult> {
  const [token, zoneId] = requireConfigured(settings);
  const body = {
    hostname,
    ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
  };
  const resp = await fetcher(opts)(`${API_BASE}/zones/${zoneId}/custom_hostnames`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return unwrap(resp, `create_custom_hostname(${hostname})`);
}

/** Read the current state of a Custom Hostname. */
export async function getCustomHostname(settings: CfSettings, customHostnameId: string, opts?: CfOptions): Promise<CfResult> {
  const [token, zoneId] = requireConfigured(settings);
  const resp = await fetcher(opts)(`${API_BASE}/zones/${zoneId}/custom_hostnames/${customHostnameId}`, {
    method: "GET",
    headers: headers(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return unwrap(resp, `get_custom_hostname(${customHostnameId})`);
}

/** Remove a Custom Hostname. Idempotent: a 404 is treated as success. */
export async function deleteCustomHostname(settings: CfSettings, customHostnameId: string, opts?: CfOptions): Promise<void> {
  const [token, zoneId] = requireConfigured(settings);
  const resp = await fetcher(opts)(`${API_BASE}/zones/${zoneId}/custom_hostnames/${customHostnameId}`, {
    method: "DELETE",
    headers: headers(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (resp.status === 404) return;
  await unwrap(resp, `delete_custom_hostname(${customHostnameId})`);
}

async function unwrap(resp: Response, op: string): Promise<CfResult> {
  const text = await resp.text();
  let body: CfResult;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CloudflareError(`${op}: non-JSON response (HTTP ${resp.status})`);
  }
  if (!resp.ok || !body?.success) {
    const errors = body?.errors?.length ? body.errors : [{ message: text }];
    throw new CloudflareError(`${op}: ${JSON.stringify(errors)}`);
  }
  return body.result || {};
}

/**
 * Map a CF custom_hostname result into our [status, sslStatus] shape.
 *
 * CF's `status` covers ownership verification; `ssl.status` covers cert
 * issuance. We collapse both into a single user-visible status:
 *   - `pending_cname` while CF reports `pending`/`blocked` on hostname
 *   - `pending_ssl` while ownership is verified but cert isn't issued
 *   - `active` when both reach `active`
 *   - `failed` on moved/deleted/deactivated states
 */
export function deriveStatus(cfResult: CfResult): [string, string | null] {
  const hostStatus = String(cfResult?.status || "").toLowerCase();
  const sslInfo = cfResult?.ssl || {};
  const sslStatus = String(sslInfo.status || "").toLowerCase() || null;

  if (["moved", "deleted", "deactivated"].includes(hostStatus)) return ["failed", sslStatus];
  if (hostStatus === "active" && sslStatus === "active") return ["active", sslStatus];
  if (hostStatus === "active") return ["pending_ssl", sslStatus];
  return ["pending_cname", sslStatus];
}
