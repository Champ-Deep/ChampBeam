import api from './client';

/** How a check should be read by a human or a monitor. */
export type SystemStatus = 'ok' | 'warning' | 'critical' | 'unknown';

export interface MaxMindDay {
  day: string;
  lookups: number;
  errors: number;
  queries_remaining: number | null;
}

export interface MaxMindUsage {
  configured: boolean;
  endpoint: string;
  queries_remaining: number | null;
  balance_as_of: string | null;
  status: SystemStatus;
  warn_threshold: number;
  critical_threshold: number;
  lookups_today: number;
  lookups_window: number;
  window_days: number;
  errors_window: number;
  avg_daily: number;
  days_left: number | null;
  projected_exhaustion: string | null;
  lifetime_lookups: number;
  lifetime_errors: number;
  /** 0 when no contract price has been configured; spend fields are then null. */
  unit_price_usd: number;
  spend_window_usd: number | null;
  spend_lifetime_usd: number | null;
  daily: MaxMindDay[];
}

export const systemApi = {
  async access(): Promise<{ is_admin: boolean }> {
    const response = await api.get<{ is_admin: boolean }>('/system/access');
    return response.data;
  },
  async maxmind(days = 30): Promise<MaxMindUsage> {
    const response = await api.get<MaxMindUsage>('/system/maxmind', { params: { days } });
    return response.data;
  },
};
