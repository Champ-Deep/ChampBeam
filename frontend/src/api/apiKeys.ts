import api from './client';

export interface ApiKeySummary {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface ApiKeyCreated extends ApiKeySummary {
  /** Full key — returned exactly once at creation time. */
  api_key: string;
}

export const apiKeysApi = {
  async list(): Promise<ApiKeySummary[]> {
    const response = await api.get<ApiKeySummary[]>('/api-keys');
    return Array.isArray(response.data) ? response.data : [];
  },

  async create(name: string): Promise<ApiKeyCreated> {
    const response = await api.post<ApiKeyCreated>('/api-keys', { name });
    return response.data;
  },

  async revoke(id: string): Promise<ApiKeySummary> {
    const response = await api.post<ApiKeySummary>(`/api-keys/${id}/revoke`);
    return response.data;
  },
};

export default apiKeysApi;
