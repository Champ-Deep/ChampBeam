import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { intranetApi, type Transfer } from '../api';
import { PageHeader, QueryState } from '../components';
import { TRANSFER_KEYS, errorText, fileLine, personName, scanLabel, useMe } from '../shared';

function formatAge(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function agentWindow(t: Transfer, agentOn: boolean): string | null {
  if (!agentOn || !t.agent_window_ends_at) return null;
  if (t.escalated_at) return 'Escalated by the agent';
  const ends = new Date(t.agent_window_ends_at);
  return ends.getTime() > Date.now() ? `Agent may decide ${formatRelative(t.agent_window_ends_at)}` : 'Agent review pending';
}

function Flags({ t }: { t: Transfer }) {
  const flags: { label: string; tone: string }[] = [];
  if (t.scan_status !== 'clean') flags.push({ label: scanLabel(t), tone: '#92400e' });
  if (t.escalated_at) flags.push({ label: 'Escalated', tone: '#991b1b' });
  else if (t.reminded_at) flags.push({ label: 'Overdue', tone: '#991b1b' });
  if (!flags.length) return null;
  return (
    <p className="flex flex-wrap gap-2">
      {flags.map((f) => (
        <span key={f.label} className="rounded-md border px-2 py-0.5 text-sm font-semibold" style={{ color: f.tone, borderColor: f.tone }}>
          {f.label}
        </span>
      ))}
    </p>
  );
}

function ReasonForm({ label, submitLabel, onSubmit, onCancel }: { label: string; submitLabel: string; onSubmit: (reason: string) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason.trim());
      }}
    >
      <label>
        {label}
        <textarea
          required
          rows={3}
          maxLength={1000}
          className="block w-full rounded-md border p-2"
          style={{ borderColor: 'var(--cb-border-strong)' }}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <div className="cb-actions">
        <Button type="submit" variant="danger" disabled={!reason.trim()}>{submitLabel}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function useAction(onDone: (msg: string) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    try {
      await action();
      await onDone(message);
    } catch (err) {
      setError(errorText(err, 'That action failed.'));
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, run };
}

function ReviewItem({ t, isOwn, defaultDays, agentOn, onDone }: { t: Transfer; isOwn: boolean; defaultDays: number; agentOn: boolean; onDone: (msg: string) => Promise<void> }) {
  const allowedDays = t.requested_expires_in_days ?? defaultDays;
  const [days, setDays] = useState(String(allowedDays));
  const [oneTime, setOneTime] = useState(t.requested_one_time);
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
  const { busy, error, run } = useAction(onDone);
  const windowLine = agentWindow(t, agentOn);

  return (
    <article className="cb-panel" aria-labelledby={`review-${t.id}`}>
      <h2 id={`review-${t.id}`}>{fileLine(t)}</h2>
      <Flags t={t} />
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt className="cb-help">From</dt><dd>{personName(t.submitter)}</dd></div>
        <div><dt className="cb-help">To</dt><dd>{personName(t.recipient)}</dd></div>
        <div><dt className="cb-help">Waiting</dt><dd>{formatAge(t.age_seconds)}{t.state === 'in_review' ? ' · opened by a Reviewer' : ''}</dd></div>
        <div><dt className="cb-help">Auto-expires if undecided</dt><dd>{formatRelative(t.hard_expires_at, 'not set')}</dd></div>
        <div><dt className="cb-help">Requested limits</dt><dd>{allowedDays} days{t.requested_one_time ? ' · one-time' : ''}</dd></div>
        <div><dt className="cb-help">Malware scan</dt><dd>{scanLabel(t)}</dd></div>
        <div className="sm:col-span-2"><dt className="cb-help">SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{t.sha256 ?? 'computing…'}</dd></div>
        {windowLine && <div><dt className="cb-help">Review agent</dt><dd>{windowLine}</dd></div>}
      </dl>
      <p><strong>Purpose:</strong> {t.purpose}</p>
      {t.escalation_reason && (
        <p role="note">
          <strong>Agent escalated:</strong> {t.escalation_reason}
          {t.agent_result?.reasons.length ? ` (${t.agent_result.reasons.join('; ')})` : ''}
        </p>
      )}
      {isOwn && <p role="note">You submitted this file, so another Reviewer must decide it.</p>}
      <fieldset disabled={busy}>
        <div className="cb-actions">
          <Button variant="outline" onClick={() => void run(() => intranetApi.download(t.id, 'review'), 'Opened for review.')}>Open file</Button>
        </div>
        {!isOwn && mode === 'idle' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => intranetApi.approve(t.id, { expires_in_days: Number(days), one_time: oneTime }), 'Approved and released.');
            }}
          >
            <div className="cb-form-grid">
              <label>
                Access ends after (days)
                <input type="number" min={1} max={allowedDays} value={days} onChange={(e) => setDays(e.target.value)} required />
              </label>
              <label className="flex items-center gap-2 self-end">
                <input type="checkbox" checked={oneTime} disabled={t.requested_one_time} onChange={(e) => setOneTime(e.target.checked)} />
                One-time download
              </label>
            </div>
            <div className="cb-actions">
              <Button type="submit">Approve and release</Button>
              <Button type="button" variant="danger" onClick={() => setMode('reject')}>Reject…</Button>
            </div>
          </form>
        )}
        {!isOwn && mode === 'reject' && (
          <ReasonForm
            label="Reason (shown to the submitter)"
            submitLabel="Reject"
            onSubmit={(reason) => void run(() => intranetApi.reject(t.id, reason), 'Rejected.')}
            onCancel={() => setMode('idle')}
          />
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

function AgentApproval({ t, isOwn, onDone }: { t: Transfer; isOwn: boolean; onDone: (msg: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction(onDone);
  return (
    <tr>
      <th scope="row">{fileLine(t)}<small>{t.purpose}</small></th>
      <td>{personName(t.submitter)} → {personName(t.recipient)}</td>
      <td>
        {formatRelative(t.released_at)}
        {t.agent_result && <small>{t.agent_result.provider} · confidence {t.agent_result.p_approve.toFixed(2)}</small>}
      </td>
      <td>
        <fieldset disabled={busy}>
          {isOwn ? (
            <span className="cb-help">Your submission</span>
          ) : open ? (
            <ReasonForm
              label="Reason for overturning"
              submitLabel="Overturn"
              onSubmit={(reason) => void run(() => intranetApi.overturn(t.id, reason), 'Agent approval overturned.')}
              onCancel={() => setOpen(false)}
            />
          ) : (
            <Button size="sm" variant="danger" onClick={() => setOpen(true)}>Overturn…</Button>
          )}
        </fieldset>
        {error && <p role="alert">{error}</p>}
      </td>
    </tr>
  );
}

export function ReviewQueuePage() {
  const me = useMe();
  const client = useQueryClient();
  const queue = useQuery({ queryKey: ['intranet-queue'], queryFn: () => intranetApi.queue(), refetchInterval: 30_000 });
  const agentApproved = useQuery({ queryKey: ['intranet-agent-approved'], queryFn: () => intranetApi.agentApproved(), refetchInterval: 60_000 });
  const [notice, setNotice] = useState('');
  const agentOn = (me.data?.settings.agent_mode ?? 'off') !== 'off';
  const myId = me.data?.user.user_id;

  async function done(message: string) {
    setNotice(message);
    await Promise.all(
      [...TRANSFER_KEYS, ['intranet-agent-approved']].map((queryKey) => client.invalidateQueries({ queryKey })),
    );
  }

  return (
    <div className="cb-workspace">
      <PageHeader title="Review queue">
        <p>
          Oldest first. Opening a file is recorded in the decision log. Rejections need a reason, which the submitter sees.
          {agentOn && ` The review agent may approve files that wait longer than ${me.data?.settings.agent_window_hours ?? 24} hours, if it is confident enough. Otherwise it escalates them back here.`}
        </p>
      </PageHeader>
      <QueryState isLoading={queue.isLoading} error={queue.error} label="the review queue" />
      {notice && <p role="status">{notice}</p>}
      {queue.data && queue.data.length === 0 && <p>Nothing is waiting for review.</p>}
      {queue.data?.map((t) => (
        <ReviewItem
          key={t.id}
          t={t}
          isOwn={t.submitter.user_id === myId}
          defaultDays={me.data?.settings.default_expiry_days ?? 7}
          agentOn={agentOn}
          onDone={done}
        />
      ))}
      {agentApproved.data && agentApproved.data.length > 0 && (
        <section className="cb-panel">
          <h2>Approved by the agent, not yet opened</h2>
          <p className="cb-help">A Reviewer can overturn an agent approval until the recipient opens the file.</p>
          <div className="cb-table-scroll">
            <table>
              <thead><tr><th>File</th><th>From → To</th><th>Released</th><th></th></tr></thead>
              <tbody>
                {agentApproved.data.map((t) => (
                  <AgentApproval key={t.id} t={t} isOwn={t.submitter.user_id === myId} onDone={done} />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
