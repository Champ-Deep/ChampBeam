import api from './client';

// ============================================================
// Types (mirror worker/src/routes/alerts.ts)
// ============================================================

export interface ForwardAlertDraft {
  subject: string;
  body: string;
  model: string;
  created_at: string;
}

export interface ForwardAlert {
  id: string;
  asset: { type: 'link' | 'file'; id: string; title: string; url: string };
  reason: 'cities' | 'new_company';
  cities: string[];
  visitors: number;
  company_name: string | null;
  detected_at: string;
  seen_at: string | null;
  dismissed_at: string | null;
  draft: ForwardAlertDraft | null;
  /** Owner-only context (cities, dwell); never part of the draft text. */
  sender_notes: string[];
}

export interface ForwardAlertList {
  alerts: ForwardAlert[];
  unread: number;
}

export interface ForwardDraftResponse {
  draft: ForwardAlertDraft;
  sender_notes: string[];
}

// ============================================================
// API (copy-only drafts: there is no send endpoint)
// ============================================================

export const alertsApi = {
  async forwards(params: { status?: 'open' | 'all'; limit?: number } = {}): Promise<ForwardAlertList> {
    const response = await api.get<ForwardAlertList>('/alerts/forwards', { params });
    return response.data;
  },

  async markSeen(id: string): Promise<void> {
    await api.post(`/alerts/forwards/${id}/seen`);
  },

  async dismiss(id: string): Promise<void> {
    await api.post(`/alerts/forwards/${id}/dismiss`);
  },

  async draft(id: string): Promise<ForwardDraftResponse> {
    const response = await api.post<ForwardDraftResponse>(`/alerts/forwards/${id}/draft`);
    return response.data;
  },
};
