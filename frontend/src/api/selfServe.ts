import { api } from './client';

/** GET /api/v1/config: which self-serve screens this deployment and this user get. */
export interface AppConfig {
  email_enabled: boolean;
  custom_domains_enabled: boolean;
  is_super_admin: boolean;
  can_create_org: boolean;
  platform_host: string;
}

export type OrgRole = 'admin' | 'leader' | 'member' | 'viewer';
export const ORG_ROLES: OrgRole[] = ['admin', 'leader', 'member', 'viewer'];
export const ROLE_LABEL: Record<string, string> = { admin: 'Admin', leader: 'Leader', member: 'Member', viewer: 'Viewer', owner: 'Owner' };

export interface CreatedInvitation { id: string; email: string; role: string; accept_url: string; email_sent: boolean }
export interface PendingInvitation { id: string; email: string; role: string; expires_at: string; accept_url: string }

export interface AdminOrg { id: string; name: string; slug: string; created_at: string; members: number; files: number; links: number; content_items: number }

/** The accept link with the invited address attached, so the sign-in form opens prefilled. */
export function inviteLink(acceptUrl: string, email: string): string {
  return `${acceptUrl}?email=${encodeURIComponent(email)}`;
}

export const selfServeApi = {
  async config(): Promise<AppConfig> { return (await api.get<AppConfig>('/config')).data; },
  async invite(email: string, role: OrgRole, resend = false): Promise<CreatedInvitation> {
    return (await api.post<CreatedInvitation>('/org/invitations', { email, role, resend: resend || undefined })).data;
  },
  async pendingInvitations(): Promise<PendingInvitation[]> { return (await api.get<PendingInvitation[]>('/org/invitations')).data; },
  async adminOrgs(): Promise<AdminOrg[]> { return (await api.get<{ orgs: AdminOrg[] }>('/admin/orgs')).data.orgs; },
  async adminCreateOrg(input: { name: string; slug: string; email: string }): Promise<{ id: string }> { return (await api.post<{ id: string }>('/admin/orgs', input)).data; },
  async adminAddMember(orgId: string, input: { email: string; role: OrgRole }): Promise<void> { await api.post(`/admin/orgs/${orgId}/members`, input); },
  async adminMoveMember(input: { user_id: string; from_org_id: string; to_org_id: string; move_content: boolean; leave_source: boolean }): Promise<void> {
    await api.post('/admin/members/move', input);
  },
  async actAs(organizationId: string | null): Promise<void> { await api.post('/admin/act-as', { organization_id: organizationId }); },
};

/** Slug preview for a new org name, inside the server's rule (a to z, 0 to 9, hyphens, 40 max). */
export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
}
