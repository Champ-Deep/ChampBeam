import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui';
import { intranetApi, type LogFilters } from '../api';
import { PageHeader, QueryState } from '../components';
import { errorText, personName, useMembers } from '../shared';

const EVENTS = [
  'submitted', 'check_failed', 'opened_for_review', 'opened_by_submitter', 'approved', 'rejected', 'escalated',
  'released', 'opened_by_recipient', 'consumed', 'expired', 'revoked', 'withdrawn', 'member_invited',
  'invite_revoked', 'invite_expired', 'member_updated', 'member_deactivated', 'member_reactivated', 'settings_changed',
];

const PAGE_SIZE = 100;

function toIsoStart(date: string): string | undefined {
  return date ? `${date}T00:00:00Z` : undefined;
}

function toIsoEnd(date: string): string | undefined {
  return date ? `${date}T23:59:59Z` : undefined;
}

export function DecisionLogPage() {
  const members = useMembers();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [event, setEvent] = useState('');
  const [actor, setActor] = useState('');
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState('');
  const [verify, setVerify] = useState<string>('');

  const filters: LogFilters = { start: toIsoStart(start), end: toIsoEnd(end), event, actor_id: actor };
  const log = useQuery({
    queryKey: ['intranet-log', start, end, event, actor, offset],
    queryFn: () => intranetApi.log({ ...filters, limit: PAGE_SIZE, offset }),
  });

  async function runVerify() {
    setVerify('');
    setError('');
    try {
      const result = await intranetApi.verifyLog();
      setVerify(result.ok ? `Chain intact: ${result.rows} rows verified.` : `Chain broken at row ${result.first_bad_id}. Escalate to IT.`);
    } catch (err) {
      setError(errorText(err, 'Verification failed.'));
    }
  }

  async function exportCsv() {
    setError('');
    try {
      await intranetApi.exportLog(filters);
    } catch (err) {
      setError(errorText(err, 'Export failed.'));
    }
  }

  const total = log.data?.total ?? 0;
  return (
    <div className="cb-workspace">
      <PageHeader title="Decision log">
        <p>Append-only record of every submission, review decision, release, download and admin change. Each row is hash-chained to the previous one, so edits are detectable.</p>
      </PageHeader>
      <form className="cb-panel" onSubmit={(e) => e.preventDefault()}>
        <div className="cb-form-grid">
          <label>From<input type="date" value={start} onChange={(e) => { setStart(e.target.value); setOffset(0); }} /></label>
          <label>To<input type="date" value={end} onChange={(e) => { setEnd(e.target.value); setOffset(0); }} /></label>
          <label>
            Event
            <select value={event} onChange={(e) => { setEvent(e.target.value); setOffset(0); }}>
              <option value="">All events</option>
              {EVENTS.map((ev) => <option key={ev} value={ev}>{ev.replaceAll('_', ' ')}</option>)}
            </select>
          </label>
          <label>
            Actor
            <select value={actor} onChange={(e) => { setActor(e.target.value); setOffset(0); }}>
              <option value="">Anyone</option>
              <option value="sweeper">System (expiry sweeper)</option>
              {(members.data ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{personName(m)}</option>)}
            </select>
          </label>
        </div>
        <div className="cb-actions">
          <Button type="button" variant="outline" onClick={() => void exportCsv()}>Export CSV</Button>
          <Button type="button" variant="outline" onClick={() => void runVerify()}>Verify chain</Button>
        </div>
        {verify && <p role="status">{verify}</p>}
        {error && <p role="alert">{error}</p>}
      </form>
      <QueryState isLoading={log.isLoading} error={log.error} label="the decision log" />
      {log.data && (
        <>
          <p className="cb-help">{total} matching rows</p>
          <div className="cb-table-scroll">
            <table>
              <thead>
                <tr><th>When (UTC)</th><th>Event</th><th>Actor</th><th>Transfer</th><th>Reason / detail</th><th>Row hash</th></tr>
              </thead>
              <tbody>
                {log.data.items.map((e) => (
                  <tr key={e.id}>
                    <td>{e.at?.replace('T', ' ').replace('Z', '')}</td>
                    <th scope="row">{e.event.replaceAll('_', ' ')}</th>
                    <td>{e.actor_name ?? e.actor_id ?? e.actor_type}</td>
                    <td>{e.transfer_id ? <span title={e.transfer_id}>{e.transfer_id.slice(0, 8)}</span> : '—'}</td>
                    <td>
                      {e.reason}
                      {e.detail && <small>{JSON.stringify(e.detail)}</small>}
                    </td>
                    <td title={e.row_hash}><code>{e.row_hash.slice(0, 12)}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="cb-actions">
            <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Newer</Button>
            <Button variant="outline" disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>Older</Button>
          </div>
        </>
      )}
    </div>
  );
}
