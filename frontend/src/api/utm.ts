import api from './client';

// ============================================================
// Types
// ============================================================

export interface UTMPreset {
  id: string;
  user_id: string;
  name: string;
  is_default: boolean;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  custom_params: Record<string, string> | null;
  created_at: string;
}

export interface UTMPresetCreate {
  name: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  custom_params?: Record<string, string>;
}

export interface GenerateLinkRequest {
  base_url: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  project_name?: string;
  project_id?: string;
  preset_id?: string;
}

export interface GenerateLinkResponse {
  original_url: string;
  tracked_url: string;
  redirect_url: string | null;
  short_code: string | null;
  utm_params: Record<string, string>;
  link_id: string | null;
}

export interface UTMBreakdownItem {
  group_key: string;
  group_value: string;
  total_links: number;
  total_clicks: number;
  unique_clicks: number;
  click_rate: number;
}

export interface LinkPerformanceItem {
  link_id: string;
  original_url: string;
  tracked_url: string | null;
  redirect_url: string | null;
  short_code: string | null;
  anchor_text: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  project_name: string | null;
  project_id: string | null;
  click_count: number;
  unique_clicks: number;
  first_clicked_at: string | null;
  created_at: string | null;
}

export interface UTMOverview {
  total_tracked_links: number;
  total_clicks: number;
  unique_clicks: number;
  overall_click_rate: number;
  top_sources: { source: string; clicks: number }[];
  top_campaigns: { campaign: string; clicks: number }[];
}

export interface PerformanceOverTime {
  days: number;
  data: {
    date: string;
    links_created: number;
    total_clicks: number;
    unique_clicks: number;
  }[];
}

// --- Projects ---

export interface Project {
  id: string;
  name: string;
  description: string | null;
  link_count: number;
  total_clicks: number;
  created_at: string;
}

export interface ProjectCreate {
  name: string;
  description?: string;
}

// --- Click Events ---

export interface ClickEvent {
  id: string;
  ip_address: string | null;
  device_type: string | null;
  browser: string | null;
  os: string | null;
  country: string | null;
  country_code: string | null;
  region: string | null;
  city: string | null;
  referrer: string | null;
  is_vpn: boolean;
  asn_org: string | null;
  clicked_at: string | null;
}

export interface GeoBreakdownItem {
  country: string | null;
  country_code: string | null;
  region?: string | null;
  city?: string | null;
  clicks: number;
}

export interface DeviceBreakdown {
  devices: { device_type: string | null; clicks: number }[];
  browsers: { browser: string | null; clicks: number }[];
  os?: { os: string | null; clicks: number }[];
}

// --- Campaigns ---

export interface CampaignSummary {
  campaign: string;
  total_links: number;
  total_clicks: number;
  unique_clicks: number;
  click_rate: number;
  first_link_created: string | null;
  last_click_at: string | null;
}

export interface CampaignDetail {
  campaign: string;
  total_links: number;
  total_clicks: number;
  unique_clicks: number;
  click_rate: number;
  sources: { source: string; clicks: number }[];
  mediums: { medium: string; clicks: number }[];
}

export interface CampaignTimelinePoint {
  date: string;
  clicks: number;
  unique_clicks: number;
}

export interface CampaignComparisonItem {
  campaign: string;
  total_links: number;
  total_clicks: number;
  unique_clicks: number;
  click_rate: number;
  top_countries: GeoBreakdownItem[];
  top_devices: { device_type: string; clicks: number }[];
  timeline: { date: string; clicks: number }[];
}

// --- Tags ---

export interface LinkTag {
  id: string;
  name: string;
  color: string | null;
  created_at: string | null;
}

// --- Recent Clicks (notifications) ---

export interface RecentClick {
  id: string;
  clicked_at: string | null;
  country: string | null;
  region: string | null;
  device_type: string | null;
  browser: string | null;
  original_url: string;
  short_code: string | null;
  utm_campaign: string | null;
  utm_source: string | null;
}

// --- Shared date range options ---

export interface DateRangeOpts {
  days?: number;
  startDate?: string;
  endDate?: string;
}

// ============================================================
// Helpers
// ============================================================

function _dateParams(opts?: DateRangeOpts): URLSearchParams {
  const params = new URLSearchParams();
  if (opts?.startDate && opts?.endDate) {
    params.append('start_date', opts.startDate);
    params.append('end_date', opts.endDate);
  } else if (opts?.days) {
    params.append('days', opts.days.toString());
  }
  return params;
}

function _appendQuery(base: string, params: URLSearchParams): string {
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}

function _downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ============================================================
// UTM API
// ============================================================

export const utmApi = {
  // Link Generation
  async generateLink(data: GenerateLinkRequest): Promise<GenerateLinkResponse> {
    const response = await api.post<GenerateLinkResponse>('/utm/generate', data);
    return response.data;
  },

  // Link Management
  async deleteLink(linkId: string): Promise<void> {
    await api.delete(`/utm/links/${linkId}`);
  },

  async updateLink(linkId: string, data: { project_id: string | null }): Promise<void> {
    await api.patch(`/utm/links/${linkId}`, data);
  },

  // Bulk CSV
  async processBulkCSV(file: File, presetId?: string): Promise<Blob> {
    const formData = new FormData();
    formData.append('file', file);
    const params = presetId ? `?preset_id=${presetId}` : '';
    const response = await api.post(`/utm/bulk/generate${params}`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      responseType: 'blob',
    });
    return response.data;
  },

  async downloadTemplate(): Promise<Blob> {
    const response = await api.get('/utm/bulk/template', { responseType: 'blob' });
    return response.data;
  },

  // Presets
  async getPresets(): Promise<UTMPreset[]> {
    const response = await api.get<UTMPreset[]>('/utm/presets');
    return response.data;
  },

  async createPreset(preset: UTMPresetCreate): Promise<UTMPreset> {
    const response = await api.post<UTMPreset>('/utm/presets', preset);
    return response.data;
  },

  async updatePreset(id: string, preset: Partial<UTMPresetCreate>): Promise<UTMPreset> {
    const response = await api.put<UTMPreset>(`/utm/presets/${id}`, preset);
    return response.data;
  },

  async deletePreset(id: string): Promise<void> {
    await api.delete(`/utm/presets/${id}`);
  },

  async setDefaultPreset(id: string): Promise<UTMPreset> {
    const response = await api.post<UTMPreset>(`/utm/presets/${id}/default`);
    return response.data;
  },

  // Projects
  async getProjects(): Promise<Project[]> {
    const response = await api.get<Project[]>('/projects');
    return response.data;
  },

  async createProject(data: ProjectCreate): Promise<Project> {
    const response = await api.post<Project>('/projects', data);
    return response.data;
  },

  async updateProject(id: string, data: Partial<ProjectCreate>): Promise<Project> {
    const response = await api.put<Project>(`/projects/${id}`, data);
    return response.data;
  },

  async deleteProject(id: string): Promise<void> {
    await api.delete(`/projects/${id}`);
  },

  // Analytics — Overview
  async getOverview(projectId?: string): Promise<UTMOverview> {
    const params = new URLSearchParams();
    if (projectId) params.append('project_id', projectId);
    const query = params.toString();
    const response = await api.get<UTMOverview>(
      `/utm/analytics/overview${query ? `?${query}` : ''}`
    );
    return response.data;
  },

  async getBreakdown(
    groupBy: string,
    opts?: { projectName?: string; projectId?: string } & DateRangeOpts
  ): Promise<UTMBreakdownItem[]> {
    const params = _dateParams(opts);
    params.append('group_by', groupBy);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    else if (opts?.projectName) params.append('project_name', opts.projectName);
    const response = await api.get<UTMBreakdownItem[]>(
      `/utm/analytics/breakdown?${params.toString()}`
    );
    return response.data;
  },

  async getLinkPerformance(
    opts?: { projectName?: string; projectId?: string } & DateRangeOpts
  ): Promise<LinkPerformanceItem[]> {
    const params = _dateParams(opts);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    else if (opts?.projectName) params.append('project_name', opts.projectName);
    const response = await api.get<LinkPerformanceItem[]>(
      _appendQuery('/utm/analytics/links', params)
    );
    return response.data;
  },

  async getPerformanceOverTime(
    opts?: { projectName?: string; projectId?: string } & DateRangeOpts
  ): Promise<PerformanceOverTime> {
    const params = _dateParams(opts);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    else if (opts?.projectName) params.append('project_name', opts.projectName);
    const response = await api.get<PerformanceOverTime>(
      _appendQuery('/utm/analytics/performance', params)
    );
    return response.data;
  },

  // Per-link Analytics
  async getLinkClickEvents(linkId: string, opts?: DateRangeOpts): Promise<ClickEvent[]> {
    const params = _dateParams(opts);
    const response = await api.get<ClickEvent[]>(
      _appendQuery(`/utm/analytics/links/${linkId}/events`, params)
    );
    return response.data;
  },

  async getLinkGeoBreakdown(linkId: string, opts?: DateRangeOpts & { level?: string }): Promise<GeoBreakdownItem[]> {
    const params = _dateParams(opts);
    if (opts?.level) params.append('level', opts.level);
    const response = await api.get<GeoBreakdownItem[]>(
      _appendQuery(`/utm/analytics/links/${linkId}/geo`, params)
    );
    return response.data;
  },

  async getLinkDeviceBreakdown(linkId: string, opts?: DateRangeOpts): Promise<DeviceBreakdown> {
    const params = _dateParams(opts);
    const response = await api.get<DeviceBreakdown>(
      _appendQuery(`/utm/analytics/links/${linkId}/devices`, params)
    );
    return response.data;
  },

  // ============================================================
  // Campaign Analytics
  // ============================================================

  async getCampaigns(opts?: DateRangeOpts & { projectId?: string }): Promise<CampaignSummary[]> {
    const params = _dateParams(opts);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    const response = await api.get<CampaignSummary[]>(
      _appendQuery('/utm/analytics/campaigns', params)
    );
    return response.data;
  },

  async getCampaignDetail(name: string, opts?: DateRangeOpts): Promise<CampaignDetail> {
    const params = _dateParams(opts);
    const response = await api.get<CampaignDetail>(
      _appendQuery(`/utm/analytics/campaigns/${encodeURIComponent(name)}`, params)
    );
    return response.data;
  },

  async getCampaignGeo(name: string, opts?: DateRangeOpts & { level?: string }): Promise<GeoBreakdownItem[]> {
    const params = _dateParams(opts);
    if (opts?.level) params.append('level', opts.level);
    const response = await api.get<GeoBreakdownItem[]>(
      _appendQuery(`/utm/analytics/campaigns/${encodeURIComponent(name)}/geo`, params)
    );
    return response.data;
  },

  async getCampaignDevices(name: string, opts?: DateRangeOpts): Promise<DeviceBreakdown> {
    const params = _dateParams(opts);
    const response = await api.get<DeviceBreakdown>(
      _appendQuery(`/utm/analytics/campaigns/${encodeURIComponent(name)}/devices`, params)
    );
    return response.data;
  },

  async getCampaignLinks(name: string, opts?: DateRangeOpts): Promise<LinkPerformanceItem[]> {
    const params = _dateParams(opts);
    const response = await api.get<LinkPerformanceItem[]>(
      _appendQuery(`/utm/analytics/campaigns/${encodeURIComponent(name)}/links`, params)
    );
    return response.data;
  },

  async getCampaignTimeline(name: string, opts?: DateRangeOpts): Promise<{ campaign: string; data: CampaignTimelinePoint[] }> {
    const params = _dateParams(opts);
    const response = await api.get(
      _appendQuery(`/utm/analytics/campaigns/${encodeURIComponent(name)}/timeline`, params)
    );
    return response.data;
  },

  async compareCampaigns(campaigns: string[], opts?: DateRangeOpts): Promise<{ campaigns: CampaignComparisonItem[] }> {
    const params = _dateParams(opts);
    params.append('campaigns', campaigns.join(','));
    const response = await api.get(
      _appendQuery('/utm/analytics/campaigns/compare', params)
    );
    return response.data;
  },

  // ============================================================
  // Global Geo Analytics
  // ============================================================

  async getGeoOverview(opts?: DateRangeOpts & { level?: string; projectId?: string; campaign?: string }): Promise<GeoBreakdownItem[]> {
    const params = _dateParams(opts);
    if (opts?.level) params.append('level', opts.level);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    if (opts?.campaign) params.append('campaign', opts.campaign);
    const response = await api.get<GeoBreakdownItem[]>(
      _appendQuery('/utm/analytics/geo/overview', params)
    );
    return response.data;
  },

  // ============================================================
  // Analytics Export
  // ============================================================

  async exportClickEvents(opts?: DateRangeOpts & { projectId?: string; campaign?: string }): Promise<void> {
    const params = _dateParams(opts);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    if (opts?.campaign) params.append('campaign', opts.campaign);
    const response = await api.get(
      _appendQuery('/utm/analytics/export/events', params),
      { responseType: 'blob' }
    );
    _downloadBlob(response.data, 'click_events.csv');
  },

  async exportCampaignSummary(opts?: DateRangeOpts): Promise<void> {
    const params = _dateParams(opts);
    const response = await api.get(
      _appendQuery('/utm/analytics/export/campaign-summary', params),
      { responseType: 'blob' }
    );
    _downloadBlob(response.data, 'campaign_summary.csv');
  },

  async exportLinkPerformance(opts?: DateRangeOpts & { projectId?: string }): Promise<void> {
    const params = _dateParams(opts);
    if (opts?.projectId) params.append('project_id', opts.projectId);
    const response = await api.get(
      _appendQuery('/utm/analytics/export/link-performance', params),
      { responseType: 'blob' }
    );
    _downloadBlob(response.data, 'link_performance.csv');
  },

  // ============================================================
  // Tags
  // ============================================================

  async getTags(): Promise<LinkTag[]> {
    const response = await api.get<LinkTag[]>('/utm/tags');
    return response.data;
  },

  async createTag(name: string, color?: string): Promise<LinkTag> {
    const response = await api.post<LinkTag>('/utm/tags', { name, color });
    return response.data;
  },

  async deleteTag(id: string): Promise<void> {
    await api.delete(`/utm/tags/${id}`);
  },

  async addTagToLink(linkId: string, tagId: string): Promise<void> {
    await api.post(`/utm/links/${linkId}/tags/${tagId}`);
  },

  async removeTagFromLink(linkId: string, tagId: string): Promise<void> {
    await api.delete(`/utm/links/${linkId}/tags/${tagId}`);
  },

  // ============================================================
  // Real-Time Click Notifications
  // ============================================================

  async getRecentClicks(since?: string): Promise<RecentClick[]> {
    const params = new URLSearchParams();
    if (since) params.append('since', since);
    const response = await api.get<RecentClick[]>(
      _appendQuery('/utm/analytics/clicks/recent', params)
    );
    return response.data;
  },
};

export default utmApi;
