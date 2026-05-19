import { useState, useCallback, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import {
  Megaphone, MousePointer, Link2, ExternalLink, BarChart3, ArrowLeft,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line,
} from 'recharts';
import { Card, CardHeader, CardTitle, LoadingSpinner, Button } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { ExportButton } from '../components/ui/ExportButton';
import { utmApi } from '../api/utm';
import type {
  CampaignDetail, GeoBreakdownItem, DeviceBreakdown,
  CampaignTimelinePoint, DateRangeOpts, LinkPerformanceItem,
} from '../api/utm';

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export function CampaignDetailPage() {
  const { campaignName } = useParams<{ campaignName: string }>();
  const name = decodeURIComponent(campaignName || '');

  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [geoData, setGeoData] = useState<GeoBreakdownItem[]>([]);
  const [geoLevel, setGeoLevel] = useState<'country' | 'region' | 'city'>('country');
  const [devices, setDevices] = useState<DeviceBreakdown | null>(null);
  const [timeline, setTimeline] = useState<CampaignTimelinePoint[]>([]);
  const [links, setLinks] = useState<LinkPerformanceItem[]>([]);
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 90 });
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!name) return;
    try {
      setLoading(true);
      // Load detail first (required), then others independently
      const d = await utmApi.getCampaignDetail(name, dateRange);
      setDetail(d);

      // Load remaining data independently — don't let one failure kill the page
      const results = await Promise.allSettled([
        utmApi.getCampaignGeo(name, { ...dateRange, level: geoLevel }),
        utmApi.getCampaignDevices(name, dateRange),
        utmApi.getCampaignTimeline(name, dateRange),
        utmApi.getCampaignLinks(name, dateRange),
      ]);
      if (results[0].status === 'fulfilled') setGeoData(results[0].value);
      if (results[1].status === 'fulfilled') setDevices(results[1].value);
      if (results[2].status === 'fulfilled') setTimeline(results[2].value.data);
      if (results[3].status === 'fulfilled') setLinks(results[3].value);
    } catch {
      // Detail call failed — still show error state
    } finally {
      setLoading(false);
    }
  }, [name, dateRange, geoLevel]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;
  if (!detail) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
        <Link to="/campaigns">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back to Campaigns</Button>
        </Link>
        <div className="text-center py-12">
          <Megaphone className="w-12 h-12 mx-auto text-slate-300 mb-4" />
          <h2 className="text-xl font-semibold text-slate-900">Campaign Not Found</h2>
          <p className="text-slate-500 mt-2">Could not load analytics for "{name}". The campaign may have no links yet.</p>
        </div>
      </div>
    );
  }

  const timelineData = timeline.map((d) => ({
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    clicks: d.clicks,
    unique: d.unique_clicks,
  }));

  const geoChartData = geoData.slice(0, 10).map((g) => ({
    name: geoLevel === 'country' ? (g.country || 'Unknown')
      : geoLevel === 'region' ? (g.region || 'Unknown')
      : (g.city || 'Unknown'),
    clicks: g.clicks,
  }));

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <Link to="/campaigns">
            <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4" /></Button>
          </Link>
          <div>
            <div className="flex items-center gap-2">
              <Megaphone className="h-6 w-6 text-brand-purple" />
              <h1 className="text-3xl font-bold text-slate-900">{name}</h1>
            </div>
            <p className="text-slate-600 mt-1">Campaign analytics</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <ExportButton onExport={() => utmApi.exportClickEvents({ ...dateRange, campaign: name })} />
          <DateRangePicker defaultDays={90} onRangeChange={setDateRange} />
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-brand-purple/5 to-brand-purple/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-brand-purple font-medium">Links</p>
              <p className="text-2xl font-bold text-slate-900">{detail.total_links}</p>
            </div>
            <div className="w-12 h-12 bg-brand-purple/20 rounded-lg flex items-center justify-center">
              <Link2 className="w-6 h-6 text-brand-purple" />
            </div>
          </div>
        </Card>
        <Card className="bg-gradient-to-br from-green-50 to-green-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-600 font-medium">Total Clicks</p>
              <p className="text-2xl font-bold text-green-900">{detail.total_clicks.toLocaleString()}</p>
            </div>
            <div className="w-12 h-12 bg-green-200 rounded-lg flex items-center justify-center">
              <MousePointer className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </Card>
        <Card className="bg-gradient-to-br from-purple-50 to-purple-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-purple-600 font-medium">Unique Clicks</p>
              <p className="text-2xl font-bold text-purple-900">{detail.unique_clicks.toLocaleString()}</p>
            </div>
            <div className="w-12 h-12 bg-purple-200 rounded-lg flex items-center justify-center">
              <ExternalLink className="w-6 h-6 text-purple-600" />
            </div>
          </div>
        </Card>
        <Card className="bg-gradient-to-br from-amber-50 to-amber-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-amber-600 font-medium">Click Rate</p>
              <p className="text-2xl font-bold text-amber-900">{detail.click_rate.toFixed(1)}%</p>
            </div>
            <div className="w-12 h-12 bg-amber-200 rounded-lg flex items-center justify-center">
              <BarChart3 className="w-6 h-6 text-amber-600" />
            </div>
          </div>
        </Card>
      </div>

      {/* Timeline */}
      {timelineData.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Clicks Over Time</CardTitle></CardHeader>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timelineData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#9ca3af" tick={{ fontSize: 12 }} />
                <YAxis stroke="#9ca3af" />
                <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                <Line type="monotone" dataKey="clicks" stroke={CHART_COLORS[0]} name="Clicks" strokeWidth={2} />
                <Line type="monotone" dataKey="unique" stroke={CHART_COLORS[1]} name="Unique" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Geo + Device */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full">
              <CardTitle>Geographic Breakdown</CardTitle>
              <div className="flex gap-1">
                {(['country', 'region', 'city'] as const).map((lvl) => (
                  <Button
                    key={lvl}
                    variant={geoLevel === lvl ? 'primary' : 'outline'}
                    size="sm"
                    onClick={() => setGeoLevel(lvl)}
                  >
                    {lvl.charAt(0).toUpperCase() + lvl.slice(1)}
                  </Button>
                ))}
              </div>
            </div>
          </CardHeader>
          <div className="h-80">
            {geoChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={geoChartData} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#9ca3af" />
                  <YAxis type="category" dataKey="name" stroke="#9ca3af" width={120} tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                  <Bar dataKey="clicks" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} name="Clicks" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">No geo data</div>
            )}
          </div>
        </Card>

        <Card>
          <CardHeader><CardTitle>Device & Browser</CardTitle></CardHeader>
          <div className="h-80 grid grid-rows-2 gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">Devices</p>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={devices?.devices || []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="device_type" stroke="#9ca3af" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#9ca3af" />
                  <Tooltip />
                  <Bar dataKey="clicks" fill={CHART_COLORS[4]} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 mb-1">Browsers</p>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={(devices?.browsers || []).slice(0, 6)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="browser" stroke="#9ca3af" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#9ca3af" />
                  <Tooltip />
                  <Bar dataKey="clicks" fill={CHART_COLORS[5]} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </Card>
      </div>

      {/* Sources + Mediums */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Sources</CardTitle></CardHeader>
          <div className="h-64">
            {detail.sources.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={detail.sources} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#9ca3af" />
                  <YAxis type="category" dataKey="source" stroke="#9ca3af" width={100} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="clicks" fill={CHART_COLORS[1]} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">No source data</div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader><CardTitle>Mediums</CardTitle></CardHeader>
          <div className="h-64">
            {detail.mediums.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={detail.mediums} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#9ca3af" />
                  <YAxis type="category" dataKey="medium" stroke="#9ca3af" width={100} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <Bar dataKey="clicks" fill={CHART_COLORS[2]} radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">No medium data</div>
            )}
          </div>
        </Card>
      </div>

      {/* Top links table */}
      <Card>
        <CardHeader><CardTitle>Top Links in Campaign</CardTitle></CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-3 px-4 font-medium text-slate-500">URL</th>
                <th className="text-left py-3 px-4 font-medium text-slate-500">Source</th>
                <th className="text-right py-3 px-4 font-medium text-slate-500">Clicks</th>
                <th className="text-right py-3 px-4 font-medium text-slate-500">Unique</th>
              </tr>
            </thead>
            <tbody>
              {links.slice(0, 20).map((link) => (
                <tr key={link.link_id} className="border-b border-slate-100 hover:bg-slate-50">
                  <td className="py-3 px-4">
                    <Link to={`/analytics/link/${link.link_id}`} className="text-brand-purple hover:underline truncate block max-w-xs">
                      {link.original_url}
                    </Link>
                  </td>
                  <td className="py-3 px-4 text-slate-600">{link.utm_source || '-'}</td>
                  <td className="py-3 px-4 text-right font-medium">{link.click_count}</td>
                  <td className="py-3 px-4 text-right font-medium">{link.unique_clicks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
