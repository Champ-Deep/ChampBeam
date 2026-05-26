import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Link2, MousePointer, ExternalLink, BarChart3, FolderOpen,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line,
} from 'recharts';
import { Card, CardHeader, CardTitle, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { ExportButton } from '../components/ui/ExportButton';
import { GeoChart } from '../components/ui/GeoChart';
import { utmApi } from '../api/utm';
import type {
  UTMOverview, UTMBreakdownItem, PerformanceOverTime,
  Project, GeoBreakdownItem, DateRangeOpts, LinkPerformanceItem,
} from '../api/utm';

const CHART_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];

type Tab = 'dashboard' | 'projects' | 'links';

export function AnalyticsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');

  // Shared filters
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 30 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');

  // Dashboard data
  const [overview, setOverview] = useState<UTMOverview | null>(null);
  const [sourceBreakdown, setSourceBreakdown] = useState<UTMBreakdownItem[]>([]);
  const [campaignBreakdown, setCampaignBreakdown] = useState<UTMBreakdownItem[]>([]);
  const [performanceData, setPerformanceData] = useState<PerformanceOverTime | null>(null);
  const [geoData, setGeoData] = useState<GeoBreakdownItem[]>([]);
  const [geoLevel, setGeoLevel] = useState<'country' | 'region' | 'city'>('country');
  const [dashLoading, setDashLoading] = useState(true);

  // Projects tab data
  const [projectOverviews, setProjectOverviews] = useState<Map<string, UTMOverview>>(new Map());
  const [projectsTabLoaded, setProjectsTabLoaded] = useState(false);

  // Links tab data
  const [linksList, setLinksList] = useState<LinkPerformanceItem[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksSearch, setLinksSearch] = useState('');

  useEffect(() => {
    utmApi.getProjects().then(setProjects).catch(() => {});
  }, []);

  // Load dashboard data
  const loadDashboard = useCallback(async () => {
    try {
      setDashLoading(true);
      const pid = projectId || undefined;
      const [overviewData, sources, campaigns, perf, geo] = await Promise.all([
        utmApi.getOverview(pid),
        utmApi.getBreakdown('source', { projectId: pid, ...dateRange }),
        utmApi.getBreakdown('campaign', { projectId: pid, ...dateRange }),
        utmApi.getPerformanceOverTime({ projectId: pid, ...dateRange }),
        utmApi.getGeoOverview({ projectId: pid, level: geoLevel, ...dateRange }),
      ]);
      setOverview(overviewData);
      setSourceBreakdown(sources);
      setCampaignBreakdown(campaigns);
      setPerformanceData(perf);
      setGeoData(geo);
    } catch {
      // Graceful failure
    } finally {
      setDashLoading(false);
    }
  }, [dateRange, projectId, geoLevel]);

  // Load per-project overviews (lazy — only when Projects tab is shown)
  const loadProjectOverviews = useCallback(async () => {
    if (projects.length === 0) return;
    const results = await Promise.allSettled(
      projects.map((p) => utmApi.getOverview(p.id))
    );
    const map = new Map<string, UTMOverview>();
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') map.set(projects[i].id, r.value);
    });
    setProjectOverviews(map);
    setProjectsTabLoaded(true);
  }, [projects]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  // Load links for the Links tab
  const loadLinks = useCallback(async () => {
    try {
      setLinksLoading(true);
      const data = await utmApi.getLinkPerformance({
        projectId: projectId || undefined,
        ...dateRange,
      });
      setLinksList(data);
    } catch {
      // graceful
    } finally {
      setLinksLoading(false);
    }
  }, [projectId, dateRange]);

  useEffect(() => {
    if (activeTab === 'links') loadLinks();
  }, [activeTab, loadLinks]);

  useEffect(() => {
    if (activeTab === 'projects' && !projectsTabLoaded) loadProjectOverviews();
  }, [activeTab, projectsTabLoaded, loadProjectOverviews]);

  const handleGeoLevelChange = async (level: 'country' | 'region' | 'city') => {
    setGeoLevel(level);
    try {
      const geo = await utmApi.getGeoOverview({ projectId: projectId || undefined, level, ...dateRange });
      setGeoData(geo);
    } catch {
      // graceful
    }
  };

  if (dashLoading && !overview) {
    return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;
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
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Analytics</h1>
          <p className="text-slate-600 mt-1">Track UTM performance across your links.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <DateRangePicker defaultDays={30} onRangeChange={setDateRange} />
          <ExportButton
            onExport={() =>
              activeTab === 'dashboard'
                ? utmApi.exportClickEvents({ projectId: projectId || undefined, ...dateRange })
                : utmApi.exportLinkPerformance({ projectId: projectId || undefined, ...dateRange })
            }
          />
        </div>
      </div>

      {/* Tab bar */}
      <div className="border-b border-slate-200">
        <div className="flex gap-6">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'dashboard'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <BarChart3 className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('projects')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'projects'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <FolderOpen className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Projects
            {projects.length > 0 && (
              <span className="ml-1.5 text-xs bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded-full">
                {projects.length}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab('links')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'links'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Link2 className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Links
          </button>
        </div>
      </div>

      {/* Dashboard tab */}
      {activeTab === 'dashboard' && (
        <>
          {!overview || overview.total_tracked_links === 0 ? (
            <EmptyState
              icon={BarChart3}
              title="No Analytics Data Yet"
              description="Generate some UTM links first — analytics will appear here once you have tracked links."
            />
          ) : (
            <>
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

              {/* Geo breakdown */}
              <Card>
                <CardHeader>
                  <CardTitle>Geographic Breakdown</CardTitle>
                  {geoData.length > 0 && (
                    <span className="text-sm text-slate-500">{geoData.length} locations</span>
                  )}
                </CardHeader>
                <GeoChart data={geoData} level={geoLevel} onLevelChange={handleGeoLevelChange} />
              </Card>

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
            </>
          )}
        </>
      )}

      {/* Links tab */}
      {activeTab === 'links' && (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <input
              type="text"
              placeholder="Search by URL or campaign..."
              value={linksSearch}
              onChange={(e) => setLinksSearch(e.target.value)}
              className="flex-1 min-w-[240px] max-w-md rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            />
            <p className="text-xs text-slate-500">
              Click any link to drill into its analytics.
            </p>
          </div>

          {linksLoading ? (
            <LoadingSpinner />
          ) : (() => {
            const q = linksSearch.trim().toLowerCase();
            const filtered = q
              ? linksList.filter((l) =>
                  l.original_url.toLowerCase().includes(q) ||
                  (l.utm_campaign || '').toLowerCase().includes(q) ||
                  (l.utm_source || '').toLowerCase().includes(q)
                )
              : linksList;

            if (filtered.length === 0) {
              return (
                <EmptyState
                  icon={Link2}
                  title={linksList.length === 0 ? 'No Links Yet' : 'No Matches'}
                  description={
                    linksList.length === 0
                      ? 'Generate UTM links from the Generator to see them here.'
                      : 'No links match your search. Try a different query.'
                  }
                />
              );
            }

            return (
              <Card padding="none">
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">URL</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">UTM Params</th>
                        <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Project</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Clicks</th>
                        <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Unique</th>
                        <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Analytics</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filtered.map((link) => (
                        <tr
                          key={link.link_id}
                          onClick={() => navigate(`/analytics/link/${link.link_id}`)}
                          className="hover:bg-brand-purple/5 cursor-pointer transition-colors"
                        >
                          <td className="px-4 py-3 text-sm max-w-[280px]">
                            <span
                              className="text-brand-purple font-mono text-xs inline-flex items-center gap-1.5"
                              title={link.original_url}
                            >
                              {link.original_url.length > 50
                                ? link.original_url.slice(0, 50) + '...'
                                : link.original_url}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">
                            <div className="flex flex-wrap gap-1">
                              {link.utm_source && (
                                <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{link.utm_source}</span>
                              )}
                              {link.utm_medium && (
                                <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">{link.utm_medium}</span>
                              )}
                              {link.utm_campaign && (
                                <span className="bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded truncate max-w-[140px]" title={link.utm_campaign}>
                                  {link.utm_campaign}
                                </span>
                              )}
                              {!link.utm_source && !link.utm_medium && !link.utm_campaign && (
                                <span className="text-gray-400">--</span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-sm">
                            {link.project_name ? (
                              <Badge variant="info" size="sm">{link.project_name}</Badge>
                            ) : (
                              <span className="text-gray-400 text-xs">--</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-900 font-semibold text-right">
                            {link.click_count.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-sm text-gray-600 text-right">
                            {link.unique_clicks.toLocaleString()}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <BarChart3 className="h-4 w-4 text-brand-purple inline" />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            );
          })()}
        </>
      )}

      {/* Projects tab */}
      {activeTab === 'projects' && (
        <>
          {projects.length === 0 ? (
            <EmptyState
              icon={FolderOpen}
              title="No Projects"
              description="Create projects from the Links page to see per-project analytics here."
            />
          ) : (
            <div className="grid gap-4">
              {projects.map((project) => {
                const po = projectOverviews.get(project.id);
                return (
                  <Card
                    key={project.id}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                    onClick={() => navigate(`/projects/${project.id}`)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-brand-purple/10 rounded-lg flex items-center justify-center">
                          <FolderOpen className="w-5 h-5 text-brand-purple" />
                        </div>
                        <div>
                          <h3 className="font-semibold text-slate-900">{project.name}</h3>
                          {project.description && (
                            <p className="text-sm text-slate-500 line-clamp-1">{project.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-8 text-sm">
                        <div className="text-center">
                          <div className="flex items-center gap-1 text-slate-500">
                            <Link2 className="h-3.5 w-3.5" /> Links
                          </div>
                          <p className="font-bold text-slate-900">{po?.total_tracked_links ?? project.link_count}</p>
                        </div>
                        <div className="text-center">
                          <div className="flex items-center gap-1 text-slate-500">
                            <MousePointer className="h-3.5 w-3.5" /> Clicks
                          </div>
                          <p className="font-bold text-slate-900">
                            {(po?.total_clicks ?? project.total_clicks).toLocaleString()}
                          </p>
                        </div>
                        <div className="text-center">
                          <div className="flex items-center gap-1 text-slate-500">
                            <ExternalLink className="h-3.5 w-3.5" /> Unique
                          </div>
                          <p className="font-bold text-slate-900">
                            {(po?.unique_clicks ?? 0).toLocaleString()}
                          </p>
                        </div>
                        <div className="text-center">
                          <div className="flex items-center gap-1 text-slate-500">
                            <BarChart3 className="h-3.5 w-3.5" /> Rate
                          </div>
                          <p className="font-bold text-slate-900">
                            {(po?.overall_click_rate ?? 0).toFixed(1)}%
                          </p>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
