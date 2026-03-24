import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Copy, Globe, Monitor, Smartphone, Tablet,
  MousePointer, Users, MapPin,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, Button, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { utmApi } from '../api/utm';
import type { LinkPerformanceItem, ClickEvent, GeoBreakdownItem, DeviceBreakdown } from '../api/utm';

// ============================================================
// Tooltip style (shared across charts)
// ============================================================

const TOOLTIP_STYLE = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
};

// ============================================================
// Helper: device icon
// ============================================================

function DeviceIcon({ type, className }: { type: string | null; className?: string }) {
  const t = (type || '').toLowerCase();
  if (t.includes('mobile') || t.includes('phone')) return <Smartphone className={className} />;
  if (t.includes('tablet')) return <Tablet className={className} />;
  return <Monitor className={className} />;
}

// ============================================================
// Component
// ============================================================

export function LinkAnalyticsPage() {
  const { linkId } = useParams<{ linkId: string }>();
  const navigate = useNavigate();

  // --------------- state ---------------
  const [linkInfo, setLinkInfo] = useState<LinkPerformanceItem | null>(null);
  const [clickEvents, setClickEvents] = useState<ClickEvent[]>([]);
  const [geoBreakdown, setGeoBreakdown] = useState<GeoBreakdownItem[]>([]);
  const [deviceBreakdown, setDeviceBreakdown] = useState<DeviceBreakdown | null>(null);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [loading, setLoading] = useState(true);

  // --------------- load ---------------
  const loadData = useCallback(async () => {
    if (!linkId) return;
    try {
      setLoading(true);
      const [allLinks, events, geo, devices] = await Promise.all([
        utmApi.getLinkPerformance({ days: period }),
        utmApi.getLinkClickEvents(linkId, period),
        utmApi.getLinkGeoBreakdown(linkId, period),
        utmApi.getLinkDeviceBreakdown(linkId, period),
      ]);

      const found = allLinks.find((l) => l.link_id === linkId) ?? null;
      setLinkInfo(found);
      setClickEvents(events);
      setGeoBreakdown(geo);
      setDeviceBreakdown(devices);
    } catch {
      // Graceful failure
    } finally {
      setLoading(false);
    }
  }, [linkId, period]);

  useEffect(() => { loadData(); }, [loadData]);

  // --------------- copy ---------------
  const handleCopyRedirectUrl = async () => {
    const url = linkInfo?.redirect_url || linkInfo?.tracked_url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Redirect URL copied to clipboard');
    } catch {
      toast.error('Failed to copy URL');
    }
  };

  // --------------- loading / empty ---------------
  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4">
        <LoadingSpinner />
      </div>
    );
  }

  if (!linkInfo) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <EmptyState
          icon={Globe}
          title="Link Not Found"
          description="We couldn't find analytics for this link. It may have been deleted or you don't have access."
        />
      </div>
    );
  }

  // --------------- derived data ---------------
  const truncatedUrl =
    linkInfo.original_url.length > 60
      ? linkInfo.original_url.slice(0, 60) + '...'
      : linkInfo.original_url;

  // Geo chart
  const geoChartData = geoBreakdown
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 10)
    .map((item) => ({
      name: item.country || 'Unknown',
      clicks: item.clicks,
    }));

  // Device chart
  const deviceChartData = (deviceBreakdown?.devices || [])
    .sort((a, b) => b.clicks - a.clicks)
    .map((item) => ({
      name: item.device_type || 'Unknown',
      clicks: item.clicks,
    }));

  // Browser chart
  const browserChartData = (deviceBreakdown?.browsers || [])
    .sort((a, b) => b.clicks - a.clicks)
    .slice(0, 8)
    .map((item) => ({
      name: item.browser || 'Unknown',
      clicks: item.clicks,
    }));

  // Summary helpers
  const topCountry = geoBreakdown.length > 0
    ? geoBreakdown.sort((a, b) => b.clicks - a.clicks)[0]?.country
    : null;

  const topDevice = deviceBreakdown?.devices?.length
    ? [...deviceBreakdown.devices].sort((a, b) => b.clicks - a.clicks)[0]?.device_type
    : null;

  // --------------- render ---------------
  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      {/* ===== Header ===== */}
      <div className="space-y-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate(-1)}
          leftIcon={<ArrowLeft className="h-4 w-4" />}
        >
          Back
        </Button>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900 truncate" title={linkInfo.original_url}>
                {truncatedUrl}
              </h1>
              {linkInfo.short_code && (
                <Badge variant="info" size="sm">
                  {linkInfo.short_code}
                </Badge>
              )}
            </div>
            {linkInfo.utm_source && (
              <p className="text-sm text-slate-500 mt-1">
                {[linkInfo.utm_source, linkInfo.utm_medium, linkInfo.utm_campaign]
                  .filter(Boolean)
                  .join(' / ')}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyRedirectUrl}
              leftIcon={<Copy className="h-4 w-4" />}
              disabled={!linkInfo.redirect_url && !linkInfo.tracked_url}
            >
              Copy Redirect URL
            </Button>
          </div>
        </div>

        {/* Period selector */}
        <div className="flex gap-2">
          {([7, 30, 90] as const).map((d) => (
            <Button
              key={d}
              variant={period === d ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setPeriod(d)}
            >
              {d}D
            </Button>
          ))}
        </div>
      </div>

      {/* ===== Summary Cards ===== */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Clicks */}
        <Card className="bg-gradient-to-br from-green-50 to-green-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-600 font-medium">Total Clicks</p>
              <p className="text-2xl font-bold text-green-900">
                {linkInfo.click_count.toLocaleString()}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-200 rounded-lg flex items-center justify-center">
              <MousePointer className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </Card>

        {/* Unique Clicks */}
        <Card className="bg-gradient-to-br from-purple-50 to-purple-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-purple-600 font-medium">Unique Clicks</p>
              <p className="text-2xl font-bold text-purple-900">
                {linkInfo.unique_clicks.toLocaleString()}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-200 rounded-lg flex items-center justify-center">
              <Users className="w-6 h-6 text-purple-600" />
            </div>
          </div>
        </Card>

        {/* Top Country */}
        <Card className="bg-gradient-to-br from-blue-50 to-blue-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-blue-600 font-medium">Top Country</p>
              <p className="text-2xl font-bold text-blue-900">
                {topCountry || '\u2014'}
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-200 rounded-lg flex items-center justify-center">
              <MapPin className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </Card>

        {/* Top Device */}
        <Card className="bg-gradient-to-br from-amber-50 to-amber-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-amber-600 font-medium">Top Device</p>
              <p className="text-2xl font-bold text-amber-900">
                {topDevice || '\u2014'}
              </p>
            </div>
            <div className="w-12 h-12 bg-amber-200 rounded-lg flex items-center justify-center">
              <DeviceIcon type={topDevice} className="w-6 h-6 text-amber-600" />
            </div>
          </div>
        </Card>
      </div>

      {/* ===== Geo Breakdown ===== */}
      <Card>
        <CardHeader>
          <CardTitle>Geo Breakdown</CardTitle>
          {geoBreakdown.length > 0 && (
            <span className="text-sm text-slate-500">
              {geoBreakdown.length} {geoBreakdown.length === 1 ? 'country' : 'countries'}
            </span>
          )}
        </CardHeader>
        <div className="h-80">
          {geoChartData.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={geoChartData} layout="vertical" margin={{ left: 20, right: 20, top: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 12 }} allowDecimals={false} />
                <YAxis
                  type="category"
                  dataKey="name"
                  stroke="#9ca3af"
                  width={120}
                  tick={{ fontSize: 13, fontWeight: 500 }}
                />
                <Tooltip
                  contentStyle={TOOLTIP_STYLE}
                  formatter={(value) => [Number(value).toLocaleString(), 'Clicks']}
                  cursor={{ fill: 'rgba(59, 130, 246, 0.06)' }}
                />
                <Bar
                  dataKey="clicks"
                  fill="#3b82f6"
                  radius={[0, 6, 6, 0]}
                  name="Clicks"
                  barSize={24}
                />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-gray-400">
              <div className="text-center">
                <Globe className="w-10 h-10 mx-auto mb-2 opacity-40" />
                <p>No geo data available yet</p>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* ===== Device + Browser Breakdown (side by side) ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Device Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Device Breakdown</CardTitle>
          </CardHeader>
          <div className="h-64">
            {deviceChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deviceChartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#9ca3af"
                    width={90}
                    tick={{ fontSize: 13, fontWeight: 500 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [Number(value).toLocaleString(), 'Clicks']}
                    cursor={{ fill: 'rgba(16, 185, 129, 0.06)' }}
                  />
                  <Bar
                    dataKey="clicks"
                    fill="#10b981"
                    radius={[0, 6, 6, 0]}
                    name="Clicks"
                    barSize={28}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="text-center">
                  <Monitor className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p>No device data yet</p>
                </div>
              </div>
            )}
          </div>
        </Card>

        {/* Browser Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Browser Breakdown</CardTitle>
          </CardHeader>
          <div className="h-64">
            {browserChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={browserChartData} layout="vertical" margin={{ left: 10, right: 20, top: 5, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" horizontal={false} />
                  <XAxis type="number" stroke="#9ca3af" tick={{ fontSize: 12 }} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    stroke="#9ca3af"
                    width={90}
                    tick={{ fontSize: 13, fontWeight: 500 }}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    formatter={(value) => [Number(value).toLocaleString(), 'Clicks']}
                    cursor={{ fill: 'rgba(139, 92, 246, 0.06)' }}
                  />
                  <Bar
                    dataKey="clicks"
                    fill="#8b5cf6"
                    radius={[0, 6, 6, 0]}
                    name="Clicks"
                    barSize={28}
                  />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="text-center">
                  <Globe className="w-10 h-10 mx-auto mb-2 opacity-40" />
                  <p>No browser data yet</p>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* ===== Recent Click Events ===== */}
      <Card padding="none">
        <div className="p-6 pb-0">
          <CardHeader>
            <CardTitle>Recent Click Events</CardTitle>
            {clickEvents.length > 0 && (
              <span className="text-sm text-slate-500">
                {clickEvents.length} {clickEvents.length === 1 ? 'event' : 'events'}
              </span>
            )}
          </CardHeader>
        </div>

        {clickEvents.length > 0 ? (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Time</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Country</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Region</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Device</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Browser</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Referrer</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {clickEvents.map((event) => (
                  <tr key={event.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">
                      {event.clicked_at
                        ? formatDistanceToNow(new Date(event.clicked_at), { addSuffix: true })
                        : '--'}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">
                      <span className="inline-flex items-center gap-1.5">
                        {event.country_code && (
                          <span className="text-xs font-mono text-slate-400">{event.country_code}</span>
                        )}
                        {event.country || '--'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {event.city && event.region
                        ? `${event.city}, ${event.region}`
                        : event.region || event.city || '--'}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      <span className="inline-flex items-center gap-1.5">
                        <DeviceIcon type={event.device_type} className="w-3.5 h-3.5 text-slate-400" />
                        {event.device_type || '--'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-600">
                      {event.browser || '--'}
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-500 max-w-[200px] truncate" title={event.referrer || undefined}>
                      {event.referrer
                        ? (() => {
                            try {
                              return new URL(event.referrer).hostname;
                            } catch {
                              return event.referrer;
                            }
                          })()
                        : <span className="text-gray-300">direct</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-6 pb-6">
            <div className="flex items-center justify-center h-32 text-gray-400">
              <div className="text-center">
                <MousePointer className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>No click events recorded yet</p>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
