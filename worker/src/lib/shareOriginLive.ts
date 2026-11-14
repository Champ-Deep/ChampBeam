/**
 * A configured share origin is only a link target once it answers as this app.
 * SHARE_ORIGIN_HOSTS can name share.champbeam.com before that custom domain
 * exists. Until https://<host>/health returns this worker's healthy payload,
 * minted links and control-plane redirects stay on the platform host.
 */
import type { Settings } from "../env";

const OK_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 20_000;

const cache = new Map<string, { ok: boolean; exp: number }>();
const inflight = new Map<string, Promise<boolean>>();

export function clearShareOriginLiveCache(): void {
  cache.clear();
  inflight.clear();
}

/** True when `host` is serving this worker's /health. Failures stay false. */
export function shareOriginIsLive(host: string): Promise<boolean> {
  const key = host.toLowerCase().trim();
  if (!key) return Promise.resolve(false);
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.exp > now) return Promise.resolve(hit.ok);
  const pending = inflight.get(key);
  if (pending) return pending;
  const probe = probeShareOrigin(key).finally(() => inflight.delete(key));
  inflight.set(key, probe);
  return probe;
}

async function probeShareOrigin(host: string): Promise<boolean> {
  let ok = false;
  try {
    const res = await fetch(`https://${host}/health`, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(1500),
      headers: { accept: "application/json" },
    });
    if (res.ok) {
      const body = (await res.json().catch(() => null)) as { status?: string; database?: string } | null;
      ok = body?.status === "healthy" && body?.database === "connected";
    }
  } catch {
    ok = false;
  }
  cache.set(host, { ok, exp: Date.now() + (ok ? OK_TTL_MS : MISS_TTL_MS) });
  return ok;
}

/** Configured share origin when it is actually answering, else "". */
export async function reachableShareHost(
  settings: Pick<Settings, "resolvedShareHost" | "shareOriginReachable">,
): Promise<string> {
  const share = settings.resolvedShareHost;
  if (!share) return "";
  if (settings.shareOriginReachable === true) return share;
  if (settings.shareOriginReachable === false) return "";
  return (await shareOriginIsLive(share)) ? share : "";
}
