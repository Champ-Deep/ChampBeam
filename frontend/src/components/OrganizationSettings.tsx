import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { orgApi } from '../api/org';
import { utmApi } from '../api/utm';
import { useOrgContext } from '../hooks/useOrgContext';
import { apiErrorDetail } from '../api/_shared';
import { Button, useConfirm } from './ui';

export function OrganizationSettings() {
  const { permissions, profile, orgId } = useOrgContext();
  const domainsAllowed = permissions.includes('org.domains.manage');
  const membersAllowed = permissions.includes('org.members.manage');
  const grantsAllowed = permissions.includes('org.viewers.grant');
  const client = useQueryClient();
  const confirm = useConfirm();
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [domain, setDomain] = useState('');
  const [member, setMember] = useState('');
  const [leader, setLeader] = useState('');
  const [viewer, setViewer] = useState('');
  const [scope, setScope] = useState<'org' | 'team'>('org');
  const [viewerLeader, setViewerLeader] = useState('');
  const domains = useQuery({ queryKey: ['org-domains', orgId], queryFn: () => orgApi.domains(), enabled: domainsAllowed });
  const owned = useQuery({ queryKey: ['domains', orgId], queryFn: () => utmApi.listDomains(), enabled: domainsAllowed });
  const members = useQuery({ queryKey: ['org-members', orgId], queryFn: () => orgApi.listMembers(), enabled: membersAllowed || grantsAllowed });
  const grants = useQuery({ queryKey: ['org-viewers', orgId], queryFn: () => orgApi.viewers(), enabled: grantsAllowed });
  async function change(action: () => Promise<unknown>, message: string) {
    setBusy(true); setNotice(''); setError('');
    try { await action(); await Promise.all(['org-domains', 'org-profile', 'org-members', 'org-viewers'].map((key) => client.invalidateQueries({ queryKey: [key] }))); setNotice(message); }
    catch (err) { setError(apiErrorDetail(err) ?? 'Change failed. Check access and retry.'); }
    finally { setBusy(false); }
  }
  const memberOptions = (members.data ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.full_name ?? m.email ?? m.user_id} ({m.role})</option>);
  if (!domainsAllowed && !membersAllowed && !grantsAllowed) return <p>Organization administration requires an explicit IT permission. Your reporting access is separate.</p>;
  return <section className="cb-panel"><h2>{profile?.org?.name} administration</h2><p>Server-granted permissions: {permissions.join(', ')}</p>
    {[domains, owned, members, grants].some((q) => q.isLoading) && <p role="status">Loading administration data…</p>}
    {[domains, owned, members, grants].some((q) => q.isError) && <p role="alert">Some administration data could not load. Reload before making changes.</p>}
    <fieldset disabled={busy}>
      {domainsAllowed && <section><h3>Organization domains</h3><p>Only verified domains can be attached. Changing the default affects new shares, not existing addresses.</p>
        <ul>{domains.data?.map((d) => <li key={d.id}>{d.hostname}: {d.status}{d.is_org_default ? ' (default)' : d.status === 'active' && <Button onClick={() => void change(() => orgApi.defaultDomain(d.id), 'Default domain updated.')}>Make default</Button>}</li>)}</ul>
        <form className="cb-actions" onSubmit={(event) => { event.preventDefault(); void change(() => orgApi.attachDomain(domain), 'Domain attached.'); }}><label>Verified domain you own<select required value={domain} onChange={(event) => setDomain(event.target.value)}><option value="">Choose domain</option>{owned.data?.filter((d) => d.status === 'active' && !domains.data?.some((existing) => existing.id === d.id)).map((d) => <option value={d.id} key={d.id}>{d.hostname}</option>)}</select></label><Button type="submit" disabled={!domain}>Attach to organization</Button></form>
      </section>}
      {membersAllowed && <section><h3>Members and teams</h3><p>Assign an existing member to a team leader. The server validates the leader's eligibility. Membership and role provisioning remain in the identity provider.</p>
        <div className="cb-table-scroll"><table><thead><tr><th>Member</th><th>Role</th><th>Leader ID</th></tr></thead><tbody>{members.data?.map((m) => <tr key={m.user_id}><th scope="row">{m.full_name ?? m.email ?? m.user_id}</th><td>{m.role}</td><td>{m.leader_user_id ?? 'Unassigned'}</td></tr>)}</tbody></table></div>
        <form onSubmit={(event) => { event.preventDefault(); void change(() => orgApi.assignMemberLeader(member, leader || null), 'Team assignment saved.'); }}><div className="cb-form-grid"><label>Member<select required value={member} onChange={(event) => setMember(event.target.value)}><option value="">Choose member</option>{memberOptions}</select></label><label>Reports to<select value={leader} onChange={(event) => setLeader(event.target.value)}><option value="">No leader</option>{memberOptions}</select></label></div><Button type="submit" disabled={!member}>Save team assignment</Button></form>
      </section>}
      {grantsAllowed && <section><h3>Read-only reporting permissions</h3><p>A reporting grant does not authorize uploads, domain changes or member management.</p><form onSubmit={(event) => { event.preventDefault(); void change(() => orgApi.grantViewer({ user_id: viewer, scope, leader_user_id: scope === 'team' ? viewerLeader : null }), 'Reporting permission granted.'); }}><div className="cb-form-grid"><label>Viewer<select required value={viewer} onChange={(event) => setViewer(event.target.value)}><option value="">Choose member</option>{memberOptions}</select></label><label>Reporting scope<select value={scope} onChange={(event) => setScope(event.target.value as 'org' | 'team')}><option value="org">Organization</option><option value="team">One team</option></select></label>{scope === 'team' && <label>Team leader<select required value={viewerLeader} onChange={(event) => setViewerLeader(event.target.value)}><option value="">Choose leader</option>{memberOptions}</select></label>}</div><Button type="submit" disabled={!viewer}>Grant read-only reporting</Button></form>
        <ul>{grants.data?.map((g) => <li key={g.id}>{members.data?.find((m) => m.user_id === g.user_id)?.full_name ?? g.user_id}: {g.scope}{g.leader_user_id && ` (${g.leader_user_id})`}<Button onClick={() => { void (async () => { if (await confirm({ message: 'Revoke this reporting permission?', confirmLabel: 'Revoke' })) await change(() => orgApi.revokeViewer(g.id), 'Reporting permission revoked.'); })(); }}>Revoke</Button></li>)}</ul>
      </section>}
    </fieldset>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
