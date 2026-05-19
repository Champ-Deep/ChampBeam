import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Megaphone, MousePointer, Link2, TrendingUp } from 'lucide-react';
import { Card, LoadingSpinner, EmptyState } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { ExportButton } from '../components/ui/ExportButton';
import { utmApi } from '../api/utm';
import type { CampaignSummary, DateRangeOpts } from '../api/utm';

export function CampaignsPage() {
  const navigate = useNavigate();
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 90 });
  const [search, setSearch] = useState('');

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const data = await utmApi.getCampaigns(dateRange);
      setCampaigns(data);
    } catch {
      // graceful
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => { loadData(); }, [loadData]);

  const filtered = campaigns.filter((c) =>
    c.campaign.toLowerCase().includes(search.toLowerCase())
  );

  if (loading) return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Campaigns</h1>
          <p className="text-slate-600 mt-1">Aggregate analytics across all links in each campaign.</p>
        </div>
        <div className="flex items-center gap-3">
          <ExportButton onExport={() => utmApi.exportCampaignSummary(dateRange)} />
          <DateRangePicker defaultDays={90} onRangeChange={setDateRange} />
        </div>
      </div>

      <input
        type="text"
        placeholder="Search campaigns..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full max-w-sm rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
      />

      {filtered.length === 0 ? (
        <EmptyState
          icon={Megaphone}
          title="No Campaigns Found"
          description="Generate UTM links with a utm_campaign parameter to see campaign analytics here."
        />
      ) : (
        <div className="grid gap-4">
          {filtered.map((c) => (
            <Card
              key={c.campaign}
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => navigate(`/campaigns/${encodeURIComponent(c.campaign)}`)}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-brand-purple/10 rounded-lg flex items-center justify-center">
                    <Megaphone className="w-5 h-5 text-brand-purple" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-slate-900">{c.campaign}</h3>
                    <p className="text-sm text-slate-500">
                      {c.first_link_created
                        ? `Since ${new Date(c.first_link_created).toLocaleDateString()}`
                        : 'No activity yet'}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-8 text-sm">
                  <div className="text-center">
                    <div className="flex items-center gap-1 text-slate-500"><Link2 className="h-3.5 w-3.5" /> Links</div>
                    <p className="font-bold text-slate-900">{c.total_links}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center gap-1 text-slate-500"><MousePointer className="h-3.5 w-3.5" /> Clicks</div>
                    <p className="font-bold text-slate-900">{c.total_clicks.toLocaleString()}</p>
                  </div>
                  <div className="text-center">
                    <div className="flex items-center gap-1 text-slate-500"><TrendingUp className="h-3.5 w-3.5" /> Rate</div>
                    <p className="font-bold text-slate-900">{c.click_rate.toFixed(1)}%</p>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
