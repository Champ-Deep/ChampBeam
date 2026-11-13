import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { authClient } from '../../lib/authClient';
import { inviteLink, ORG_ROLES, ROLE_LABEL, selfServeApi, type OrgRole } from '../../api/selfServe';
import { apiErrorDetail } from '../../api/_shared';
import { Sheet } from '../ui/sheet';
import { Button } from '../ui';
import { CopyButton } from '../ui/copy-with-confirmation';
import { linksBlock } from '../../lib/selfServeRules';

type Row = { key: number; email: string; role: OrgRole };
type Result = { email: string; ok: true; url: string } | { email: string; ok: false; error: string };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });


/**
 * Invite people: email rows with a role each, then either "Invitation sent" (email on) or the accept links to
 * copy (email off), and the pending list. Structure from 21st.dev "Team Invite Sheet" (id 26144) with the
 * copyable link from "Invite Team Card" (id 28202, link part only).
 */
export function InviteSheet({ open, onOpenChange, orgName, emailEnabled }: { open: boolean; onOpenChange: (o: boolean) => void; orgName: string; emailEnabled: boolean }) {
  const client = useQueryClient();
  const [rows, setRows] = useState<Row[]>([{ key: 1, email: '', role: 'member' }]);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useQuery({ queryKey: ['org-invitations'], queryFn: () => selfServeApi.pendingInvitations(), enabled: open });
  const [pendingError, setPendingError] = useState('');
  const [resent, setResent] = useState('');
  const cancel = useMutation({
    mutationFn: async (id: string) => { const { error } = await authClient.organization.cancelInvitation({ invitationId: id }); if (error) throw new Error(error.message || 'Could not cancel.'); },
    onSuccess: () => client.invalidateQueries({ queryKey: ['org-invitations'] }),
    onError: (e) => setPendingError(apiErrorDetail(e) ?? 'Could not cancel the invitation.'),
  });
  const resend = useMutation({
    mutationFn: ({ email, role }: { email: string; role: string }) => selfServeApi.invite(email, role as OrgRole, true),
    onSuccess: (_d, v) => setResent(v.email),
    onError: (e) => setPendingError(apiErrorDetail(e) ?? 'Could not resend the invitation.'),
  });

  const update = (key: number, patch: Partial<Row>) => setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const errs: Record<number, string> = {};
    const seen = new Set<string>();
    const filled = rows.filter((r) => r.email.trim());
    for (const r of filled) {
      const email = r.email.trim().toLowerCase();
      if (!EMAIL.test(email)) errs[r.key] = 'Enter a full email address.';
      else if (seen.has(email)) errs[r.key] = 'This address is already in the list.';
      seen.add(email);
    }
    if (!filled.length && rows[0]) errs[rows[0].key] = 'Add at least one email address.';
    setRowErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    const out: Result[] = [];
    for (const r of filled) {
      const email = r.email.trim().toLowerCase();
      try { const inv = await selfServeApi.invite(email, r.role); out.push({ email, ok: true, url: inviteLink(inv.accept_url, email) }); }
      catch (err) { out.push({ email, ok: false, error: apiErrorDetail(err) ?? 'Could not invite.' }); }
    }
    setBusy(false);
    setResults(out);
    setRows([{ key: Date.now(), email: '', role: 'member' }]);
    void client.invalidateQueries({ queryKey: ['org-invitations'] });
  }

  const sent = results?.filter((r): r is Extract<Result, { ok: true }> => r.ok) ?? [];
  return <Sheet open={open} onOpenChange={(o) => { if (!o) { setResults(null); setRowErrors({}); setPendingError(''); setResent(''); } onOpenChange(o); }} title="Invite people"
    description={emailEnabled ? `They get an email with a link to join ${orgName}. Links expire in 7 days.` : `Email is not switched on yet, so you get a link to send each person yourself. Links expire in 7 days.`}>
    <form noValidate onSubmit={(e) => void submit(e)} className="cb-invite-form">
      {rows.map((r, i) => <div key={r.key} className="cb-invite-row">
        <label className="cb-invite-email"><span className={i ? 'sr-only' : ''}>Email</span>
          <input type="email" className="cb-mono" value={r.email} onChange={(e) => update(r.key, { email: e.target.value })} placeholder="name@company.com" autoComplete="off" aria-invalid={!!rowErrors[r.key]} aria-describedby={rowErrors[r.key] ? `inv-err-${r.key}` : undefined} />
        </label>
        <label className="cb-invite-role"><span className={i ? 'sr-only' : ''}>Role</span>
          <select value={r.role} onChange={(e) => update(r.key, { role: e.target.value as OrgRole })}>{ORG_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select>
        </label>
        {rows.length > 1 ? <button type="button" className="cb-icon-btn" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><X className="h-4 w-4" aria-hidden="true" /></button> : <span aria-hidden="true" />}
        {rowErrors[r.key] && <p id={`inv-err-${r.key}`} className="cb-refusal cb-invite-err">{rowErrors[r.key]}</p>}
      </div>)}
      <button type="button" className="cb-text-btn" onClick={() => setRows((rs) => [...rs, { key: Date.now(), email: '', role: 'member' }])}><Plus className="h-4 w-4" aria-hidden="true" />Add another</button>
      <div className="cb-form-actions"><Button type="submit" isLoading={busy}>{emailEnabled ? 'Send invitations' : rows.filter((r) => r.email.trim()).length > 1 ? `Create ${rows.filter((r) => r.email.trim()).length} invite links` : 'Create invite link'}</Button></div>
    </form>

    {results && <section aria-live="polite" className="cb-invite-results">
      {emailEnabled && sent.length > 0 && <p role="status" className="cb-ok">Invitation sent to {sent.map((s) => s.email).join(', ')}.</p>}
      {!emailEnabled && sent.length > 0 && <>
        <div className="cb-section-head"><h3>Links to send</h3>{sent.length > 1 && <CopyButton text={linksBlock(sent)} label="Copy all" copiedLabel="All copied" />}</div>
        <ul className="cb-ledger-list">{sent.map((s) => <li key={s.email}><span className="cb-mono cb-ellipsis">{s.email}</span><span className="cb-linkbox"><span className="cb-mono cb-ellipsis" title={s.url}>{s.url}</span><CopyButton text={s.url} label="Copy link" /></span></li>)}</ul>
      </>}
      {results.filter((r): r is Extract<Result, { ok: false }> => !r.ok).map((r) => <p key={r.email} role="alert" className="cb-refusal"><span className="cb-mono">{r.email}</span>: {r.error}</p>)}
    </section>}

    <section className="cb-pending" aria-labelledby="pending-h">
      <div className="cb-section-head"><h3 id="pending-h">Pending{pending.data ? ` (${pending.data.length})` : ''}</h3>
        {!emailEnabled && pending.data && pending.data.length > 1 && <CopyButton text={linksBlock(pending.data.map((p) => ({ email: p.email, url: inviteLink(p.accept_url, p.email) })))} label="Copy all" copiedLabel="All copied" />}
      </div>
      {pending.isLoading && <p role="status" className="cb-hint">Loading invitations</p>}
      {pending.isError && <p role="alert" className="cb-refusal">Pending invitations could not load. <button type="button" className="cb-text-btn" onClick={() => void pending.refetch()}>Retry</button></p>}
      {pending.data?.length === 0 && <p className="cb-hint">No open invitations.</p>}
      {pendingError && <p role="alert" className="cb-refusal">{pendingError}</p>}
      {resent && <p role="status" className="cb-ok">Sent again to {resent}.</p>}
      <ul className="cb-ledger-list">{pending.data?.map((p) => <li key={p.id}>
        <span className="cb-pending-who"><span className="cb-mono cb-ellipsis">{p.email}</span><span className="cb-hint">{ROLE_LABEL[p.role] ?? p.role}, expires {fmtDate(p.expires_at)}</span></span>
        <span className="cb-row-actions">
          <CopyButton text={inviteLink(p.accept_url, p.email)} label="Copy link" />
          {emailEnabled && <button type="button" className="cb-text-btn" disabled={resend.isPending} onClick={() => resend.mutate({ email: p.email, role: p.role })}>Resend</button>}
          <button type="button" className="cb-text-btn cb-danger" disabled={cancel.isPending} onClick={() => cancel.mutate(p.id)}>Cancel</button>
        </span>
      </li>)}</ul>
    </section>
  </Sheet>;
}
