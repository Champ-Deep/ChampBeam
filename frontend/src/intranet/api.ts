import axios from 'axios';
import api from '../api/client';
import { asArray } from '../api/_shared';

export type TransferState =
  | 'scanning'
  | 'submitted'
  | 'in_review'
  | 'released'
  | 'rejected'
  | 'consumed'
  | 'expired'
  | 'revoked'
  | 'withdrawn'
  | 'check_failed';

export type Receipt = 'scanning' | 'pending' | 'not_opened' | 'opened' | 'expired' | 'revoked' | 'rejected' | 'consumed' | 'withdrawn' | 'check_failed';

export interface Person {
  user_id: string;
  email: string | null;
  full_name: string | null;
}

export interface Transfer {
  id: string;
  state: TransferState;
  receipt: Receipt;
  filename: string | null;
  size_bytes: number | null;
  mime_type: string | null;
  sha256: string | null;
  purpose: string;
  submitter: Person;
  recipient: Person;
  requested_expires_in_days: number | null;
  requested_one_time: boolean;
  one_time: boolean;
  expires_at: string | null;
  submitted_at: string | null;
  agent_window_ends_at: string | null;
  hard_expires_at: string | null;
  decided_at: string | null;
  decided_by_type: string | null;
  reject_reason: string | null;
  released_at: string | null;
  first_opened_at: string | null;
  consumed_at: string | null;
  expired_at: string | null;
  revoked_at: string | null;
  age_seconds: number;
  scan_status: 'pending' | 'clean' | 'infected' | 'not_scanned' | null;
  scan_detail: string | null;
  reminded_at: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  decided_by_id: string | null;
  agent_result: { p_approve: number; reasons: string[]; provider: string; model: string } | null;
  withdrawn_at: string | null;
  access_code_required: boolean;
}

export interface ReviewSettings {
  agent_mode: string;
  agent_window_hours: number;
  agent_threshold: number;
  agent_input_mode: string;
  default_expiry_days: number;
  hard_expiry_days: number;
  reminder_hours: number | null;
}

export interface Me {
  user: { user_id: string; email: string | null; full_name: string | null };
  organization: { id: string; name: string | null; slug: string | null };
  is_admin: boolean;
  is_reviewer: boolean;
  settings: ReviewSettings;
  limits: {
    max_file_bytes: number;
    max_bytes_per_user: number;
    max_expiry_days: number;
    blocked_extensions: string[];
  };
  malware_scan: boolean;
  malware_scan_max_bytes: number | null;
  agent: { modes: string[]; clef_configured: boolean; jev_configured: boolean; benchmark_providers: string[] };
}

export interface Member {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_admin: boolean;
  is_reviewer: boolean;
  active: boolean;
}

export interface Invite {
  id: string;
  email: string;
  role: string;
  is_reviewer?: boolean;
  /** Returned once, when the invite is created. */
  invite_url?: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  created_at: string | null;
  expires_at: string | null;
}

export interface LogEntry {
  id: number;
  at: string | null;
  transfer_id: string | null;
  event: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  reason: string | null;
  detail: Record<string, unknown> | null;
  prev_hash: string | null;
  row_hash: string;
}

export interface BenchmarkRow {
  threshold: number;
  agreement: number | null;
  auto_approved: number;
  coverage: number | null;
  false_releases: number;
  false_release_rate: number | null;
  missed_approvals: number;
}

export interface Benchmark {
  id: string;
  provider: string;
  status: 'running' | 'done' | 'failed';
  created_at: string | null;
  finished_at: string | null;
  error: string | null;
  markdown: string | null;
  report: {
    cases: number;
    scored: number;
    errors: number;
    human_approved: number;
    human_rejected: number;
    current_threshold: number;
    models: string[];
    sweep: BenchmarkRow[];
    note: string;
  } | null;
}

export interface Badges {
  inbox_unopened: number;
  review_queue: number;
  review_overdue: number;
}

export interface LogFilters {
  start?: string;
  end?: string;
  event?: string;
  actor_id?: string;
  transfer_id?: string;
  limit?: number;
  offset?: number;
}

export interface SubmitInput {
  file: File;
  recipient_user_id: string;
  purpose: string;
  requested_expires_in_days?: number | null;
  requested_one_time: boolean;
}

function resolveApiPath(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  try {
    return `${new URL(api.defaults.baseURL || '/', window.location.origin).origin}${path}`;
  } catch {
    return path;
  }
}

function cleanParams(filters: LogFilters): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value as string | number;
  }
  return out;
}

export const intranetApi = {
  async me(): Promise<Me> {
    return (await api.get<Me>('/intranet/me')).data;
  },
  async badges(): Promise<Badges> {
    return (await api.get<Badges>('/intranet/badges')).data;
  },
  async members(): Promise<Member[]> {
    return asArray<Member>((await api.get('/intranet/members')).data);
  },
  async updateMember(userId: string, patch: { is_reviewer?: boolean; role?: 'admin' | 'member'; active?: boolean }): Promise<Member> {
    return (await api.patch<Member>(`/intranet/members/${userId}`, patch)).data;
  },
  async invites(): Promise<Invite[]> {
    return asArray<Invite>((await api.get('/intranet/invites')).data);
  },
  async invite(email: string, role: 'admin' | 'member', isReviewer = false): Promise<Invite> {
    return (await api.post<Invite>('/intranet/invites', { email, role, is_reviewer: isReviewer })).data;
  },
  async lookupInvite(token: string): Promise<{ email: string; organization: string | null; expires_at: string }> {
    return (await api.get<{ email: string; organization: string | null; expires_at: string }>('/intranet/invites/lookup', { params: { token } })).data;
  },
  async acceptInvite(token: string, name: string, password: string): Promise<void> {
    await api.post('/intranet/invites/accept', { token, name, password });
  },
  async revokeInvite(id: string): Promise<Invite> {
    return (await api.delete<Invite>(`/intranet/invites/${id}`)).data;
  },
  async reviewSettings(): Promise<ReviewSettings> {
    return (await api.get<ReviewSettings>('/intranet/review-settings')).data;
  },
  async saveReviewSettings(patch: Partial<ReviewSettings>): Promise<ReviewSettings> {
    return (await api.put<ReviewSettings>('/intranet/review-settings', patch)).data;
  },
  async submit(input: SubmitInput, onProgress?: (pct: number) => void): Promise<Transfer> {
    const init = (
      await api.post<{ file_id: string; upload_url: string; headers: Record<string, string>; upload_via_backend: boolean }>(
        '/intranet/uploads',
        {
          filename: input.file.name,
          content_type: input.file.type || 'application/octet-stream',
          size_bytes: input.file.size,
        },
      )
    ).data;
    const target = init.upload_via_backend ? resolveApiPath(init.upload_url) : init.upload_url;
    await axios.put(target, input.file, {
      headers: init.headers,
      onUploadProgress: (e) => {
        if (onProgress && e.total) onProgress(Math.round((e.loaded / e.total) * 100));
      },
    });
    return (
      await api.post<Transfer>('/intranet/transfers', {
        file_id: init.file_id,
        recipient_user_id: input.recipient_user_id,
        purpose: input.purpose,
        requested_expires_in_days: input.requested_expires_in_days || null,
        requested_one_time: input.requested_one_time,
      })
    ).data;
  },
  async mine(): Promise<Transfer[]> {
    return asArray<Transfer>((await api.get('/intranet/transfers/mine')).data);
  },
  async inbox(): Promise<Transfer[]> {
    return asArray<Transfer>((await api.get('/intranet/inbox')).data);
  },
  async queue(): Promise<Transfer[]> {
    return asArray<Transfer>((await api.get('/intranet/review/queue')).data);
  },
  async approve(id: string, body: { expires_in_days?: number | null; one_time?: boolean; reason?: string; access_code?: string }): Promise<Transfer> {
    return (await api.post<Transfer>(`/intranet/review/${id}/approve`, body)).data;
  },
  async reject(id: string, reason: string): Promise<Transfer> {
    return (await api.post<Transfer>(`/intranet/review/${id}/reject`, { reason })).data;
  },
  async revoke(id: string, reason?: string): Promise<Transfer> {
    return (await api.post<Transfer>(`/intranet/transfers/${id}/revoke`, { reason: reason || null })).data;
  },
  async withdraw(id: string, reason?: string): Promise<Transfer> {
    return (await api.post<Transfer>(`/intranet/transfers/${id}/withdraw`, { reason: reason || null })).data;
  },
  async agentApproved(): Promise<Transfer[]> {
    return asArray<Transfer>((await api.get('/intranet/review/agent-approved')).data);
  },
  async overturn(id: string, reason: string): Promise<Transfer> {
    return (await api.post<Transfer>(`/intranet/review/${id}/overturn`, { reason })).data;
  },
  async benchmarks(): Promise<Benchmark[]> {
    return asArray<Benchmark>((await api.get('/intranet/agent/benchmarks')).data);
  },
  async startBenchmark(provider: string): Promise<Benchmark> {
    return (await api.post<Benchmark>('/intranet/agent/benchmarks', { provider })).data;
  },
  async download(id: string, kind: 'transfer' | 'review' = 'transfer', accessCode?: string): Promise<void> {
    const body = accessCode ? { kind, access_code: accessCode } : { kind };
    const ticket = (await api.post<{ url: string }>(`/intranet/transfers/${id}/download-ticket`, body)).data;
    window.location.assign(resolveApiPath(ticket.url));
  },
  async log(filters: LogFilters): Promise<{ items: LogEntry[]; total: number }> {
    const data = (await api.get<{ items: LogEntry[]; total: number }>('/intranet/log', { params: cleanParams(filters) })).data;
    return { items: asArray<LogEntry>(data.items), total: data.total ?? 0 };
  },
  async verifyLog(): Promise<{ ok: boolean; rows: number; first_bad_id: number | null }> {
    return (await api.get<{ ok: boolean; rows: number; first_bad_id: number | null }>('/intranet/log/verify')).data;
  },
  async exportLog(filters: LogFilters): Promise<void> {
    const response = await api.get<Blob>('/intranet/log.csv', { params: cleanParams(filters), responseType: 'blob' });
    const url = URL.createObjectURL(response.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = `decision-log-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },
};
