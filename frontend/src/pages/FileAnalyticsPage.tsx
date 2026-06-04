import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Copy, Globe, Monitor, Smartphone, Tablet,
  Eye, Users, Clock, FileText,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, Button, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { GeoChart } from '../components/ui/GeoChart';
import { filesApi } from '../api/files';
import type { FileSummary, FileEvent, FileGeoItem, FileDeviceBreakdown } from '../api/files';
import type { DateRangeOpts } from '../api/utm';

const TOOLTIP_STYLE = {
  backgroundColor: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
};

function DeviceIcon({ type, className }: { type: string | null; className?: string }) {
  const t = (type || '').toLowerCase();
  if (t.includes('mobile') || t.includes('phone')) return <Smartphone className={className} />;
  if (t.includes('tablet')) return <Tablet className={className} />;
  return <Monitor className={className} />;
}

export function FileAnalyticsPage() {
  const { fileId } = useParams<{ fileId: string }>();
  const navigate = useNavigate();

  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [fileEvents, setFileEvents] = useState<FileEvent[]>([]);
  const [geoBreakdown, setGeoBreakdown] = useState<FileGeoItem[]>([]);
  const [geoLevel, setGeoLevel] = useState<'country' | 'region' | 'city'>('country');
  const [deviceBreakdown, setDeviceBreakdown] = useState<FileDeviceBreakdown | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 30 });
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!fileId) return;
    try {
      setLoading(true);
      const [fileSummary, events, geo, devices] = await Promise.all([
        filesApi.getFileSummary(fileId),
        filesApi.getFileEvents(fileId, dateRange),
        filesApi.getFileGeo(fileId, { ...dateRange, level: geoLevel }),
        filesApi.getFileDevices(fileId, dateRange),
      ]);

      setSummary(fileSummary);
      setFileEvents(events);
      setGeoBreakdown(geo);
      setDeviceBreakdown(devices);
    } catch {
      // Graceful failure
    } finally {
      setLoading(false);
    }
  }, [fileId, dateRange, geoLevel]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleGeoLevelChange = async (level: 'country' | 'region' | 'city') => {
    setGeoLevel(level);
    if (!fileId) return;
    try {
      const geo = await filesApi.getFileGeo(fileId, { ...dateRange, level });
      setGeoBreakdown(geo);
    } catch {
      // graceful
    }
  };

  const serveUrl = summary?.short_code ? `/f/${summary.short_code}` : null;

  const handleCopyServeUrl = async () => {
    if (!serveUrl) return;
    const fullUrl = `${window.location.origin}${serveUrl}`;
    try {
      await navigator.clipboard.writeText(fullUrl);
      toast.success('Serve URL copied to clipboard');
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

  if (!summary) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
        <Button variant="ghost" size="sm" onClick={() => navigate(-1)} leftIcon={<ArrowLeft className="h-4 w-4" />}>
          Back
        </Button>
        <EmptyState
          icon={FileText}
          title="File Not Found"
          description="We couldn't find analytics for this file. It may have been deleted or you don't have access."
        />
      </div>
    );
  }

  const truncatedName =
    summary.filename.length > 60
      ? summary.filename.slice(0, 60) + '...'
      : summary.filename;

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

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
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
              <h1 className="text-2xl font-bold text-slate-900 truncate" title={summary.filename}>
                {truncatedName}
              </h1>
              {summary.short_code && (
                <Badge variant="info" size="sm">
                  {summary.short_code}
                </Badge>
              )}
            </div>
            {serveUrl && (
              <div className="mt-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded px-2 py-1 w-fit max-w-full">
                <code className="text-xs font-mono text-slate-900 break-all">
                  {serveUrl}
                </code>
                <button
                  type="button"
                  onClick={handleCopyServeUrl}
                  className="text-slate-400 hover:text-slate-700 flex-shrink-0"
                  aria-label="Copy serve URL"
                  title="Copy serve URL"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyServeUrl}
              leftIcon={<Copy className="h-4 w-4" />}
              disabled={!serveUrl}
            >
              Copy Serve URL
            </Button>
          </div>
        </div>

        {/* Date range picker */}
        <DateRangePicker defaultDays={30} onRangeChange={setDateRange} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-green-50 to-green-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-green-600 font-medium">Total Opens</p>
              <p className="text-2xl font-bold text-green-900">
                {(summary.opens ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="w-12 h-12 bg-green-200 rounded-lg flex items-center justify-center">
              <Eye className="w-6 h-6 text-green-600" />
            </div>
          </div>
        </Card>

        <Card className="bg-gradient-to-br from-purple-50 to-purple-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-purple-600 font-medium">Unique Opens</p>
              <p className="text-2xl font-bold text-purple-900">
                {(summary.unique_opens ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="w-12 h-12 bg-purple-200 rounded-lg flex items-center justify-center">
              <Users className="w-6 h-6 text-purple-600" />
            </div>
          </div>
        </Card>

        <Card className="bg-gradient-to-br from-blue-50 to-blue-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-blue-600 font-medium">Last Opened</p>
              <p className="text-2xl font-bold text-blue-900">
                {summary.last_viewed_at
                  ? formatDistanceToNow(new Date(summary.last_viewed_at), { addSuffix: true })
                  : 'Never'}
              </p>
            </div>
            <div className="w-12 h-12 bg-blue-200 rounded-lg flex items-center justify-center">
              <Clock className="w-6 h-6 text-blue-600" />
            </div>
          </div>
        </Card>

        <Card className="bg-gradient-to-br from-amber-50 to-amber-100">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-amber-600 font-medium">Total Views</p>
              <p className="text-2xl font-bold text-amber-900">
                {(summary.view_count ?? 0).toLocaleString()}
              </p>
            </div>
            <div className="w-12 h-12 bg-amber-200 rounded-lg flex items-center justify-center">
              <FileText className="w-6 h-6 text-amber-600" />
            </div>
          </div>
        </Card>
      </div>

      {/* Device + Browser Breakdown (shown first — always works, even on localhost) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                    formatter={(value) => [Number(value).toLocaleString(), 'Opens']}
                    cursor={{ fill: 'rgba(16, 185, 129, 0.06)' }}
                  />
                  <Bar
                    dataKey="clicks"
                    fill="#10b981"
                    radius={[0, 6, 6, 0]}
                    name="Opens"
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
                    formatter={(value) => [Number(value).toLocaleString(), 'Opens']}
                    cursor={{ fill: 'rgba(139, 92, 246, 0.06)' }}
                  />
                  <Bar
                    dataKey="clicks"
                    fill="#8b5cf6"
                    radius={[0, 6, 6, 0]}
                    name="Opens"
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

      {/* Geo Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Geo Breakdown</CardTitle>
          {geoBreakdown.length > 0 ? (
            <span className="text-sm text-slate-500">
              {geoBreakdown.length} locations
            </span>
          ) : (
            <span className="text-xs text-slate-400">
              Geo data requires non-localhost traffic
            </span>
          )}
        </CardHeader>
        <GeoChart data={geoBreakdown} level={geoLevel} onLevelChange={handleGeoLevelChange} />
      </Card>

      {/* Recent Opens */}
      <Card padding="none">
        <div className="p-6 pb-0">
          <CardHeader>
            <CardTitle>Recent Opens</CardTitle>
            {fileEvents.length > 0 && (
              <span className="text-sm text-slate-500">
                {fileEvents.length} {fileEvents.length === 1 ? 'open' : 'opens'}
              </span>
            )}
          </CardHeader>
        </div>

        {fileEvents.length > 0 ? (
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
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">VPN / ISP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {fileEvents.map((event) => (
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
                    <td className="px-4 py-3 text-center">
                      {event.is_vpn ? (
                        <div className="inline-flex items-center gap-1.5">
                          <Badge variant="danger" size="sm">VPN</Badge>
                          {event.asn_org && (
                            <span className="text-xs text-gray-400" title={event.asn_org}>
                              {event.asn_org.length > 20 ? event.asn_org.slice(0, 20) + '...' : event.asn_org}
                            </span>
                          )}
                        </div>
                      ) : event.asn_org ? (
                        <span className="text-xs text-gray-400" title={event.asn_org}>
                          {event.asn_org.length > 20 ? event.asn_org.slice(0, 20) + '...' : event.asn_org}
                        </span>
                      ) : (
                        <span className="text-gray-300">-</span>
                      )}
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
                <Eye className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p>No opens recorded yet</p>
              </div>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
