import { api } from './client';

// Normalize a list response that might arrive wrapped or null.
function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

// ============================================================
// Types
// ============================================================

export interface OrgContext {
  org_id: string;
  org_slug: string | null;
  name: string | null;
  role: string | null;
  is_admin: boolean;
  member_count: number;
}

export interface MemberStats {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  leader_user_id: string | null;
  shares: number;
  opens: number;
  unique_opens: number;
}

export interface Assignment {
  id: string;
  champvault_asset_id: string;
  asset_title: string | null;
  assigned_to_user_id: string;
  assigned_by_user_id: string | null;
  note: string | null;
  created_at: string;
  sent: boolean;
}

export interface CreateAssignmentInput {
  champvault_asset_id: string;
  asset_title?: string;
  assigned_to_user_id: string;
  note?: string;
}

export interface ContentPerformance {
  content_id: string;
  title: string;
  kind: string;
  is_archived: boolean;
  shares: number;
  sharing_members: number;
  opens: number;
  unique_opens: number;
  last_engaged_at: string | null;
}

export interface ContentPerformanceReport {
  total_content: number;
  total_shares: number;
  total_opens: number;
  items: ContentPerformance[];
}

export interface MemberContribution {
  user_id: string;
  email: string | null;
  full_name: string | null;
  opens: number;
  unique_opens: number;
  share_url: string | null;
}

export interface ContentBreakdown {
  content_id: string;
  title: string;
  opens: number;
  unique_opens: number;
  members: MemberContribution[];
}

export type ContentKind = 'file' | 'link';

export interface MyShare {
  share_id: string;
  share_url: string;
  opens: number;
}

export interface ContentItem {
  id: string;
  title: string;
  description: string | null;
  kind: ContentKind;
  canonical_url: string | null;
  // Set when the item is a live reference to a ChampVault asset (member shares
  // re-mint a fresh delivery URL on each open). UI badges it and hides the
  // internal champvault:// marker.
  champvault_asset_id?: string | null;
  file_id: string | null;
  is_archived: boolean;
  created_at: string;
  share_count: number;
  my_share: MyShare | null;
}

export interface CreateContentInput {
  title: string;
  description?: string;
  kind: ContentKind;
  canonical_url?: string;
  file_id?: string;
}

// ============================================================
// Org API
// ============================================================

export const orgApi = {
  async getContext(): Promise<OrgContext> {
    const response = await api.get<OrgContext>('/org/context');
    return response.data;
  },

  async listMembers(): Promise<MemberStats[]> {
    const response = await api.get<MemberStats[]>('/org/members');
    return asArray<MemberStats>(response.data);
  },

  async contentPerformance(): Promise<ContentPerformanceReport> {
    const response = await api.get<ContentPerformanceReport>('/org/analytics/content');
    return response.data;
  },

  async contentBreakdown(contentId: string): Promise<ContentBreakdown> {
    const response = await api.get<ContentBreakdown>(`/org/analytics/content/${contentId}`);
    return response.data;
  },

  // Super admin: set (or clear, with null) the leader a member reports to.
  async assignMemberLeader(
    userId: string,
    leaderUserId: string | null
  ): Promise<{ user_id: string; role: string; leader_user_id: string | null }> {
    const response = await api.patch<{ user_id: string; role: string; leader_user_id: string | null }>(`/org/members/${userId}`, { leader_user_id: leaderUserId });
    return response.data;
  },
};

// ============================================================
// Assignments (leader -> rep soft recommendations)
// ============================================================

export const assignmentsApi = {
  async create(input: CreateAssignmentInput): Promise<Assignment> {
    const response = await api.post<Assignment>('/org/assignments', input);
    return response.data;
  },

  // Assignments the caller received (their shelf).
  async mine(): Promise<Assignment[]> {
    const response = await api.get<Assignment[]>('/org/assignments/mine');
    return asArray<Assignment>(response.data);
  },

  // Assignments the caller made (leader) or every one in the org (super admin).
  async made(): Promise<Assignment[]> {
    const response = await api.get<Assignment[]>('/org/assignments');
    return asArray<Assignment>(response.data);
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/org/assignments/${id}`);
  },
};

// ============================================================
// Content library API
// ============================================================

export const contentApi = {
  async list(): Promise<ContentItem[]> {
    const response = await api.get<ContentItem[]>('/content');
    return asArray<ContentItem>(response.data);
  },

  async create(input: CreateContentInput): Promise<ContentItem> {
    const response = await api.post<ContentItem>('/content', input);
    return response.data;
  },

  // Admin: add a ChampVault asset to the library as a live reference. Idempotent
  // per (org, asset); title/description resolve from ChampVault when omitted.
  async addFromChampVault(
    input: { asset_id: string; title?: string; description?: string }
  ): Promise<ContentItem> {
    const response = await api.post<ContentItem>('/content/from-champvault', input);
    return response.data;
  },

  async update(
    id: string,
    patch: { title?: string; description?: string; is_archived?: boolean }
  ): Promise<ContentItem> {
    const response = await api.patch<ContentItem>(`/content/${id}`, patch);
    return response.data;
  },

  async remove(id: string): Promise<void> {
    await api.delete(`/content/${id}`);
  },

  async share(id: string, domainId?: string): Promise<{ share_id: string; content_id: string; share_url: string }> {
    const response = await api.post<{ share_id: string; content_id: string; share_url: string }>(`/content/${id}/share`, { domain_id: domainId ?? null });
    return response.data;
  },

  async myShares(): Promise<ContentItem[]> {
    const response = await api.get<ContentItem[]>('/content/mine/shares');
    return asArray<ContentItem>(response.data);
  },
};
