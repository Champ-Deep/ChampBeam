/**
 * Fixtures shared by the org / content / champvault / rooms route tests
 * (ports of the per-file fixtures in backend/tests/test_org_*.py etc.).
 */
import { afterEach, beforeEach, vi } from "vitest";
import { getSettings, type Env, type Settings } from "../src/env";
import { env, orgSession } from "./helpers";
import { router as redirectRouter } from "../src/routes/redirect";

/**
 * The /r/{code} re-mint assertions need the redirect router (routes/redirect.ts,
 * another port). They run only once that router registers routes.
 */
export const REDIRECT_PORTED = redirectRouter.routes.length > 0;

export type Session = Awaited<ReturnType<typeof orgSession>> & { userId: string };

/** A Clerk org session in a given org, with an optional display name. */
export async function member(clerkOrgId: string, role: string, fullName?: string): Promise<Session> {
  const s = await orgSession({ role, clerkOrgId });
  if (!s.userId) throw new Error(`org session failed (auth/me -> ${s.meStatus})`);
  if (fullName) {
    await env.DB.prepare("UPDATE users SET full_name = ? WHERE id = ?").bind(fullName, s.userId).run();
  }
  return s as Session;
}

export const newOrgId = () => `org_${crypto.randomUUID().slice(0, 8)}`;

/** admin, leader, rep1 (reports to leader), rep2 (unassigned) — _seed_team. */
export async function seedTeam(names: { admin?: string; leader?: string; rep1?: string; rep2?: string } = {}) {
  const org = newOrgId();
  const admin = await member(org, "admin", names.admin ?? "Admin");
  const leader = await member(org, "leader", names.leader ?? "Leah Leader");
  const rep1 = await member(org, "member", names.rep1 ?? "Rep One");
  const rep2 = await member(org, "member", names.rep2 ?? "Rep Two");
  await setLeader(rep1.userId, leader.userId);
  return { org, admin, leader, rep1, rep2 };
}

export async function setLeader(userId: string, leaderId: string | null) {
  await env.DB.prepare("UPDATE organization_memberships SET leader_user_id = ? WHERE user_id = ?")
    .bind(leaderId, userId)
    .run();
}

/** Insert click events on a link (one per IP). */
export async function addClicks(linkId: string, ips: string[]) {
  for (const ip of ips) {
    await env.DB.prepare(
      "INSERT INTO click_events (id, link_id, ip_address, is_revisit, is_vpn, clicked_at) VALUES (?,?,?,0,0,?)",
    )
      .bind(crypto.randomUUID(), linkId, ip, new Date().toISOString())
      .run();
  }
}

/** The link id behind a member's share of a content item. */
export async function shareLinkId(contentId: string, userId: string): Promise<string> {
  const row = await env.DB.prepare("SELECT link_id FROM content_shares WHERE content_id = ? AND shared_by_user_id = ?")
    .bind(contentId, userId)
    .first<{ link_id: string }>();
  if (!row) throw new Error("no share");
  return row.link_id;
}

// ---- settings patching (restore in afterEach) ------------------------------

const patched: [Settings, Partial<Settings>][] = [];

export function setSettings(patch: Partial<Settings>) {
  const s = getSettings(env as unknown as Env);
  const saved: Partial<Settings> = {};
  for (const k of Object.keys(patch) as (keyof Settings)[]) (saved as any)[k] = s[k];
  patched.push([s, saved]);
  Object.assign(s, patch);
}

export function restoreSettings() {
  while (patched.length) {
    const [s, saved] = patched.pop()!;
    Object.assign(s, saved);
  }
}

/**
 * Per-test setup/teardown for these route tests: restore patched settings and
 * fetch mocks after each test. Also pins the Clerk issuer check off — a local
 * worker/.dev.vars (CLERK_PUBLISHABLE_KEY placeholder) is picked up by the test
 * pool and would otherwise derive a bogus issuer and 401 every test JWT.
 */
export function useRouteTestHooks() {
  beforeEach(() => setSettings({ resolvedClerkIssuer: "" }));
  afterEach(() => {
    restoreSettings();
    vi.restoreAllMocks();
  });
}

// ---- ChampVault HTTP mock --------------------------------------------------

export const VAULT = "https://vault.test";

const jsonResp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export interface VaultMock {
  calls: { deliver: number; getAsset: number; list: number };
  listParams: URLSearchParams[];
}

/**
 * Configure ChampVault and stub its API at the fetch layer (_configure_champvault).
 * `getAsset(id)` may return null to simulate a 404; `assets` feeds GET /assets.
 */
export function mockVault(
  opts: {
    configure?: boolean;
    assets?: Record<string, unknown>[];
    getAsset?: (id: string) => Record<string, unknown> | null;
  } = {},
): VaultMock {
  if (opts.configure !== false) {
    setSettings({ champvaultUrl: VAULT, champvaultApiKey: "cvb_test", champvaultConfigured: true });
  }
  const mock: VaultMock = { calls: { deliver: 0, getAsset: 0, list: 0 }, listParams: [] };
  const getAsset =
    opts.getAsset ??
    ((id: string) => ({
      id,
      title: `Deck ${id}`,
      type: "deck",
      storage: "r2",
      status: "published",
      description: "A pitch deck",
    }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.origin !== VAULT) return new Response("not mocked", { status: 599 });
    let m: RegExpMatchArray | null;
    if (method === "POST" && (m = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)\/deliver$/))) {
      mock.calls.deliver += 1;
      const id = decodeURIComponent(m[1]);
      return jsonResp({ kind: "file", url: `${VAULT}/d/${id}?v=${mock.calls.deliver}`, expiresAt: 9999 });
    }
    if (method === "GET" && url.pathname === "/api/v1/assets") {
      mock.calls.list += 1;
      mock.listParams.push(url.searchParams);
      return jsonResp({ assets: opts.assets ?? [] });
    }
    if (method === "GET" && (m = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)$/))) {
      mock.calls.getAsset += 1;
      const asset = getAsset(decodeURIComponent(m[1]));
      return asset ? jsonResp({ asset }) : jsonResp({ error: "not found" }, 404);
    }
    if (method === "GET" && url.pathname === "/api/v1/collections") {
      return jsonResp({ collections: [{ id: "c1", name: "Decks" }] });
    }
    return jsonResp({ error: "unknown" }, 404);
  });
  return mock;
}
