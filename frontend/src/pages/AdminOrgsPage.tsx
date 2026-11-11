import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { authClient } from '../lib/authClient';
import { useAppConfig } from '../hooks/useAppConfig';
import { ORG_ROLES, ROLE_LABEL, selfServeApi, type AdminOrg, type OrgRole } from '../api/selfServe';
import { apiErrorDetail, apiErrorStatus } from '../api/_shared';
import { CreateOrgDialog } from '../components/org/CreateOrgDialog';
import { Button } from '../components/ui';

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** Super admin > Organizations: every org with counts, create one with a first admin, add a member, open one. */
export function AdminOrgsPage() {
  const { data: config, isLoading: configLoading } = useAppConfig();
  const allowed = !!config?.is_super_admin;
  const orgs = useQuery({ queryKey: ['admin-orgs'], queryFn: () => selfServeApi.adminOrgs(), enabled: allowed });
  const { data: mine } = authClient.useListOrganizations();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState('');
  const [openRow, setOpenRow] = useState<string | null>(null);
  const [openError, setOpenError] = useState('');

  async function open(org: AdminOrg) {
    setOpenError('');
    try {
      // A member switches normally; otherwise act-as makes this session an admin of the org.
      if (mine?.some((o) => o.id === org.id)) { const { error } = await authClient.organization.setActive({ organizationId: org.id }); if (error) throw new Error(error.message); }
      else await selfServeApi.actAs(org.id);
      window.location.assign('/settings');
    } catch (err) { setOpenError(apiErrorDetail(err) ?? `Could not open ${org.name}.`); }
  }

  if (configLoading) return <div className="cb-workspace"><p role="status">Checking access</p></div>;
  if (!allowed) return <div className="cb-workspace"><h1>Organizations</h1><p role="alert" className="cb-refusal">This page is for platform admins.</p></div>;

  return <div className="cb-workspace">
    <div className="cb-section-head"><div><p className="cb-eyebrow">Platform admin</p><h1>Organizations</h1><p className="cb-hint">{orgs.data ? `${orgs.data.length} organizations on ${config?.platform_host}.` : '\u00a0'}</p></div>
      <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>Create organization</Button></div>
    {created && <p role="status" className="cb-ok">Organization created. Its first admin can sign in again to see it.</p>}
    {openError && <p role="alert" className="cb-refusal">{openError}</p>}
    {orgs.isLoading && <p role="status" className="cb-hint">Loading organizations</p>}
    {orgs.isError && <p role="alert" className="cb-refusal">Organizations could not load. <button type="button" className="cb-text-btn" onClick={() => void orgs.refetch()}>Retry</button></p>}
    {orgs.data?.length === 0 && <p className="cb-hint">No organizations yet. Create the first one.</p>}
    {!!orgs.data?.length && <div className="cb-table-scroll"><table className="cb-ledger">
      <thead><tr><th scope="col">Organization</th><th scope="col" className="cb-num">Members</th><th scope="col" className="cb-num">Files</th><th scope="col" className="cb-num">Links</th><th scope="col">Created</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
      <tbody>{orgs.data.map((o) => <OrgRow key={o.id} org={o} expanded={openRow === o.id} onToggle={() => setOpenRow(openRow === o.id ? null : o.id)} onOpen={() => void open(o)} />)}</tbody>
    </table></div>}
    <CreateOrgDialog open={creating} onOpenChange={setCreating} platformHost={config?.platform_host ?? ''} withFirstAdmin onCreated={(id) => setCreated(id)} />
  </div>;
}

function OrgRow({ org, expanded, onToggle, onOpen }: { org: AdminOrg; expanded: boolean; onToggle: () => void; onOpen: () => void }) {
  const client = useQueryClient();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<OrgRole>('member');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email.trim())) return setMsg({ ok: false, text: 'Enter their email address.' });
    setBusy(true); setMsg(null);
    try {
      await selfServeApi.adminAddMember(org.id, { email: email.trim().toLowerCase(), role });
      setMsg({ ok: true, text: `${email.trim()} added as ${ROLE_LABEL[role]}. They see it after signing in again.` }); setEmail('');
      void client.invalidateQueries({ queryKey: ['admin-orgs'] });
    } catch (err) {
      const s = apiErrorStatus(err);
      setMsg({ ok: false, text: s === 404 ? 'No ChampBeam account uses that email. Ask them to sign up, or invite them from the org.' : s === 409 ? 'Already a member. Change their role from the org\'s Members page.' : apiErrorDetail(err) ?? 'Could not add them.' });
    } finally { setBusy(false); }
  }

  return <>
    <tr>
      <td><span className="cb-who-name">{org.name}</span><span className="cb-mono cb-hint">{org.slug}</span></td>
      <td className="cb-num">{org.members}</td><td className="cb-num">{org.files}</td><td className="cb-num">{org.links}</td>
      <td className="cb-hint">{fmtDate(org.created_at)}</td>
      <td className="cb-row-actions"><button type="button" className="cb-text-btn" aria-expanded={expanded} onClick={onToggle}>Add member</button><button type="button" className="cb-text-btn" onClick={onOpen}>Open</button></td>
    </tr>
    {expanded && <tr className="cb-subrow"><td colSpan={6}>
      <form className="cb-inline-form" noValidate onSubmit={(e) => void add(e)}>
        <label>Email<input type="email" className="cb-mono" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label>
        <label>Role<select value={role} onChange={(e) => setRole(e.target.value as OrgRole)}>{ORG_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></label>
        <Button type="submit" isLoading={busy}>Add to {org.name}</Button>
      </form>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'cb-ok' : 'cb-refusal'}>{msg.text}</p>}
      <p className="cb-hint">To move someone in with their files and links, open their current organization and use Move in its Members list.</p>
    </td></tr>}
  </>;
}
