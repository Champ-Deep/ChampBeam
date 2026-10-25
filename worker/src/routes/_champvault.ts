/**
 * ChampVault content-hub client (external, read-only). Port of
 * backend/app/integrations/champvault_client.py.
 *
 * ChampVault stores client-facing assets on Cloudflare R2 + Stream. ChampBeam is
 * a thin consumer: it lists the library, mints a short-lived delivery URL, wraps
 * that URL in a tracked beam, and records the opens — it never stores the bytes.
 *
 * Reads credentials from settings (CHAMPVAULT_URL / CHAMPVAULT_API_KEY) so an
 * unconfigured deployment degrades to a clean 503 instead of crashing.
 * Uses the global fetch at call time (tests mock it with vi.spyOn).
 *
 * Exports: ChampVaultError, ChampVaultNotConfigured, Asset, assetFromJson,
 * assetToDict, ChampVault (listAssets/getAsset/listCollections/deliver),
 * deliveryTarget(delivered).
 */
import type { Settings } from "../env";

/** ChampVault returned a non-success response. */
export class ChampVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChampVaultError";
  }
}

/** CHAMPVAULT_URL / CHAMPVAULT_API_KEY are unset; caller should 503. */
export class ChampVaultNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChampVaultNotConfigured";
  }
}

export interface Asset {
  id: string;
  title: string;
  type: string;
  storage: string;
  status: string;
  mime: string | null;
  sizeBytes: number | null;
  durationS: number | null;
  hasThumbnail: boolean;
  thumbnailKey: string | null;
  tags: string[];
  description: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

type Json = Record<string, any>;

const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export function assetFromJson(d: Json): Asset {
  if (!d || d.id === undefined) throw new ChampVaultError("asset payload missing 'id'");
  return {
    id: d.id,
    title: d.title ?? "",
    type: d.type ?? "",
    storage: d.storage ?? "",
    status: d.status ?? "",
    mime: orNull(d.mime),
    sizeBytes: orNull(d.sizeBytes),
    durationS: orNull(d.durationS),
    hasThumbnail: !!d.hasThumbnail,
    thumbnailKey: orNull(d.thumbnailKey),
    tags: d.tags || [],
    description: orNull(d.description),
    createdAt: orNull(d.createdAt),
    updatedAt: orNull(d.updatedAt),
  };
}

export function assetToDict(a: Asset): Json {
  return {
    id: a.id,
    title: a.title,
    type: a.type,
    storage: a.storage,
    status: a.status,
    mime: a.mime,
    size_bytes: a.sizeBytes,
    duration_s: a.durationS,
    has_thumbnail: a.hasThumbnail,
    thumbnail_key: a.thumbnailKey,
    tags: a.tags,
    description: a.description,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  };
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class ChampVault {
  readonly base: string;
  readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(settings: Pick<Settings, "champvaultUrl" | "champvaultApiKey">, opts: { timeoutMs?: number } = {}) {
    this.base = (settings.champvaultUrl || "").replace(/\/+$/, "");
    this.apiKey = settings.champvaultApiKey || "";
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private require(): void {
    if (!(this.base && this.apiKey)) {
      throw new ChampVaultNotConfigured(
        "ChampVault is not configured (set CHAMPVAULT_URL and CHAMPVAULT_API_KEY).",
      );
    }
  }

  private async send(path: string, init: RequestInit, label: string, timeoutMs = this.timeoutMs): Promise<any> {
    let resp: Response;
    try {
      resp = await fetch(`${this.base}/api/v1${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      // httpx transport errors propagated as non-ChampVault errors in Python
      // (500). Surfacing them as ChampVaultError (502) is the friendlier choice.
      throw new ChampVaultError(`${label} -> ${String((err as Error)?.message ?? err)}`);
    }
    if (resp.status >= 400) {
      throw new ChampVaultError(`${label} -> ${resp.status}: ${await resp.text().catch(() => "")}`);
    }
    try {
      return await resp.json();
    } catch {
      throw new ChampVaultError(`${label} -> invalid JSON`);
    }
  }

  private async get(path: string, params: Record<string, string | null | undefined> = {}): Promise<any> {
    this.require();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    const q = qs.toString();
    return this.send(q ? `${path}?${q}` : path, { headers: { "x-api-key": this.apiKey } }, `GET ${path}`);
  }

  async listAssets(
    opts: { type?: string | null; tag?: string | null; q?: string | null; collection?: string | null; status?: string | null } = {},
  ): Promise<Asset[]> {
    const data = await this.get("/assets", {
      type: opts.type,
      tag: opts.tag,
      q: opts.q,
      collection: opts.collection,
      status: opts.status,
    });
    return ((data?.assets ?? []) as Json[]).map(assetFromJson);
  }

  async getAsset(assetId: string): Promise<Asset> {
    const data = await this.get(`/assets/${encodeURIComponent(assetId)}`);
    return assetFromJson(data?.asset);
  }

  async listCollections(): Promise<Json[]> {
    return ((await this.get("/collections"))?.collections ?? []) as Json[];
  }

  /** Mint a delivery URL. Returns {kind, url|hlsUrl|iframeUrl, expiresAt}. */
  async deliver(assetId: string, expiresInS = 3600, opts: { timeoutMs?: number } = {}): Promise<Json> {
    this.require();
    return this.send(
      `/assets/${encodeURIComponent(assetId)}/deliver`,
      {
        method: "POST",
        headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ expiresInS: expiresInS }),
      },
      `deliver ${assetId}`,
      opts.timeoutMs ?? this.timeoutMs,
    );
  }
}

/**
 * The human-facing URL to wrap in a beam.
 *
 * Files serve their bytes inline at `url`. Videos should open the embeddable
 * Cloudflare player (`iframeUrl`), not the raw HLS manifest — so a click in a
 * browser plays rather than downloads a `.m3u8`.
 */
export function deliveryTarget(delivered: Json): string | null {
  if (delivered?.kind === "video") return delivered.iframeUrl || delivered.hlsUrl || null;
  return delivered?.url || delivered?.iframeUrl || delivered?.hlsUrl || null;
}
