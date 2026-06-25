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
}

export interface BeamResult {
  asset_id: string;
  link_id: string;
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
};
