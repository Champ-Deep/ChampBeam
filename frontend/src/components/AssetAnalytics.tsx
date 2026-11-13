import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FileText, Globe, ArrowUpRight, LoaderCircle } from 'lucide-react';
import { api } from '../api/client';
import { DateRangePicker } from './ui/DateRangePicker';
import { Button } from './ui/Button';
import type { DateRangeOpts } from '../api/utm';
import { apiErrorDetail } from '../api/_shared';

type Breakdown = { label: string; opens: number };
interface AssetReport {
  summary: { opens: number; unique_visitors: number; returning_opens: number; page_opens: number; file_opens: number; asset_count: number };
  assets: { id: string; filename: string; asset_type: 'file' | 'page'; opens: number; unique_visitors: number; returning_opens: number; last_opened_at: string | null }[];
  daily: { day: string; opens: number }[];
  hours: { weekday: number; hour: number; opens: number }[];
  countries: Breakdown[]; devices: Breakdown[]; referrers: Breakdown[]; companies: Breakdown[];
  meta: { timezone: string; visitor_basis: string; filtering: string; asset_limit: number };
}

function BreakdownList({ title, rows, total }: { title: string; rows: Breakdown[]; total: number }) {
  return <section className="beam-breakdown"><h3>{title}</h3>{rows.length ? <ol>{rows.map((r) => <li key={r.label}>
    <div><span title={r.label}>{r.label}</span><strong>{r.opens.toLocaleString()}</strong></div>
    <meter min={0} max={Math.max(total, 1)} value={r.opens} aria-label={`${r.label}: ${r.opens} opens`} />
  </li>)}</ol> : <p className="cb-help">No recorded data for this range.</p>}</section>;
}

/** Composition reference: 21st.dev Advanced Stats (19070); house Recharts, no demo metrics. */
export function AssetAnalytics({ scope = 'own' }: { scope?: 'own' | 'workspace' }) {
  const [range, setRange] = useState<DateRangeOpts>({ days: 30 });
  const [type, setType] = useState<'all' | 'file' | 'page'>('all');
  const report = useQuery({
    queryKey: ['asset-analytics', scope, range],
    queryFn: async () => (await api.get<AssetReport>('/analytics/assets', { params: {
      scope, days: range.days, start_date: range.startDate, end_date: range.endDate,
    } })).data,
  });
  const data = report.data;
  const busiest = data?.hours.reduce<{weekday:number;hour:number;opens:number} | null>((best, h) => !best || h.opens > best.opens ? h : best, null);
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return <section className="beam-analytics" aria-label="Files and pages analytics">
    <header className="beam-report-header"><div><p className="beam-eyebrow">{scope === 'workspace' ? 'Workspace engagement' : 'Your content, in this workspace'}</p><h2>What gets opened.</h2><p className="cb-help">Files and pages first. See what earns attention, where and when.</p></div><DateRangePicker onRangeChange={setRange} /></header>
    {report.isLoading ? <div className="beam-pending" role="status"><LoaderCircle className="motion-safe:animate-spin" aria-hidden="true" />Loading content engagement...</div>
      : report.isError ? <div className="beam-pending" role="alert"><p>{apiErrorDetail(report.error) ?? 'Analytics could not load. Your content is unchanged.'}</p><Button onClick={() => void report.refetch()}>Retry analytics</Button></div>
      : data && <>
        <dl className="beam-metrics">
          {([['File opens', data.summary.file_opens], ['Page opens', data.summary.page_opens], ['Estimated visitors', data.summary.unique_visitors], ['Returning opens', data.summary.returning_opens]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{(value ?? 0).toLocaleString()}</dd></div>)}
        </dl>
        {data.summary.opens === 0 ? <div className="beam-pending"><h3>No opens in this date range</h3><p>Share a file or page, or choose a wider range.</p><Link to="/">Share something</Link></div> : <>
          <div className="beam-chart-grid"><section className="beam-chart"><h3>Opens over time</h3><p className="cb-help">Recorded opens per day, UTC</p><ResponsiveContainer width="100%" height={240}><AreaChart data={data.daily} margin={{ right: 16, left: -20 }}><CartesianGrid vertical={false} stroke="var(--cb-border)" /><XAxis dataKey="day" tick={{ fill: 'var(--cb-muted)', fontSize: 12 }} /><YAxis allowDecimals={false} tick={{ fill: 'var(--cb-muted)' }} /><Tooltip contentStyle={{ background: 'var(--cb-surface)', borderColor: 'var(--cb-border)', color: 'var(--cb-ink)' }} /><Area dataKey="opens" name="Opens" stroke="var(--cb-accent)" fill="var(--cb-accent-soft)" isAnimationActive={false} /></AreaChart></ResponsiveContainer></section>
          <aside className="beam-timing"><p className="beam-eyebrow">Busiest recorded hour</p><strong>{busiest ? `${String(busiest.hour).padStart(2, '0')}:00` : 'Not enough data'}</strong><p>{busiest && `${weekdays[busiest.weekday]}, UTC`}</p><p className="cb-help">{busiest?.opens ?? 0} opens in this weekday/hour bucket. This describes this range, not a prediction of the best send time.</p></aside></div>
          <details className="beam-hour-details"><summary>Opening hours by weekday, UTC</summary><div className="beam-hour-grid" role="table" aria-label="Opens by weekday and hour">{weekdays.map((day, weekday) => <div role="row" key={day}><strong role="rowheader">{day.slice(0,3)}</strong>{Array.from({length:24}, (_, hour) => { const opens = data.hours.find(h=>h.weekday===weekday && h.hour===hour)?.opens ?? 0; return <span role="cell" key={hour} title={`${day} ${hour}:00 UTC: ${opens} opens`} style={{ background: opens ? 'var(--cb-accent-soft)' : 'var(--cb-chip)' }}>{opens || '·'}</span>; })}</div>)}</div></details>
        </>}
        <section className="beam-ranking"><header><div><h3>Most-opened files and pages</h3><p className="cb-help">Top {data.meta.asset_limit}, ranked within the selected date range. {data.summary.asset_count} assets in scope.</p></div><label>Show<select value={type} onChange={e => setType(e.target.value as typeof type)}><option value="all">Files and pages</option><option value="file">Files</option><option value="page">Pages</option></select></label></header>
          <ol>{data.assets.filter(a=>type==='all'||a.asset_type===type).map((a, i) => <li key={a.id}><span className="beam-rank">{i+1}</span>{a.asset_type==='page'?<Globe aria-hidden="true" />:<FileText aria-hidden="true" />}<Link to={`/${a.asset_type==='page'?'pages':'files'}/${a.id}/analytics`}><strong>{a.filename}</strong><span>{a.asset_type === 'page' ? 'Page' : 'File'} · {a.unique_visitors} estimated visitors · {a.returning_opens} returning opens</span></Link><div className="beam-open-count"><strong>{a.opens.toLocaleString()}</strong><span>opens</span></div><ArrowUpRight aria-hidden="true" /></li>)}</ol>
          {data.assets.filter(a=>type==='all'||a.asset_type===type).length === 0 && <p>No matching assets in the top {data.meta.asset_limit}.</p>}
        </section>
        <div className="beam-breakdowns"><BreakdownList title="Where opens come from" rows={data.countries} total={data.summary.opens} /><BreakdownList title="Devices" rows={data.devices} total={data.summary.opens} /><BreakdownList title="Referrers" rows={data.referrers} total={data.summary.opens} /><BreakdownList title="Company signals" rows={data.companies} total={data.summary.opens} /></div>
        <details className="beam-method"><summary>How these numbers are counted</summary><p>{data.meta.visitor_basis}</p><p>{data.meta.filtering} Returning opens are revisit events, not a count of named people. Company signals are inferred from stored network enrichment, never a verified person.</p><p>Page dwell and session details remain in each page's Analytics. Downloads do not prove reading time. Breakdown rows show up to ten groups; meters use all opens as their denominator.</p></details>
      </>}
  </section>;
}
