import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Copy, Globe, Monitor, Smartphone, Tablet,
  Eye, Users, Repeat, Timer,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, Button, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { GeoChart } from '../components/ui/GeoChart';
import { pagesApi } from '../api/pages';
import type { BeamPage, PageAnalytics, PageTimelineEvent } from '../api/pages';
import type { DateRangeOpts, GeoBreakdownItem, DeviceBreakdown } from '../api/utm';
import { formatDwell, formatRelative } from '../lib/format';

const TOOLTIP_STYLE = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
};

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info';

const EVENT_BADGE = {
  view: { label: 'View', variant: 'default' },
  revisit: { label: 'Revisit', variant: 'info' },
  comment_added: { label: 'Comment', variant: 'success' },
  state_changed: { label: 'State', variant: 'warning' },
  gate_failed: { label: 'Gate failed', variant: 'danger' },
} as const satisfies Record<string, { label: string; variant: BadgeVariant }>;

function eventBadge(type: string): { label: string; variant: BadgeVariant } {
  return (EVENT_BADGE as Record<string, { label: string; variant: BadgeVariant }>)[type] ?? { label: type, variant: 'default' };
}

function DeviceIcon({ type, className }: { type: string | null; className?: string }) {
  const t = (type || '').toLowerCase();
  if (t.includes('mobile') || t.includes('phone')) return <Smartphone className={className} />;
  if (t.includes('tablet')) return <Tablet className={className} />;
  return <Monitor className={className} />;
}

export function PageAnalyticsPage() {
  const { pageId } = useParams<{ pageId: string }>();
  const navigate = useNavigate();

  const [page, setPage] = useState<BeamPage | null>(null);
  const [summary, setSummary] = useState<PageAnalytics | null>(null);
  const [events, setEvents] = useState<PageTimelineEvent[]>([]);
  const [geoBreakdown, setGeoBreakdown] = useState<GeoBreakdownItem[]>([]);
  const [geoLevel, setGeoLevel] = useState<'country' | 'region' | 'city'>('country');
  const [deviceBreakdown, setDeviceBreakdown] = useState<DeviceBreakdown | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 30 });
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!pageId) return;
    try {
      setLoading(true);
      const [p, s, ev, geo, devices] = await Promise.all([
        pagesApi.get(pageId),
        pagesApi.analytics(pageId, dateRange),
        pagesApi.events(pageId, dateRange),
        pagesApi.geo(pageId, { ...dateRange, level: geoLevel }),
        pagesApi.devices(pageId, dateRange),
      ]);
      setPage(p);
      setSummary(s);
      setEvents(ev);
      setGeoBreakdown(geo);
      setDeviceBreakdown(devices);
    } catch {
      // graceful: the empty state below handles it
    } finally {
      setLoading(false);
    }
  }, [pageId, dateRange, geoLevel]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleGeoLevelChange = async (level: 'country' | 'region' | 'city') => {
    setGeoLevel(level);
    if (!pageId) return;
    try {
      setGeoBreakdown(await pagesApi.geo(pageId, { ...dateRange, level }));
    } catch {
      // graceful
    }
  };

  const handleCopyUrl = async () => {
    if (!page) return;
    try {
      await navigator.clipboard.writeText(page.url);
      toast.success('Page URL copied');
    } catch {
      toast.error('Failed to copy URL');
    }
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4">
        <LoadingSpinner />
      </div>
    );
  }

  if (!page || !summary) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <EmptyState
          icon={Globe}
          title="Page not found"
          description="We couldn't find analytics for this page. It may have been removed or you don't have access."
        />
      </div>
    );
  }

  const deviceChartData = (deviceBreakdown?.devices || [])
    .sort((a, b) => b.clicks - a.clicks)
    .map((item) => ({ name: item.device_type || 'Unknown', clicks: item.clicks }));
  const browserChartData = (deviceBreakdown?.browsers || [])
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 8)
    .map((item) => ({ name: item.browser || 'Unknown', clicks: item.clicks }));

  const statCard = (label: string, value: string, Icon: typeof Eye, tone: string) => (
    <Card className={`bg-gradient-to-br ${tone}`}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium opacity-80">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
        </div>
        <div className="w-12 h-12 rounded-lg bg-white/50 flex items-center justify-center">
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </Card>
  );

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900 truncate" title={page.title}>{page.title}</h1>
              {page.slug && <Badge variant="info" size="sm">/p/{page.slug}</Badge>}
              <Badge variant="default" size="sm">v{page.current_version}</Badge>
            </div>
            <div className="mt-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded px-2 py-1 w-fit max-w-full">
              <code className="text-xs font-mono text-slate-900 break-all">{page.url}</code>
              <button type="button" onClick={handleCopyUrl} className="text-slate-400 hover:text-slate-700 flex-shrink-0" aria-label="Copy page URL">
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={handleCopyUrl} leftIcon={<Copy className="h-4 w-4" />}>
            Copy URL
          </Button>
        </div>

        <DateRangePicker defaultDays={30} onRangeChange={setDateRange} />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {statCard('Views', summary.views.toLocaleString(), Eye, 'from-green-50 to-green-100 text-green-900')}
        {statCard('Unique visitors', summary.unique_visitors.toLocaleString(), Users, 'from-purple-50 to-purple-100 text-purple-900')}
        {statCard('Revisits', summary.revisits.toLocaleString(), Repeat, 'from-blue-50 to-blue-100 text-blue-900')}
        {statCard('Avg time on page', formatDwell(summary.avg_dwell_ms), Timer, 'from-amber-50 to-amber-100 text-amber-900')}
      </div>
      <p className="text-xs text-slate-500 -mt-2">
        {summary.sessions} tracked {summary.sessions === 1 ? 'session' : 'sessions'} · median {formatDwell(summary.median_dwell_ms)} · total {formatDwell(summary.total_dwell_ms)} · last opened {formatRelative(summary.last_viewed_at)}
      </p>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Device Breakdown</CardTitle></CardHeader>
          <div className="h-64">
            {deviceChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deviceChartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" stroke="#9ca3af" width={90} tick={{ fontSize: 13, fontWeight: 500 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [Number(value).toLocaleString(), 'Views']} cursor={{ fill: 'rgba(16, 185, 129, 0.06)' }} />
                  <Bar dataKey="clicks" fill="#10b981" radius={[0, 6, 6, 0]} name="Views" barSize={28} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="text-center"><Monitor className="w-10 h-10 mx-auto mb-2 opacity-40" /><p>No device data yet</p></div>
              </div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>Browser Breakdown</CardTitle></CardHeader>
          <div className="h-64">
            {browserChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={browserChartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <YAxis type="category" dataKey="name" stroke="#9ca3af" width={90} tick={{ fontSize: 13, fontWeight: 500 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} formatter={(value) => [Number(value).toLocaleString(), 'Views']} cursor={{ fill: 'rgba(139, 92, 246, 0.06)' }} />
                  <Bar dataKey="clicks" fill="#8b5cf6" radius={[0, 6, 6, 0]} name="Views" barSize={28} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="text-center"><Globe className="w-10 h-10 mx-auto mb-2 opacity-40" /><p>No browser data yet</p></div>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Geo Breakdown</CardTitle>
          {geoBreakdown.length > 0 ? (
            <span className="text-sm text-slate-500">{geoBreakdown.length} locations</span>
          ) : (
            <span className="text-xs text-slate-400">Geo data requires non-localhost traffic</span>
          )}
        </CardHeader>
        <GeoChart data={geoBreakdown} level={geoLevel} onLevelChange={handleGeoLevelChange} />
      </Card>

      <Card padding="none">
        <div className="p-6 pb-0">
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            {events.length > 0 && (
              <span className="text-sm text-slate-500">{events.length} {events.length === 1 ? 'event' : 'events'}</span>
            )}
          </CardHeader>
        </div>
        {events.length > 0 ? (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  {['Type', 'Time', 'Location', 'Device', 'Browser', 'Detail', 'VPN'].map((h) => (
                    <th key={h} className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {events.map((event, i) => {
                  const badge = eventBadge(event.type);
                  return (
                    <tr key={`${event.ts ?? ''}-${i}`} className="hover:bg-gray-50 transition-colors">
                      <td className="px-4 py-3"><Badge variant={badge.variant} size="sm">{badge.label}</Badge></td>
                      <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{formatRelative(event.ts, '--')}</td>
                      <td className="px-4 py-3 text-sm text-slate-700">
                        {event.city && event.country ? `${event.city}, ${event.country}` : event.country || event.city || '--'}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">
                        {event.device_type ? (
                          <span className="inline-flex items-center gap-1.5">
                            <DeviceIcon type={event.device_type} className="w-3.5 h-3.5 text-slate-400" />
                            {event.device_type}
                          </span>
                        ) : '--'}
                      </td>
                      <td className="px-4 py-3 text-sm text-slate-600">{event.browser || '--'}</td>
                      <td className="px-4 py-3 text-sm text-slate-500 max-w-[220px] truncate" title={event.ref ?? undefined}>
                        {event.ref ?? <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-3 text-center">
                        {event.is_vpn ? <Badge variant="danger" size="sm">VPN</Badge> : <span className="text-gray-300">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-6 pb-6">
            <div className="flex items-center justify-center h-32 text-gray-400">
              <div className="text-center"><Eye className="w-8 h-8 mx-auto mb-2 opacity-40" /><p>No activity recorded yet</p></div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
