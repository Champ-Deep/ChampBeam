import { useQuery } from '@tanstack/react-query';
import { apiErrorDetail } from '../api/_shared';
import { formatBytes, formatRelative } from '../lib/format';
import { intranetApi, type Person, type Transfer } from './api';

export const ME_KEY = ['intranet-me'] as const;
export const BADGES_KEY = ['intranet-badges'] as const;
export const TRANSFER_KEYS = [['intranet-mine'], ['intranet-inbox'], ['intranet-queue'], BADGES_KEY, ['intranet-log']] as const;

export function useMe() {
  return useQuery({ queryKey: ME_KEY, queryFn: () => intranetApi.me(), retry: false, staleTime: 60_000 });
}

export function useBadges(enabled: boolean) {
  return useQuery({ queryKey: BADGES_KEY, queryFn: () => intranetApi.badges(), enabled, refetchInterval: 30_000 });
}

export function useMembers() {
  return useQuery({ queryKey: ['intranet-members'], queryFn: () => intranetApi.members() });
}

export function personName(p: Person | null | undefined): string {
  if (!p) return 'Unknown';
  return p.full_name || p.email || p.user_id;
}

const RECEIPT_LABELS: Record<string, string> = {
  pending: 'Waiting for review',
  not_opened: 'Not opened',
  opened: 'Opened',
  expired: 'Expired',
  revoked: 'Revoked',
  rejected: 'Rejected',
};

export function receiptLabel(t: Transfer): string {
  const base = RECEIPT_LABELS[t.receipt] ?? t.receipt;
  if (t.receipt === 'opened' && t.first_opened_at) return `Opened ${formatRelative(t.first_opened_at)}`;
  if (t.receipt === 'pending' && t.state === 'in_review') return 'In review';
  return base;
}

export function stateTone(t: Transfer): string {
  if (t.receipt === 'rejected' || t.receipt === 'revoked') return '#991b1b';
  if (t.receipt === 'opened') return '#166534';
  if (t.receipt === 'expired') return '#475569';
  return 'var(--cb-ink)';
}

export function fileLine(t: Transfer): string {
  const size = t.size_bytes != null ? formatBytes(t.size_bytes) : '';
  return [t.filename ?? 'Deleted file', size].filter(Boolean).join(' · ');
}

export function limitsLine(t: Transfer): string {
  const parts: string[] = [];
  if (t.one_time) parts.push('One-time');
  if (t.expires_at) parts.push(`Expires ${formatRelative(t.expires_at)}`);
  else if (t.requested_expires_in_days) parts.push(`Expiry ${t.requested_expires_in_days} days after release`);
  if (!t.expires_at && t.requested_one_time && !t.one_time) parts.push('One-time requested');
  return parts.join(' · ') || 'Org default';
}

export function errorText(err: unknown, fallback: string): string {
  const detail = apiErrorDetail(err);
  if (detail) return detail;
  return fallback;
}

export function intakeFailures(err: unknown): string[] {
  const data = (err as { response?: { data?: { detail?: { failures?: unknown } } } }).response?.data?.detail;
  const failures = data?.failures;
  return Array.isArray(failures) ? failures.filter((f): f is string => typeof f === 'string') : [];
}
