import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { orgApi, type ReportingFilters } from '../api/org';
import { useOrgContext } from '../hooks/useOrgContext';
import { apiErrorDetail, apiErrorStatus } from '../api/_shared';
import { Button } from './ui';

export function ReportingSummary() {
  const { canReport, canShare, profile, orgId } = useOrgContext();
  const [draft, setDraft] = useState({ team: '', user: '', kind: '', from: '', to: '' });
  const [filters, setFilters] = useState<ReportingFilters>({});
  const [validation, setValidation] = useState('');
  const query = useQuery({ queryKey: ['org-reporting', orgId, profile?.report_scope, filters], queryFn: () => orgApi.reporting(filters), enabled: canReport, retry: false });
  return <section className="cb-panel"><h2>Sharing activity</h2><p>Scope: {profile?.report_scope ?? 'checking'}. Filters narrow this scope; they never grant more access.</p>
    {!canShare && <p>Read-only reporting. Creating shares and changing organization settings are not permitted in this workspace.</p>}
    <form onSubmit={(event) => { event.preventDefault(); if (draft.from && draft.to && draft.from > draft.to) { setValidation('The start date must be on or before the end date.'); return; } setValidation(''); setFilters({ team: draft.team || undefined, user: draft.user || undefined, kind: draft.kind || undefined, from: draft.from ? `${draft.from}T00:00:00.000Z` : undefined, to: draft.to ? `${draft.to}T23:59:59.999Z` : undefined }); }}>
      <div className="cb-form-grid">
        <label>Team leader ID<input value={draft.team} disabled={profile?.report_scope === 'own'} onChange={(event) => setDraft({ ...draft, team: event.target.value })} placeholder="All permitted teams" /></label>
        <label>Member ID<input value={draft.user} disabled={profile?.report_scope === 'own'} onChange={(event) => setDraft({ ...draft, user: event.target.value })} placeholder="All permitted members" /></label>
        <label>Share type<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value })}><option value="">All types</option><option value="file">Files</option><option value="page">Pages</option><option value="link">Links</option></select></label>
        <label>From (UTC)<input type="date" value={draft.from} onChange={(event) => setDraft({ ...draft, from: event.target.value })} /></label>
        <label>Through (UTC)<input type="date" value={draft.to} onChange={(event) => setDraft({ ...draft, to: event.target.value })} /></label>
      </div><Button type="submit">Apply filters</Button>
    </form>
    {validation && <p role="alert">{validation}</p>}
    {query.isFetching ? <p role="status">Loading scoped report…</p> : query.error ? <div role="alert"><p>{apiErrorStatus(query.error) === 403 ? 'This filter or report is outside your granted scope.' : apiErrorDetail(query.error) ?? 'Report unavailable. No zero totals are inferred.'}</p><Button onClick={() => void query.refetch()}>Retry report</Button></div> : query.data && <>
      <dl className="cb-totals"><div><dt>Shares created</dt><dd>{query.data.totals.shares_created}</dd></div><div><dt>File and page opens</dt><dd>{query.data.totals.opens}</dd></div><div><dt>Link clicks</dt><dd>{query.data.totals.clicks}</dd></div></dl>
      <p>Email sends: not measured. {query.data.emails_sent.note}</p>
      <div className="cb-table-scroll"><table><caption>Activity by member within the selected scope and dates</caption><thead><tr><th>Member</th><th>Shares created</th><th>Opens</th><th>Clicks</th></tr></thead><tbody>{query.data.by_member.map((m) => <tr key={m.user_id}><th scope="row">{m.full_name ?? m.user_id}<small>{m.user_id}</small></th><td>{m.shares_created}</td><td>{m.opens}</td><td>{m.clicks}</td></tr>)}</tbody></table></div>
      {!query.data.by_member.length && <p>No activity in this scope and time window.</p>}
    </>}
  </section>;
}
