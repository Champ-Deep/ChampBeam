import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, useConfirm } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { intranetApi, type Member, type ReviewSettings } from '../api';
import { PageHeader, QueryState } from '../components';
import { ME_KEY, errorText, personName, useMe, useMembers } from '../shared';

function SettingsForm({ initial, maxExpiry, onSaved }: { initial: ReviewSettings; maxExpiry: number; onSaved: (msg: string) => Promise<void> }) {
  const [defaultDays, setDefaultDays] = useState(String(initial.default_expiry_days));
  const [hardDays, setHardDays] = useState(String(initial.hard_expiry_days));
  const [reminder, setReminder] = useState(initial.reminder_hours ? String(initial.reminder_hours) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await intranetApi.saveReviewSettings({
        default_expiry_days: Number(defaultDays),
        hard_expiry_days: Number(hardDays),
        ...(reminder ? { reminder_hours: Number(reminder) } : {}),
      });
      await onSaved('Review settings saved.');
    } catch (err) {
      setError(errorText(err, 'Saving failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void save(e)}>
      <fieldset disabled={busy}>
        <div className="cb-form-grid">
          <label>Default access window after release (days)<input type="number" min={1} max={maxExpiry} required value={defaultDays} onChange={(e) => setDefaultDays(e.target.value)} /></label>
          <label>Undecided submissions expire after (days)<input type="number" min={1} max={90} required value={hardDays} onChange={(e) => setHardDays(e.target.value)} /></label>
          <label>Reviewer reminder after (hours)<input type="number" min={1} max={168} value={reminder} onChange={(e) => setReminder(e.target.value)} /></label>
          <label>
            Review agent
            <select value="off" disabled>
              <option value="off">Off (not available in this release)</option>
            </select>
          </label>
        </div>
        <p className="cb-help">Every change here is written to the decision log.</p>
        <Button type="submit" isLoading={busy}>Save settings</Button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

export function AdminPage() {
  const me = useMe();
  const members = useMembers();
  const client = useQueryClient();
  const confirm = useConfirm();
  const invites = useQuery({ queryKey: ['intranet-invites'], queryFn: () => intranetApi.invites() });
  const settings = useQuery({ queryKey: ['intranet-review-settings'], queryFn: () => intranetApi.reviewSettings() });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function refresh(message: string) {
    setNotice(message);
    await Promise.all(
      [['intranet-members'], ['intranet-invites'], ['intranet-review-settings'], ME_KEY, ['intranet-log']].map((queryKey) =>
        client.invalidateQueries({ queryKey }),
      ),
    );
  }

  async function change(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh(message);
    } catch (err) {
      setError(errorText(err, 'Change failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(m: Member) {
    if (m.active && !(await confirm({ message: `Deactivate ${personName(m)}? They lose access immediately. Their history stays in the log.`, confirmLabel: 'Deactivate' }))) return;
    await change(() => intranetApi.updateMember(m.user_id, { active: !m.active }), m.active ? 'Member deactivated.' : 'Member reactivated.');
  }

  const myId = me.data?.user.user_id;
  return (
    <div className="cb-workspace">
      <PageHeader title="Administration">
        <p>Invite people, assign Reviewers and set the review rules for {me.data?.organization.name ?? 'this organization'}. Public sign-up is off: only invited emails can join.</p>
      </PageHeader>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}

      <section className="cb-panel">
        <h2>Invite a member</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void change(async () => { await intranetApi.invite(email.trim(), role); setEmail(''); }, 'Invitation sent. It expires in 7 days.');
          }}
        >
          <fieldset disabled={busy}>
            <div className="cb-form-grid">
              <label>Work email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
              <label>
                Role
                <select value={role} onChange={(e) => setRole(e.target.value as 'member' | 'admin')}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </label>
            </div>
            <Button type="submit" disabled={!email.trim()}>Send invitation</Button>
          </fieldset>
        </form>
        <QueryState isLoading={invites.isLoading} error={invites.error} label="invitations" />
        {invites.data && invites.data.length > 0 && (
          <div className="cb-table-scroll">
            <table>
              <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Expires</th><th></th></tr></thead>
              <tbody>
                {invites.data.map((i) => (
                  <tr key={i.id}>
                    <th scope="row">{i.email}</th>
                    <td>{i.role}</td>
                    <td>{i.status}</td>
                    <td>{i.status === 'pending' ? formatRelative(i.expires_at) : '—'}</td>
                    <td>{i.status === 'pending' && <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(() => intranetApi.revokeInvite(i.id), 'Invitation revoked.')}>Revoke</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cb-panel">
        <h2>Members</h2>
        <p className="cb-help">Reviewers see the queue and decide submissions. A Reviewer can never decide their own submission. Deactivating also removes the person from the organization in Clerk, so bringing them back needs a new invitation.</p>
        <QueryState isLoading={members.isLoading} error={members.error} label="members" />
        {members.data && (
          <div className="cb-table-scroll">
            <table>
              <thead><tr><th>Member</th><th>Role</th><th>Reviewer</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {members.data.map((m) => (
                  <tr key={m.user_id}>
                    <th scope="row">{personName(m)}{m.email && m.full_name && <small>{m.email}</small>}</th>
                    <td>{m.is_admin ? 'Admin' : 'Member'}</td>
                    <td>
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={m.is_reviewer}
                          disabled={busy || !m.active}
                          onChange={(e) => void change(() => intranetApi.updateMember(m.user_id, { is_reviewer: e.target.checked }), 'Reviewer role updated.')}
                        />
                        <span className="sr-only">Reviewer</span>
                      </label>
                    </td>
                    <td>{m.active ? 'Active' : 'Deactivated'}</td>
                    <td>
                      {m.user_id !== myId && (
                        <div className="cb-actions">
                          {m.active && (
                            <Button size="sm" variant="outline" disabled={busy} onClick={() => void change(() => intranetApi.updateMember(m.user_id, { role: m.is_admin ? 'member' : 'admin' }), 'Role updated.')}>
                              {m.is_admin ? 'Make member' : 'Make admin'}
                            </Button>
                          )}
                          <Button size="sm" variant={m.active ? 'danger' : 'outline'} disabled={busy} onClick={() => void toggleActive(m)}>
                            {m.active ? 'Deactivate' : 'Reactivate'}
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="cb-panel">
        <h2>Review settings</h2>
        <QueryState isLoading={settings.isLoading} error={settings.error} label="review settings" />
        {settings.data && me.data && (
          <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} maxExpiry={me.data.limits.max_expiry_days} onSaved={refresh} />
        )}
      </section>
    </div>
  );
}
