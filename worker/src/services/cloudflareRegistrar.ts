/**
 * Cloudflare Registrar API client (beta) for in-app domain procurement. Port
 * of backend/app/services/cloudflare_registrar.py.
 *
 * Wraps the account-scoped Registrar endpoints — search names, check
 * availability/price, register — plus the two follow-on calls used to wire a
 * freshly registered domain to this backend (find its new zone, add a CNAME).
 *
 * When `settings.cloudflareRegistrarConfigured` is false the calls throw
 * `RegistrarNotConfigured` so the API layer can answer 503 with a setup hint,
 * mirroring the Cloudflare-for-SaaS pattern in `cloudflare.ts`.
 *
 * Exports:
 *   class RegistrarError, class RegistrarNotConfigured
 *   search(settings, query, limit = 20, opts?)            -> Promise<CfResult[]>  (the `domains` list)
 *   check(settings, domains, opts?)                       -> Promise<CfResult[]>  (first 20 names)
 *   register(settings, domainName, { autoRenew?, contacts? } = {}, opts?) -> Promise<CfResult>
 *   registrationStatus(settings, domainName, opts?)       -> Promise<CfResult>
 *   findZoneId(settings, domainName, opts?)               -> Promise<string | null>
 *   createCname(settings, zoneId, name, target, proxied = true, opts?) -> Promise<CfResult>
 *   deriveRegistrationState(result)                       -> string
 *
 * `opts.fetch` is injectable for tests (defaults to the global fetch).
 */
import type { Settings } from "../env";
import { API_BASE, type CfOptions, type CfResult, type FetchFn } from "./cloudflare";

/** Raised when the Registrar API returns a non-success response. */
export class RegistrarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrarError";
  }
}

/** Raised when account id / token are missing; caller should 503. */
export class RegistrarNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistrarNotConfigured";
  }
}

type RegSettings = Pick<Settings, "cloudflareRegistrarConfigured" | "cloudflareApiToken" | "cloudflareAccountId">;

function requireConfigured(settings: RegSettings): [string, string] {
  if (!settings.cloudflareRegistrarConfigured) {
    throw new RegistrarNotConfigured(
      "Domain procurement is not configured " +
        "(set CLOUDFLARE_API_TOKEN with Registrar write scope and CLOUDFLARE_ACCOUNT_ID).",
    );
  }
  return [settings.cloudflareApiToken, settings.cloudflareAccountId];
}

function headers(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function fetcher(opts?: CfOptions): FetchFn {
  return opts?.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

async function parseBody(resp: Response, op: string): Promise<[CfResult, string]> {
  const text = await resp.text();
  let body: CfResult;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RegistrarError(`${op}: non-JSON response (HTTP ${resp.status})`);
  }
  // Registrar responses may omit `success`; treat a missing flag as success.
  if (!resp.ok || (body?.success ?? true) === false) {
    const errors = body?.errors?.length ? body.errors : [{ message: text }];
    throw new RegistrarError(`${op}: ${JSON.stringify(errors)}`);
  }
  return [body, text];
}

async function unwrap(resp: Response, op: string): Promise<CfResult> {
  const [body] = await parseBody(resp, op);
  return body.result || {};
}

async function unwrapList(resp: Response, op: string): Promise<CfResult[]> {
  const [body] = await parseBody(resp, op);
  return body.result || [];
}

/** Suggest registrable domains for a keyword. Returns the `domains` list. */
export async function search(settings: RegSettings, query: string, limit = 20, opts?: CfOptions): Promise<CfResult[]> {
  const [token, accountId] = requireConfigured(settings);
  const url = new URL(`${API_BASE}/accounts/${accountId}/registrar/domain-search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", String(limit));
  const resp = await fetcher(opts)(url.toString(), {
    method: "GET",
    headers: headers(token),
    signal: AbortSignal.timeout(15_000),
  });
  return (await unwrap(resp, `search(${query})`)).domains ?? [];
}

/** Check live availability + pricing for up to 20 exact domains. */
export async function check(settings: RegSettings, domains: string[], opts?: CfOptions): Promise<CfResult[]> {
  const [token, accountId] = requireConfigured(settings);
  const resp = await fetcher(opts)(`${API_BASE}/accounts/${accountId}/registrar/domain-check`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ domains: domains.slice(0, 20) }),
    signal: AbortSignal.timeout(20_000),
  });
  return (await unwrap(resp, "check")).domains ?? [];
}

/**
 * Register a domain. Returns the registration workflow result.
 *
 * Synchronous by default (CF waits up to ~10s); the result carries `state`
 * (succeeded | in_progress | action_required | failed | blocked) and, when
 * complete, a `context.registration` block with expiry + status.
 */
export async function register(
  settings: RegSettings,
  domainName: string,
  { autoRenew = false, contacts }: { autoRenew?: boolean; contacts?: Record<string, unknown> | null } = {},
  opts?: CfOptions,
): Promise<CfResult> {
  const [token, accountId] = requireConfigured(settings);
  const body: Record<string, unknown> = { domain_name: domainName, auto_renew: autoRenew };
  if (contacts && Object.keys(contacts).length) body.contacts = contacts;
  const resp = await fetcher(opts)(`${API_BASE}/accounts/${accountId}/registrar/registrations`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  return unwrap(resp, `register(${domainName})`);
}

/** Poll the registration workflow for a domain. */
export async function registrationStatus(settings: RegSettings, domainName: string, opts?: CfOptions): Promise<CfResult> {
  const [token, accountId] = requireConfigured(settings);
  const resp = await fetcher(opts)(
    `${API_BASE}/accounts/${accountId}/registrar/registrations/${domainName}/registration-status`,
    { method: "GET", headers: headers(token), signal: AbortSignal.timeout(15_000) },
  );
  return unwrap(resp, `registration_status(${domainName})`);
}

/** Resolve the zone id for a domain in our account (created on registration). */
export async function findZoneId(settings: RegSettings, domainName: string, opts?: CfOptions): Promise<string | null> {
  const [token, accountId] = requireConfigured(settings);
  const url = new URL(`${API_BASE}/zones`);
  url.searchParams.set("name", domainName);
  url.searchParams.set("account.id", accountId);
  const resp = await fetcher(opts)(url.toString(), {
    method: "GET",
    headers: headers(token),
    signal: AbortSignal.timeout(15_000),
  });
  const result = await unwrapList(resp, `find_zone_id(${domainName})`);
  return result.length ? (result[0].id as string) : null;
}

/** Create a (proxied) CNAME record pointing `name` at `target`. */
export async function createCname(
  settings: RegSettings,
  zoneId: string,
  name: string,
  target: string,
  proxied = true,
  opts?: CfOptions,
): Promise<CfResult> {
  const [token] = requireConfigured(settings);
  const resp = await fetcher(opts)(`${API_BASE}/zones/${zoneId}/dns_records`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({ type: "CNAME", name, content: target, proxied, ttl: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  return unwrap(resp, `create_cname(${name})`);
}

/** Normalize a registration workflow result to a single state string. */
export function deriveRegistrationState(result: CfResult): string {
  const state = String(result?.state || "").toLowerCase();
  if (result?.completed && (state === "" || state === "succeeded")) return "succeeded";
  return state || "in_progress";
}
