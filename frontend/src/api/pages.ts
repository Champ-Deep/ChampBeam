import api from './client';
import { appendQuery, asArray, dateParams } from './_shared';
import type { DateRangeOpts, GeoBreakdownItem, DeviceBreakdown } from './utm';

// ============================================================
// Types (mirror backend/app/api/v1/pages.py)
// ============================================================

export interface BeamPage {
  page_id: string;
  short_code: string;
  slug: string | null;
  url: string;
  legacy_url: string;
  title: string;
  size_bytes: number;
  view_count: number;
  unique_visitors: number;
  revisits: number;
  total_dwell_ms: number;
  enabled: boolean;
  has_access_code: boolean;
  domain_id: string | null;
  created_at: string;
  updated_at: string;
  current_version: number;
}

export interface PageVersion {
  version_no: number;
  size_bytes: number;
  sha256: string | null;
  filename: string;
  created_at: string;
  current: boolean;
}

export type PageEventType = 'view' | 'revisit' | 'comment_added' | 'state_changed' | 'gate_failed';

export interface PageTimelineEvent {
  type: PageEventType | string;
  ts: string | null;
  ip: string | null;
  visitor_id: string | null;
  ref: string | null;
  country: string | null;
  city: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  is_vpn: boolean;
}

export interface PageAnalytics {
  page_id: string;
  slug: string | null;
  short_code: string;
  title: string;
  view_count: number;
  views: number;
  unique_visitors: number;
  revisits: number;
  sessions: number;
  total_dwell_ms: number;
  median_dwell_ms: number;
  avg_dwell_ms: number;
  last_viewed_at: string | null;
  created_at: string | null;
}

export interface PageComment {
  id: string;
  author: string;
  body: string;
  visitor_id: string | null;
  ip: string | null;
  created_at: string | null;
}

export interface PagePublish {
  html: string;
  title?: string;
  domain_id?: string;
  slug?: string;
}

export interface PagePatch {
  title?: string;
  slug?: string;
  enabled?: boolean;
  domain_id?: string | null;
  access_code?: string | null;
}

// ============================================================
// API
// ============================================================

export const pagesApi = {
  async list(): Promise<BeamPage[]> {
    const response = await api.get<BeamPage[]>('/pages');
    return asArray<BeamPage>(response.data);
  },

  async get(pageId: string): Promise<BeamPage> {
    const response = await api.get<BeamPage>(`/pages/${pageId}`);
    return response.data;
  },

  /** Publish from an HTML string (a dropped file is read with `file.text()`). */
  async create(data: PagePublish): Promise<BeamPage> {
    const response = await api.post<BeamPage>('/pages', data);
    return response.data;
  },

  /** Replace content; URL, slug and QR stay identical. */
  async update(pageId: string, data: { html: string; title?: string }): Promise<BeamPage> {
    const response = await api.put<BeamPage>(`/pages/${pageId}`, data);
    return response.data;
  },

  async patch(pageId: string, data: PagePatch): Promise<BeamPage> {
    const response = await api.patch<BeamPage>(`/pages/${pageId}`, data);
    return response.data;
  },

  async delete(pageId: string): Promise<void> {
    await api.delete(`/pages/${pageId}`);
  },

  async versions(pageId: string): Promise<PageVersion[]> {
    const response = await api.get<PageVersion[]>(`/pages/${pageId}/versions`);
    return asArray<PageVersion>(response.data);
  },

  async rollback(pageId: string, versionNo: number): Promise<BeamPage> {
    const response = await api.post<BeamPage>(`/pages/${pageId}/versions/${versionNo}/rollback`);
    return response.data;
  },

  async rotateStateToken(pageId: string): Promise<{ state_token: string }> {
    const response = await api.post<{ state_token: string }>(`/pages/${pageId}/state-token/rotate`);
    return response.data;
  },

  // ---- Beam State (owner views) ----

  async comments(pageId: string): Promise<PageComment[]> {
    const response = await api.get<PageComment[]>(`/pages/${pageId}/comments`);
    return asArray<PageComment>(response.data);
  },

  async deleteComment(pageId: string, commentId: string): Promise<void> {
    await api.delete(`/pages/${pageId}/comments/${commentId}`);
  },

  async state(pageId: string): Promise<{ state: Record<string, unknown>; count: number }> {
    const response = await api.get<{ state: Record<string, unknown>; count: number }>(
      `/pages/${pageId}/state`,
    );
    return response.data;
  },

  async clearState(pageId: string): Promise<void> {
    await api.delete(`/pages/${pageId}/state`);
  },

  // ---- Analytics ----

  async analytics(pageId: string, opts?: DateRangeOpts): Promise<PageAnalytics> {
    const response = await api.get<PageAnalytics>(
      appendQuery(`/pages/${pageId}/analytics`, dateParams(opts)),
    );
    return response.data;
  },

  async events(pageId: string, opts?: DateRangeOpts): Promise<PageTimelineEvent[]> {
    const response = await api.get<PageTimelineEvent[]>(
      appendQuery(`/pages/${pageId}/events`, dateParams(opts)),
    );
    return asArray<PageTimelineEvent>(response.data);
  },

  /** Geo/device breakdowns are the file endpoints keyed by the same id. */
  async geo(pageId: string, opts?: DateRangeOpts & { level?: string }): Promise<GeoBreakdownItem[]> {
    const params = dateParams(opts);
    if (opts?.level) params.append('level', opts.level);
    const response = await api.get<GeoBreakdownItem[]>(appendQuery(`/files/${pageId}/geo`, params));
    return asArray<GeoBreakdownItem>(response.data);
  },

  async devices(pageId: string, opts?: DateRangeOpts): Promise<DeviceBreakdown> {
    const response = await api.get<DeviceBreakdown>(
      appendQuery(`/files/${pageId}/devices`, dateParams(opts)),
    );
    return response.data;
  },
};

export default pagesApi;
