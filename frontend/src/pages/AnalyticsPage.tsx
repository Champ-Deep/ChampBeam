import { useState, useCallback, useEffect } from 'react';
import {
  Link2, MousePointer, ExternalLink, BarChart3,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line,
} from 'recharts';
import { Card, CardHeader, CardTitle, Button, LoadingSpinner, EmptyState } from '../components/ui';
import { utmApi } from '../api/utm';
import type { UTMOverview, UTMBreakdownItem, PerformanceOverTime } from '../api/utm';

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

export function AnalyticsPage() {
  const [overview, setOverview] = useState<UTMOverview | null>(null);
  const [sourceBreakdown, setSourceBreakdown] = useState<UTMBreakdownItem[]>([]);
  const [campaignBreakdown, setCampaignBreakdown] = useState<UTMBreakdownItem[]>([]);
  const [performanceData, setPerformanceData] = useState<PerformanceOverTime | null>(null);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [overviewData, sources, campaigns, perf] = await Promise.all([
        utmApi.getOverview(),
        utmApi.getBreakdown('source', undefined, period),
        utmApi.getBreakdown('campaign', undefined, period),
        utmApi.getPerformanceOverTime(period),
      ]);
      setOverview(overviewData);
      setSourceBreakdown(sources);
      setCampaignBreakdown(campaigns);
      setPerformanceData(perf);
    } catch {
      // Graceful failure
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { loadData(); }, [loadData]);

  if (loading) return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;

  if (!overview || overview.total_tracked_links === 0) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4">
        <h1 className="text-3xl font-bold text-slate-900 mb-6">Analytics</h1>
        <EmptyState
          icon={BarChart3}
          title="No Analytics Data Yet"
          description="Generate some UTM links first — analytics will appear here once you have tracked links."
        />
      </div>
    );
  }

  const sourceChartData = sourceBreakdown.slice(0, 7).map((item) => ({
    name: item.group_value || 'Unknown',
    clicks: item.total_clicks,
    unique: item.unique_clicks,
  }));

  const campaignChartData = campaignBreakdown.slice(0, 7).map((item) => ({
    name: item.group_value.length > 20 ? item.group_value.slice(0, 20) + '...' : item.group_value || 'Unknown',
    clicks: item.total_clicks,
    unique: item.unique_clicks,
  }));

  const timeSeriesData = (performanceData?.data || []).map((d) => ({
    date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    links: d.links_created,
    clicks: d.total_clicks,
  }));

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      {/* Header + period selector */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Analytics</h1>
          <p className="text-slate-600 mt-1">Track UTM performance across your links.</p>
        </div>
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

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="bg-gradient-to-br from-brand-purple/5 to-brand-purple/10">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-brand-purple font-medium">Tracked Links</p>
              <p className="text-2xl font-bold text-slate-900">{overview.total_tracked_links.toLocaleString()}</p>
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
              <p className="text-2xl font-bold text-green-900">{overview.total_clicks.toLocaleString()}</p>
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
              <p className="text-2xl font-bold text-purple-900">{overview.unique_clicks.toLocaleString()}</p>
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
              <p className="text-2xl font-bold text-amber-900">{overview.overall_click_rate.toFixed(1)}%</p>
            </div>
            <div className="w-12 h-12 bg-amber-200 rounded-lg flex items-center justify-center">
              <BarChart3 className="w-6 h-6 text-amber-600" />
            </div>
          </div>
        </Card>
      </div>

      {/* Time series chart */}
      {timeSeriesData.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Links & Clicks Over Time</CardTitle>
          </CardHeader>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={timeSeriesData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="date" stroke="#9ca3af" tick={{ fontSize: 12 }} />
                <YAxis stroke="#9ca3af" />
                <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                <Line type="monotone" dataKey="links" stroke={CHART_COLORS[0]} name="Links Created" strokeWidth={2} />
                <Line type="monotone" dataKey="clicks" stroke={CHART_COLORS[1]} name="Total Clicks" strokeWidth={2} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      {/* Bar charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle>Top UTM Sources</CardTitle></CardHeader>
          <div className="h-80">
            {sourceChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={sourceChartData} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#9ca3af" />
                  <YAxis type="category" dataKey="name" stroke="#9ca3af" width={100} tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                  <Bar dataKey="clicks" fill={CHART_COLORS[0]} radius={[0, 4, 4, 0]} name="Total Clicks" />
                  <Bar dataKey="unique" fill={CHART_COLORS[1]} radius={[0, 4, 4, 0]} name="Unique Clicks" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">No source data</div>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader><CardTitle>Top UTM Campaigns</CardTitle></CardHeader>
          <div className="h-80">
            {campaignChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={campaignChartData} layout="vertical" margin={{ left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#9ca3af" />
                  <YAxis type="category" dataKey="name" stroke="#9ca3af" width={140} tick={{ fontSize: 12 }} />
                  <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                  <Bar dataKey="clicks" fill={CHART_COLORS[4]} radius={[0, 4, 4, 0]} name="Total Clicks" />
                  <Bar dataKey="unique" fill={CHART_COLORS[5]} radius={[0, 4, 4, 0]} name="Unique Clicks" />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">No campaign data</div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
