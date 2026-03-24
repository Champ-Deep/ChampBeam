import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ExternalLink, Copy, BarChart3 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, Button, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { utmApi } from '../api/utm';
import type { LinkPerformanceItem, Project } from '../api/utm';

export function PerformancePage() {
  const navigate = useNavigate();
  const [links, setLinks] = useState<LinkPerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');

  useEffect(() => {
    utmApi.getProjects().then(setProjects).catch(() => {});
  }, []);

  const loadLinks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await utmApi.getLinkPerformance({
        projectId: projectId || undefined,
        days: period,
      });
      setLinks(data);
    } catch {
      // Graceful
    } finally {
      setLoading(false);
    }
  }, [period, projectId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  if (loading) return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Link Performance</h1>
          <p className="text-slate-600 mt-1">View click performance for your tracked links.</p>
        </div>
        <div className="flex items-center gap-3">
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
      </div>

      {links.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No Link Data"
          description="Generate some UTM links first. Your tracked links and their performance will appear here."
        />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">URL</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Medium</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Campaign</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Project</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Clicks</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Unique</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Redirect URL</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {links.map((link, idx) => (
                  <tr key={idx} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm max-w-xs">
                      <a
                        href={link.tracked_url || link.original_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-purple hover:underline font-mono text-xs inline-flex items-center gap-1"
                        title={link.original_url}
                      >
                        {link.original_url.length > 50 ? link.original_url.slice(0, 50) + '...' : link.original_url}
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                      </a>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600">{link.utm_source || '--'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{link.utm_medium || '--'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{link.utm_campaign || '--'}</td>
                    <td className="px-4 py-3 text-sm">
                      {link.project_name ? (
                        <Badge variant="info" size="sm">{link.project_name}</Badge>
                      ) : (
                        <span className="text-gray-400">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-900 font-semibold text-right">
                      {link.click_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">
                      {link.unique_clicks.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-sm max-w-xs">
                      {link.redirect_url ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="font-mono text-xs text-gray-600 truncate max-w-[200px]" title={link.redirect_url}>
                            {link.redirect_url.length > 40 ? link.redirect_url.slice(0, 40) + '...' : link.redirect_url}
                          </span>
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(link.redirect_url!);
                              toast.success('Redirect URL copied');
                            }}
                            className="text-gray-400 hover:text-brand-purple flex-shrink-0"
                            title="Copy redirect URL"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </span>
                      ) : (
                        <span className="text-gray-400">--</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {link.created_at
                        ? new Date(link.created_at).toLocaleDateString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                          })
                        : '--'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(`/analytics/link/${link.link_id}`)}
                      >
                        <BarChart3 className="h-3.5 w-3.5 mr-1" />
                        View Stats
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
