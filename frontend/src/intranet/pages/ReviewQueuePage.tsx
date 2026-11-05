import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '../../components/ui';
import { formatRelative } from '../../lib/format';
import { intranetApi, type Transfer } from '../api';
import { PageHeader, QueryState } from '../components';
import { TRANSFER_KEYS, errorText, fileLine, personName, useMe } from '../shared';

function formatAge(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.max(1, Math.floor(seconds / 60))}m`;
}

function ReviewItem({ t, isOwn, defaultDays, onDone }: { t: Transfer; isOwn: boolean; defaultDays: number; onDone: (msg: string) => Promise<void> }) {
  const allowedDays = t.requested_expires_in_days ?? defaultDays;
  const [days, setDays] = useState(String(allowedDays));
  const [oneTime, setOneTime] = useState(t.requested_one_time);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'idle' | 'reject'>('idle');
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

  return (
    <article className="cb-panel" aria-labelledby={`review-${t.id}`}>
      <h2 id={`review-${t.id}`}>{fileLine(t)}</h2>
      <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
        <div><dt className="cb-help">From</dt><dd>{personName(t.submitter)}</dd></div>
        <div><dt className="cb-help">To</dt><dd>{personName(t.recipient)}</dd></div>
        <div><dt className="cb-help">Waiting</dt><dd>{formatAge(t.age_seconds)}{t.state === 'in_review' ? ' · opened by a Reviewer' : ''}</dd></div>
        <div><dt className="cb-help">Auto-expires if undecided</dt><dd>{formatRelative(t.hard_expires_at, 'not set')}</dd></div>
        <div><dt className="cb-help">Requested limits</dt><dd>{allowedDays} days{t.requested_one_time ? ' · one-time' : ''}</dd></div>
        <div><dt className="cb-help">SHA-256</dt><dd style={{ overflowWrap: 'anywhere' }}>{t.sha256 ?? 'computing…'}</dd></div>
      </dl>
      <p><strong>Purpose:</strong> {t.purpose}</p>
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => intranetApi.reject(t.id, reason.trim()), 'Rejected.');
            }}
          >
            <label>
              Reason (shown to the submitter)
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
              <Button type="submit" variant="danger" disabled={!reason.trim()}>Reject</Button>
              <Button type="button" variant="ghost" onClick={() => setMode('idle')}>Cancel</Button>
            </div>
          </form>
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

export function ReviewQueuePage() {
  const me = useMe();
  const client = useQueryClient();
  const queue = useQuery({ queryKey: ['intranet-queue'], queryFn: () => intranetApi.queue(), refetchInterval: 30_000 });
  const [notice, setNotice] = useState('');

  async function done(message: string) {
    setNotice(message);
    await Promise.all(TRANSFER_KEYS.map((queryKey) => client.invalidateQueries({ queryKey })));
  }

  return (
    <div className="cb-workspace">
      <PageHeader title="Review queue">
        <p>Oldest first. Opening a file is recorded in the decision log. Rejections need a reason, which the submitter sees.</p>
      </PageHeader>
      <QueryState isLoading={queue.isLoading} error={queue.error} label="the review queue" />
      {notice && <p role="status">{notice}</p>}
      {queue.data && queue.data.length === 0 && <p>Nothing is waiting for review.</p>}
      {queue.data?.map((t) => (
        <ReviewItem
          key={t.id}
          t={t}
          isOwn={t.submitter.user_id === me.data?.user.user_id}
          defaultDays={me.data?.settings.default_expiry_days ?? 7}
          onDone={done}
        />
      ))}
    </div>
  );
}
