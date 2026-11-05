import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, useConfirm } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { intranetApi, type Member, type ReviewSettings } from '../api';
import { PageHeader, QueryState } from '../components';
import { ME_KEY, errorText, personName, useMe, useMembers } from '../shared';

const AGENT_LABELS: Record<string, string> = { off: 'Off', local: 'Local scorer (Clef)', jev: 'Jev (needs IT sign-off)' };

function SettingsForm({ initial, maxExpiry, agentModes, onSaved }: { initial: ReviewSettings; maxExpiry: number; agentModes: string[]; onSaved: (msg: string) => Promise<void> }) {
  const [defaultDays, setDefaultDays] = useState(String(initial.default_expiry_days));
  const [hardDays, setHardDays] = useState(String(initial.hard_expiry_days));
  const [reminder, setReminder] = useState(initial.reminder_hours ? String(initial.reminder_hours) : '');
  const [agentMode, setAgentMode] = useState(initial.agent_mode);
  const [windowHours, setWindowHours] = useState(String(initial.agent_window_hours));
  const [threshold, setThreshold] = useState(String(initial.agent_threshold));
  const [inputMode, setInputMode] = useState(initial.agent_input_mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const modes = agentModes.includes(initial.agent_mode) ? agentModes : [...agentModes, initial.agent_mode];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const next: Partial<ReviewSettings> = {
        default_expiry_days: Number(defaultDays),
        hard_expiry_days: Number(hardDays),
        ...(reminder ? { reminder_hours: Number(reminder) } : {}),
        agent_mode: agentMode,
        agent_window_hours: Number(windowHours),
        agent_threshold: Number(threshold),
        agent_input_mode: inputMode,
      };
      const changed = Object.fromEntries(
        Object.entries(next).filter(([key, value]) => initial[key as keyof ReviewSettings] !== value),
      ) as Partial<ReviewSettings>;
      await intranetApi.saveReviewSettings(changed);
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
        </div>
        <h3>Review agent</h3>
        <p className="cb-help">
          Off by default. When on, the agent only looks at submissions no human has decided within the wait window. It never rejects:
          it approves when its confidence is at or above the threshold, and otherwise escalates back to Reviewers. Files that are not
          scanned clean, or that were submitted before, always go to a human.
        </p>
        <div className="cb-form-grid">
          <label>
            Agent
            <select value={agentMode} onChange={(e) => setAgentMode(e.target.value)}>
              {modes.map((m) => <option key={m} value={m}>{AGENT_LABELS[m] ?? m}</option>)}
            </select>
          </label>
          <label>Wait window before the agent acts (hours)<input type="number" min={1} max={336} required value={windowHours} onChange={(e) => setWindowHours(e.target.value)} /></label>
          <label>Approval threshold (0.50 to 1.00)<input type="number" min={0.5} max={1} step={0.01} required value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
          <label>
            What the agent sees
            <select value={inputMode} onChange={(e) => setInputMode(e.target.value)}>
              <option value="metadata_only">Metadata only (name, size, type, people, purpose, checks)</option>
              <option value="content_excerpt">Metadata plus the first few KB of text files</option>
            </select>
          </label>
        </div>
        {!agentModes.includes('local') && <p className="cb-help">The local scorer is not configured on this deployment (set CLEF_URL).</p>}
        <p className="cb-help">Every change here is written to the decision log.</p>
        <Button type="submit" isLoading={busy}>Save settings</Button>
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function BenchmarkPanel({ providers }: { providers: string[] }) {
  const client = useQueryClient();
  const runs = useQuery({
    queryKey: ['intranet-benchmarks'],
    queryFn: () => intranetApi.benchmarks(),
    refetchInterval: (query) => (query.state.data?.some((r) => r.status === 'running') ? 3000 : false),
  });
  const [provider, setProvider] = useState(providers[0] ?? '');
  const [error, setError] = useState('');
  const latest = runs.data?.[0];
  const running = runs.data?.some((r) => r.status === 'running');

  async function start() {
    setError('');
    try {
      await intranetApi.startBenchmark(provider);
      await client.invalidateQueries({ queryKey: ['intranet-benchmarks'] });
    } catch (err) {
      setError(errorText(err, 'Could not start the benchmark.'));
    }
  }

  function download(markdown: string) {
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `agent-benchmark-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="cb-panel">
      <h2>Agent benchmark</h2>
      <p className="cb-help">
        Replays past human approve and reject decisions from the decision log through a scorer and reports how often it agrees.
        No pass mark is set here: the agreement needed before switching the agent on is Deep&apos;s call.
      </p>
      {providers.length === 0 ? (
        <p className="cb-help">No scorer is configured on this deployment.</p>
      ) : (
        <div className="cb-actions">
          <label>
            Scorer
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <Button onClick={() => void start()} disabled={running || !provider} isLoading={running}>Run benchmark</Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <QueryState isLoading={runs.isLoading} error={runs.error} label="benchmark runs" />
      {latest && (
        <div>
          <p>
            Latest run ({latest.provider}): <strong>{latest.status}</strong>
            {latest.finished_at && `, ${formatRelative(latest.finished_at)}`}
            {latest.error && <span role="alert"> {latest.error}</span>}
          </p>
          {latest.report && (
            <>
              <p className="cb-help">
                {latest.report.cases} human decisions replayed, {latest.report.scored} scored, {latest.report.errors} errors.
                Humans approved {latest.report.human_approved} and rejected {latest.report.human_rejected}.
              </p>
              <div className="cb-table-scroll">
                <table>
                  <thead><tr><th>Threshold</th><th>Agreement</th><th>Would auto-approve</th><th>False releases</th><th>Missed approvals</th></tr></thead>
                  <tbody>
                    {latest.report.sweep.map((r) => (
                      <tr key={r.threshold}>
                        <th scope="row">{r.threshold.toFixed(2)}{r.threshold === latest.report?.current_threshold ? ' (current)' : ''}</th>
                        <td>{r.agreement == null ? '—' : `${(r.agreement * 100).toFixed(1)}%`}</td>
                        <td>{r.auto_approved}</td>
                        <td>{r.false_releases}</td>
                        <td>{r.missed_approvals}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {latest.markdown && <Button variant="outline" onClick={() => download(latest.markdown ?? '')}>Download report (Markdown)</Button>}
            </>
          )}
        </div>
      )}
    </section>
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
          <SettingsForm key={JSON.stringify(settings.data)} initial={settings.data} maxExpiry={me.data.limits.max_expiry_days} agentModes={me.data.agent.modes} onSaved={refresh} />
        )}
      </section>

      {me.data && <BenchmarkPanel providers={me.data.agent.benchmark_providers} />}
    </div>
  );
}
