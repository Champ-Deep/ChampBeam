import { api } from './client';

function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export interface VaultAsset {
  id: string;
  title: string;
  type: 'video' | 'deck' | 'pdf' | 'case_study' | 'image' | 'one_pager' | string;
  storage: 'r2' | 'stream' | string;
  status: string;
  mime: string | null;
  size_bytes: number | null;
  duration_s: number | null;
  has_thumbnail: boolean;
  thumbnail_key: string | null;
  tags: string[];
  description: string | null;
  created_at: number | null;
  updated_at: number | null;
  // Annotated per-caller by the backend on GET /champvault/assets.
  favorited?: boolean;
}

export interface FavoriteEntry {
  asset_id: string;
  favorited_at: string | null;
}

export interface BeamResult {
  asset_id: string;
  // Present for org-scoped sends: the shadow Content the send rolls up under.
  content_id?: string | null;
  link_id: string | null;
  beam_url: string;
  kind: 'file' | 'video' | string;
  expires_at: number | null;
}

export const champvaultApi = {
  async config(): Promise<{ configured: boolean }> {
    const res = await api.get<{ configured: boolean }>('/champvault/config');
    return res.data;
  },

  async listAssets(params: { type?: string; tag?: string; q?: string } = {}): Promise<VaultAsset[]> {
    const search = new URLSearchParams();
    if (params.type) search.set('type', params.type);
    if (params.tag) search.set('tag', params.tag);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    const res = await api.get<VaultAsset[]>(`/champvault/assets${qs ? `?${qs}` : ''}`);
    return asArray<VaultAsset>(res.data);
  },

  async beam(
    assetId: string,
    opts: { expires_in_days?: number; domain_id?: string } = {}
  ): Promise<BeamResult> {
    const res = await api.post<BeamResult>(`/champvault/assets/${assetId}/beam`, {
      expires_in_days: opts.expires_in_days ?? 7,
      domain_id: opts.domain_id ?? null,
    });
    return res.data;
  },

  async listFavorites(): Promise<FavoriteEntry[]> {
    const res = await api.get<FavoriteEntry[]>('/champvault/favorites');
    return asArray<FavoriteEntry>(res.data);
  },

  async addFavorite(assetId: string): Promise<void> {
    await api.put(`/champvault/assets/${assetId}/favorite`);
  },

  async removeFavorite(assetId: string): Promise<void> {
    await api.delete(`/champvault/assets/${assetId}/favorite`);
  },
};
