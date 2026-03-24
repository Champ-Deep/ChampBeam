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
  clicked_at: string | null;
}

export interface GeoBreakdownItem {
  country: string | null;
  country_code: string | null;
  clicks: number;
}

export interface DeviceBreakdown {
  devices: { device_type: string | null; clicks: number }[];
  browsers: { browser: string | null; clicks: number }[];
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
    opts?: { projectName?: string; projectId?: string; days?: number }
  ): Promise<UTMBreakdownItem[]> {
    const params = new URLSearchParams({ group_by: groupBy });
    if (opts?.projectId) params.append('project_id', opts.projectId);
    else if (opts?.projectName) params.append('project_name', opts.projectName);
    if (opts?.days) params.append('days', opts.days.toString());
    const response = await api.get<UTMBreakdownItem[]>(
      `/utm/analytics/breakdown?${params.toString()}`
    );
    return response.data;
  },

  async getLinkPerformance(
    opts?: { projectName?: string; projectId?: string; days?: number }
  ): Promise<LinkPerformanceItem[]> {
    const params = new URLSearchParams();
    if (opts?.projectId) params.append('project_id', opts.projectId);
    else if (opts?.projectName) params.append('project_name', opts.projectName);
    if (opts?.days) params.append('days', opts.days.toString());
    const query = params.toString();
    const response = await api.get<LinkPerformanceItem[]>(
      `/utm/analytics/links${query ? `?${query}` : ''}`
    );
    return response.data;
  },

  async getPerformanceOverTime(
    opts?: { days?: number; projectName?: string; projectId?: string }
  ): Promise<PerformanceOverTime> {
    const params = new URLSearchParams();
    if (opts?.days) params.append('days', opts.days.toString());
    if (opts?.projectId) params.append('project_id', opts.projectId);
    else if (opts?.projectName) params.append('project_name', opts.projectName);
    const query = params.toString();
    const response = await api.get<PerformanceOverTime>(
      `/utm/analytics/performance${query ? `?${query}` : ''}`
    );
    return response.data;
  },

  // Per-link Analytics
  async getLinkClickEvents(linkId: string, days?: number): Promise<ClickEvent[]> {
    const params = new URLSearchParams();
    if (days) params.append('days', days.toString());
    const query = params.toString();
    const response = await api.get<ClickEvent[]>(
      `/utm/analytics/links/${linkId}/events${query ? `?${query}` : ''}`
    );
    return response.data;
  },

  async getLinkGeoBreakdown(linkId: string, days?: number): Promise<GeoBreakdownItem[]> {
    const params = new URLSearchParams();
    if (days) params.append('days', days.toString());
    const query = params.toString();
    const response = await api.get<GeoBreakdownItem[]>(
      `/utm/analytics/links/${linkId}/geo${query ? `?${query}` : ''}`
    );
    return response.data;
  },

  async getLinkDeviceBreakdown(linkId: string, days?: number): Promise<DeviceBreakdown> {
    const params = new URLSearchParams();
    if (days) params.append('days', days.toString());
    const query = params.toString();
    const response = await api.get<DeviceBreakdown>(
      `/utm/analytics/links/${linkId}/devices${query ? `?${query}` : ''}`
    );
    return response.data;
  },
};

export default utmApi;
