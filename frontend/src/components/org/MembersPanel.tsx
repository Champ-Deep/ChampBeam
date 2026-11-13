import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MoreHorizontal, Search, UserPlus } from 'lucide-react';
import { authClient, useAuth } from '../../lib/authClient';
import { orgApi } from '../../api/org';
import { ORG_ROLES, ROLE_LABEL, selfServeApi, type OrgRole } from '../../api/selfServe';
import { apiErrorDetail } from '../../api/_shared';
import { useAppConfig } from '../../hooks/useAppConfig';
import { Button, useConfirm } from '../ui';
import { Modal } from '../ui/sheet';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '../ui/dropdown-menu';
import { InviteSheet } from './InviteSheet';
import { isAdminRole as isAdmin, refusal, type MemberRow } from '../../lib/selfServeRules';

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Not recorded');
const initials = (s: string) => s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');

/** Settings > Organization > Members. Refusal-aware rows after 21st.dev "Members Table" (id 28871, uvain/members-table). */
export function MembersPanel({ orgId, orgName }: { orgId: string; orgName: string }) {
  const { userId: me } = useAuth();
  const { data: config } = useAppConfig();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [inviting, setInviting] = useState(false);
  const [rowNote, setRowNote] = useState<Record<string, { kind: 'refusal' | 'ok'; text: string }>>({});
  const [moving, setMoving] = useState<MemberRow | null>(null);

  const members = useQuery({
    queryKey: ['ba-members', orgId],
    queryFn: async (): Promise<MemberRow[]> => {
      const { data, error } = await authClient.organization.listMembers({ query: { organizationId: orgId, limit: 500 } });
      if (!error && data) return data.members.map((m) => ({ memberId: m.id, userId: m.userId, name: m.user.name || m.user.email, email: m.user.email, image: m.user.image ?? null, role: m.role, joinedAt: new Date(m.createdAt).toISOString() }));
      // A super admin acting as a non-member cannot use Better Auth's member endpoints; read ChampBeam's list instead.
      const rows = await orgApi.listMembers();
      return rows.map((m) => ({ memberId: null, userId: m.user_id, name: m.full_name || m.email || m.user_id, email: m.email ?? '', image: null, role: m.role, joinedAt: null }));
    },
  });
  const rows = members.data ?? [];
  const adminCount = rows.filter((r) => isAdmin(r.role)).length;
  const needle = q.trim().toLowerCase();
  const shown = needle ? rows.filter((r) => r.name.toLowerCase().includes(needle) || r.email.toLowerCase().includes(needle)) : rows;
  const note = (id: string, kind: 'refusal' | 'ok', text: string) => setRowNote((n) => ({ ...n, [id]: { kind, text } }));
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['ba-members', orgId] }), client.invalidateQueries({ queryKey: ['org-members'] })]);

  async function changeRole(row: MemberRow, role: string) {
    if (role === row.role) return;
    const why = refusal(row, 'role', { me, adminCount, nextRole: role });
    if (why || !row.memberId) return note(row.userId, 'refusal', why ?? 'The role could not be changed.');
    const { error } = await authClient.organization.updateMemberRole({ memberId: row.memberId, role: role as OrgRole, organizationId: orgId });
    if (error) return note(row.userId, 'refusal', error.message || 'The role could not be changed.');
    note(row.userId, 'ok', `Now ${ROLE_LABEL[role] ?? role}.`);
    await refresh();
  }

  async function remove(row: MemberRow) {
    const why = refusal(row, 'remove', { me, adminCount });
    if (why || !row.memberId) return note(row.userId, 'refusal', why ?? 'The member could not be removed.');
    const memberId = row.memberId;
    if (!(await confirm({ title: 'Remove member', message: `Remove ${row.name} from ${orgName}? Their files and links stay in the organization.`, confirmLabel: 'Remove' }))) return;
    const { error } = await authClient.organization.removeMember({ memberIdOrEmail: memberId, organizationId: orgId });
    if (error) return note(row.userId, 'refusal', error.message || 'The member could not be removed.');
    await refresh();
  }

  return <section className="cb-members" aria-labelledby="members-h">
    <div className="cb-section-head">
      <div><h3 id="members-h">Members</h3><p className="cb-hint">{members.data ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'} in ${orgName}.` : '\u00a0'}</p></div>
      <Button onClick={() => setInviting(true)} leftIcon={<UserPlus className="h-4 w-4" />}>Invite people</Button>
    </div>
    <label className="cb-search"><Search className="h-4 w-4" aria-hidden="true" /><span className="sr-only">Search members</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" /></label>
    {members.isLoading && <p role="status" className="cb-hint">Loading members</p>}
    {members.isError && <p role="alert" className="cb-refusal">Members could not load. <button type="button" className="cb-text-btn" onClick={() => void members.refetch()}>Retry</button></p>}
    {members.data && <div className="cb-table-scroll cb-stack"><table className="cb-ledger cb-ledger-members">
      <thead><tr><th scope="col">Member</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Joined</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>
        {shown.map((r) => {
          const n = rowNote[r.userId];
          const locked = refusal(r, 'role', { me, adminCount, nextRole: 'member' });
          return <tr key={r.userId}>
            <td><div className="cb-who"><span className="cb-avatar-sm" aria-hidden="true">{r.image ? <img src={r.image} alt="" /> : initials(r.name || r.email)}</span>
              <span className="min-w-0"><span className="cb-who-name">{r.name}{r.userId === me && <span className="cb-hint"> (you)</span>}</span><span className="cb-mono cb-hint cb-ellipsis" title={r.email}>{r.email}</span></span></div></td>
            <td>
              <select aria-label={`Role for ${r.name}`} value={r.role} disabled={!r.memberId} onChange={(e) => void changeRole(r, e.target.value)}>
                {[...new Set([...ORG_ROLES, r.role])].map((x) => <option key={x} value={x}>{ROLE_LABEL[x] ?? x}</option>)}
              </select>
              {n && <p role={n.kind === 'refusal' ? 'alert' : 'status'} className={n.kind === 'refusal' ? 'cb-refusal' : 'cb-ok'}>{n.text}</p>}
              {!n && locked && isAdmin(r.role) && adminCount <= 1 && <p className="cb-hint">Only admin. Promote someone before changing this.</p>}
            </td>
            <td data-label="Status">Active</td>
            <td data-label="Joined" className="cb-hint">{fmtDate(r.joinedAt)}</td>
            <td className="cb-cell-menu">
              <DropdownMenu>
                <DropdownMenuTrigger className="cb-icon-btn" aria-label={`Actions for ${r.name}`}><MoreHorizontal className="h-4 w-4" aria-hidden="true" /></DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60 rounded-xl border-[var(--cb-border-strong)] bg-white p-1 text-[var(--cb-ink)]">
                  <DropdownMenuLabel className="px-3 text-[12px] font-medium text-[var(--cb-muted)]">Change role</DropdownMenuLabel>
                  {ORG_ROLES.filter((x) => x !== r.role).map((x) => <DropdownMenuItem key={x} className="cb-menu-item" onSelect={() => void changeRole(r, x)}>Make {ROLE_LABEL[x]}</DropdownMenuItem>)}
                  <DropdownMenuSeparator className="bg-[var(--cb-divider)]" />
                  {config?.is_super_admin && <DropdownMenuItem className="cb-menu-item" onSelect={() => setMoving(r)}>Move to another organization</DropdownMenuItem>}
                  <DropdownMenuItem className="cb-menu-item cb-danger" onSelect={() => void remove(r)}>Remove from {orgName}</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </td>
          </tr>;
        })}
        {shown.length === 0 && <tr><td colSpan={5} className="cb-hint">{q ? `Nobody matches "${q}".` : 'No members yet. Invite your team.'}</td></tr>}
      </tbody>
    </table></div>}
    <InviteSheet open={inviting} onOpenChange={setInviting} orgName={orgName} emailEnabled={!!config?.email_enabled} />
    {moving && <MoveMemberDialog row={moving} fromOrgId={orgId} fromOrgName={orgName} onClose={() => setMoving(null)} onMoved={() => void refresh()} />}
  </section>;
}

/** Super admin: move a member to another org, optionally with their content, behind a confirm step. */
export function MoveMemberDialog({ row, fromOrgId, fromOrgName, onClose, onMoved }: { row: MemberRow; fromOrgId: string; fromOrgName: string; onClose: () => void; onMoved: () => void }) {
  const orgs = useQuery({ queryKey: ['admin-orgs'], queryFn: () => selfServeApi.adminOrgs() });
  const [to, setTo] = useState('');
  const [moveContent, setMoveContent] = useState(true);
  const [leave, setLeave] = useState(true);
  const [step, setStep] = useState<'form' | 'confirm' | 'done'>('form');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dest = orgs.data?.find((o) => o.id === to);

  async function run() {
    setBusy(true); setError('');
    try { await selfServeApi.adminMoveMember({ user_id: row.userId, from_org_id: fromOrgId, to_org_id: to, move_content: moveContent, leave_source: leave }); setStep('done'); onMoved(); }
    catch (err) { setError(apiErrorDetail(err) ?? 'The move failed. Nothing was changed.'); setStep('form'); }
    finally { setBusy(false); }
  }

  return <Modal open onOpenChange={(o) => { if (!o) onClose(); }} title={`Move ${row.name}`} description={`From ${fromOrgName}. Their open sessions follow them.`}>
    {step === 'form' && <form className="cb-form" onSubmit={(e) => { e.preventDefault(); if (to) setStep('confirm'); }}>
      <label>Destination organization
        <select value={to} onChange={(e) => setTo(e.target.value)} required>
          <option value="">{orgs.isLoading ? 'Loading organizations' : 'Choose an organization'}</option>
          {orgs.data?.filter((o) => o.id !== fromOrgId).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
      </label>
      {orgs.isError && <p role="alert" className="cb-refusal">Organizations could not load.</p>}
      <label className="cb-check"><input type="checkbox" checked={moveContent} onChange={(e) => setMoveContent(e.target.checked)} />Move their files and links too</label>
      <label className="cb-check"><input type="checkbox" checked={leave} onChange={(e) => setLeave(e.target.checked)} />Remove from {fromOrgName}</label>
      {error && <p role="alert" className="cb-refusal">{error}</p>}
      <div className="cb-form-actions"><Button type="button" variant="ghost" onClick={onClose}>Cancel</Button><Button type="submit" disabled={!to}>Review move</Button></div>
    </form>}
    {step === 'confirm' && dest && <div className="cb-form">
      <ul className="cb-summary">
        <li><strong>{row.name}</strong> joins <strong>{dest.name}</strong> with the same role.</li>
        <li>{moveContent ? `Their files and links in ${fromOrgName} move to ${dest.name}.` : `Their files and links stay in ${fromOrgName}.`}</li>
        <li>{leave ? `They leave ${fromOrgName}.` : `They stay a member of ${fromOrgName} too.`}</li>
      </ul>
      <div className="cb-form-actions"><Button type="button" variant="ghost" onClick={() => setStep('form')}>Back</Button><Button onClick={() => void run()} isLoading={busy}>Move {row.name}</Button></div>
    </div>}
    {step === 'done' && <div className="cb-form"><p role="status" className="cb-ok">{row.name} is now in {dest?.name}.</p><div className="cb-form-actions"><Button onClick={onClose}>Done</Button></div></div>}
  </Modal>;
}
