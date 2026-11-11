import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "../env";

export type Level = "error" | "warning";

export interface ReportContext {
  component: string;
  level?: Level;
  method?: string;
  path?: string;
  tags?: Record<string, string>;
}

interface Dsn {
  endpoint: string;
  key: string;
}

interface Scope {
  dsn: Dsn | null;
  environment: string;
  release: string;
  waitUntil: (p: Promise<unknown>) => void;
}

const scope = new AsyncLocalStorage<Scope>();
const SEND_TIMEOUT_MS = 5000;
const MAX_TEXT = 2000;

export function parseDsn(raw: string | undefined | null): Dsn | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const project = u.pathname.replace(/^\/+|\/+$/g, "");
    if (!u.username || !project || !/^https?:$/.test(u.protocol)) return null;
    return { endpoint: `${u.protocol}//${u.host}/api/${project}/envelope/`, key: decodeURIComponent(u.username) };
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scrubPath(path: string): string {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare
    .split("/")
    .map((seg) => (UUID.test(seg) ? ":id" : seg.length >= 20 ? ":token" : seg))
    .join("/");
}

export function scrubText(text: string): string {
  return text
    .replace(/(intranet\/u\/[^/\s]+\/[^/\s]+\/)[^\s'"]+/g, "$1[file]")
    .replace(/([?&][^=\s&]+=)[^&\s'"]+/g, "$1[redacted]")
    .replace(/\b[\w.+-]+@[\w-]+(\.[\w-]+)+\b/g, "[email]")
    .slice(0, MAX_TEXT);
}

function frames(stack: string | undefined) {
  if (!stack) return undefined;
  const out: { function?: string; filename: string; lineno: number; colno: number; in_app: boolean }[] = [];
  for (const line of stack.split("\n").slice(1, 40)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    out.push({ function: m[1], filename: m[2]!, lineno: Number(m[3]), colno: Number(m[4]), in_app: !m[2]!.includes("node_modules") });
  }
  return out.length ? { frames: out.reverse() } : undefined;
}

export function buildEvent(
  err: unknown,
  message: string,
  ctx: ReportContext,
  meta: { environment: string; release: string },
): Record<string, unknown> {
  const e = err instanceof Error ? err : null;
  const tags: Record<string, string> = { component: ctx.component, ...(ctx.tags ?? {}) };
  return {
    event_id: crypto.randomUUID().replace(/-/g, ""),
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: ctx.level ?? "error",
    logger: ctx.component,
    environment: meta.environment,
    release: `champbeam-intranet@${meta.release}`,
    server_name: "cloudflare-worker",
    message: { formatted: scrubText(message) },
    tags,
    exception: {
      values: [
        {
          type: e?.name ?? typeof err,
          value: scrubText(e?.message ?? String(err ?? message)),
          stacktrace: frames(e?.stack),
        },
      ],
    },
    ...(ctx.method || ctx.path ? { request: { method: ctx.method, url: ctx.path ? scrubPath(ctx.path) : undefined } } : {}),
  };
}

export function envelope(event: Record<string, unknown>): string {
  return [
    JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString() }),
    JSON.stringify({ type: "event" }),
    JSON.stringify(event),
  ].join("\n");
}

async function send(dsn: Dsn, event: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(dsn.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=champbeam-worker/1.0`,
      },
      body: envelope(event),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!res.ok) console.warn(`glitchtip rejected event: ${res.status}`);
  } catch (err) {
    console.warn("glitchtip unreachable", err);
  }
}

export function withObservability<T>(env: Env, ctx: { waitUntil(p: Promise<unknown>): void }, fn: () => T): T {
  return scope.run(
    {
      dsn: parseDsn(env.GLITCHTIP_DSN as string | undefined),
      environment: String(env.ENVIRONMENT ?? "development"),
      release: String(env.APP_VERSION ?? "1.0.0"),
      waitUntil: (p) => ctx.waitUntil(p),
    },
    fn,
  );
}

export function reportError(message: string, err: unknown, ctx: ReportContext): void {
  const level = ctx.level ?? "error";
  console[level === "warning" ? "warn" : "error"](message, err);
  const s = scope.getStore();
  if (!s?.dsn) return;
  const p = send(s.dsn, buildEvent(err, message, ctx, s));
  try {
    s.waitUntil(p);
  } catch {
    void p;
  }
}
