import { useState, useCallback, useEffect } from 'react';
import { GitCompare } from 'lucide-react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from 'recharts';
import { Card, CardHeader, CardTitle, Button, LoadingSpinner, EmptyState } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { utmApi } from '../api/utm';
import type { CampaignSummary, CampaignComparisonItem, DateRangeOpts } from '../api/utm';

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b'];

export function CampaignComparisonPage() {
  const [allCampaigns, setAllCampaigns] = useState<CampaignSummary[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [comparison, setComparison] = useState<CampaignComparisonItem[] | null>(null);
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 90 });
  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);

  useEffect(() => {
    utmApi.getCampaigns({ days: 365 }).then(setAllCampaigns).catch(() => {}).finally(() => setInitialLoading(false));
  }, []);

  const toggleCampaign = (name: string) => {
    setSelected((prev) =>
      prev.includes(name)
        ? prev.filter((n) => n !== name)
        : prev.length < 4
          ? [...prev, name]
          : prev
    );
  };

  const loadComparison = useCallback(async () => {
    if (selected.length < 2) return;
    try {
      setLoading(true);
      const result = await utmApi.compareCampaigns(selected, dateRange);
      setComparison(result.campaigns);
    } catch {
      // graceful
    } finally {
      setLoading(false);
    }
  }, [selected, dateRange]);

  if (initialLoading) return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;

  // Build merged timeline data for comparison chart
  const timelineData: Record<string, Record<string, number>>[] = [];
  if (comparison) {
    const dateMap = new Map<string, Record<string, number>>();
    comparison.forEach((c) => {
      c.timeline.forEach((t) => {
        const existing = dateMap.get(t.date) || {};
        existing[c.campaign] = t.clicks;
        dateMap.set(t.date, existing);
      });
    });
    const sorted = [...dateMap.entries()].sort(([a], [b]) => a.localeCompare(b));
    sorted.forEach(([date, values]) => {
      timelineData.push({ date: new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), ...values } as any);
    });
  }

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Compare Campaigns</h1>
          <p className="text-slate-600 mt-1">Select 2-4 campaigns to compare side by side.</p>
        </div>
        <DateRangePicker defaultDays={90} onRangeChange={setDateRange} />
      </div>

      {/* Campaign selector */}
      <Card>
        <CardHeader><CardTitle>Select Campaigns ({selected.length}/4)</CardTitle></CardHeader>
        <div className="flex flex-wrap gap-2 mb-4">
          {allCampaigns.map((c) => (
            <button
              key={c.campaign}
              onClick={() => toggleCampaign(c.campaign)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                selected.includes(c.campaign)
                  ? 'bg-brand-purple text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {c.campaign}
            </button>
          ))}
        </div>
        <Button
          variant="primary"
          onClick={loadComparison}
          disabled={selected.length < 2 || loading}
        >
          {loading ? 'Comparing...' : 'Compare Selected'}
        </Button>
      </Card>

      {comparison && comparison.length > 0 && (
        <>
          {/* Summary comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {comparison.map((c, i) => (
              <Card key={c.campaign} className="border-l-4" style={{ borderLeftColor: COLORS[i] }}>
                <h3 className="font-semibold text-slate-900 mb-2 truncate">{c.campaign}</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-500">Links</span><span className="font-medium">{c.total_links}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Clicks</span><span className="font-medium">{c.total_clicks.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Unique</span><span className="font-medium">{c.unique_clicks.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">Rate</span><span className="font-medium">{c.click_rate.toFixed(1)}%</span></div>
                </div>
              </Card>
            ))}
          </div>

          {/* Timeline comparison */}
          {timelineData.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Clicks Over Time</CardTitle></CardHeader>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={timelineData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                    <XAxis dataKey="date" stroke="#9ca3af" tick={{ fontSize: 12 }} />
                    <YAxis stroke="#9ca3af" />
                    <Tooltip contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }} />
                    {comparison.map((c, i) => (
                      <Line key={c.campaign} type="monotone" dataKey={c.campaign} stroke={COLORS[i]} strokeWidth={2} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </Card>
          )}

          {/* Device comparison */}
          <Card>
            <CardHeader><CardTitle>Device Distribution</CardTitle></CardHeader>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {comparison.map((c, i) => (
                <div key={c.campaign}>
                  <p className="text-sm font-medium text-slate-700 mb-2" style={{ color: COLORS[i] }}>{c.campaign}</p>
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={c.top_devices}>
                        <XAxis dataKey="device_type" tick={{ fontSize: 10 }} />
                        <YAxis hide />
                        <Tooltip />
                        <Bar dataKey="clicks" fill={COLORS[i]} radius={[4, 4, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}

      {!comparison && selected.length < 2 && (
        <EmptyState
          icon={GitCompare}
          title="Select Campaigns to Compare"
          description="Pick at least 2 campaigns from above to see a side-by-side comparison."
        />
      )}
    </div>
  );
}
