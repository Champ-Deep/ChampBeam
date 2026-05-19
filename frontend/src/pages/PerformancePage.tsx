import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Activity, ExternalLink, Copy, BarChart3, Trash2, FolderInput } from 'lucide-react';
import { toast } from 'sonner';
import { Card, Button, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { DateRangePicker } from '../components/ui/DateRangePicker';
import { ExportButton } from '../components/ui/ExportButton';
import { utmApi } from '../api/utm';
import type { LinkPerformanceItem, Project, DateRangeOpts } from '../api/utm';

export function PerformancePage() {
  const navigate = useNavigate();
  const [links, setLinks] = useState<LinkPerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<DateRangeOpts>({ days: 30 });
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string>('');
  const [movingLinkId, setMovingLinkId] = useState<string | null>(null);

  useEffect(() => {
    utmApi.getProjects().then(setProjects).catch(() => {});
  }, []);

  const loadLinks = useCallback(async () => {
    try {
      setLoading(true);
      const data = await utmApi.getLinkPerformance({
        projectId: projectId || undefined,
        ...dateRange,
      });
      setLinks(data);
    } catch {
      // Graceful
    } finally {
      setLoading(false);
    }
  }, [dateRange, projectId]);

  useEffect(() => { loadLinks(); }, [loadLinks]);

  const handleDelete = async (linkId: string, url: string) => {
    if (!window.confirm(`Delete link for "${url}"?\n\nThis will also delete all click tracking data for this link.`)) {
      return;
    }
    try {
      await utmApi.deleteLink(linkId);
      setLinks((prev) => prev.filter((l) => l.link_id !== linkId));
      toast.success('Link deleted');
    } catch {
      toast.error('Failed to delete link');
    }
  };

  const handleMoveToProject = async (linkId: string, newProjectId: string) => {
    try {
      await utmApi.updateLink(linkId, { project_id: newProjectId || null });
      const proj = projects.find((p) => p.id === newProjectId);
      setLinks((prev) =>
        prev.map((l) =>
          l.link_id === linkId
            ? { ...l, project_id: newProjectId || null, project_name: proj?.name || null }
            : l
        )
      );
      setMovingLinkId(null);
      toast.success(newProjectId ? `Moved to ${proj?.name}` : 'Removed from project');
    } catch {
      toast.error('Failed to update link');
    }
  };

  if (loading) return <div className="max-w-6xl mx-auto py-8 px-4"><LoadingSpinner /></div>;

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Link Performance</h1>
          <p className="text-slate-600 mt-1">View click performance for your tracked links.</p>
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
          <ExportButton onExport={() => utmApi.exportLinkPerformance({ projectId: projectId || undefined, ...dateRange })} />
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
                      {movingLinkId === link.link_id ? (
                        <select
                          autoFocus
                          className="rounded border border-brand-purple bg-white px-2 py-1 text-xs focus:outline-none"
                          defaultValue={link.project_id || ''}
                          onChange={(e) => handleMoveToProject(link.link_id, e.target.value)}
                          onBlur={() => setMovingLinkId(null)}
                        >
                          <option value="">No Project</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                      ) : (
                        <button
                          onClick={() => setMovingLinkId(link.link_id)}
                          className="inline-flex items-center gap-1 text-left hover:text-brand-purple transition-colors"
                          title="Click to change project"
                        >
                          {link.project_name ? (
                            <Badge variant="info" size="sm">{link.project_name}</Badge>
                          ) : (
                            <span className="text-gray-400 text-xs flex items-center gap-1">
                              <FolderInput className="h-3 w-3" /> Assign
                            </span>
                          )}
                        </button>
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
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => navigate(`/analytics/link/${link.link_id}`)}
                        >
                          <BarChart3 className="h-3.5 w-3.5 mr-1" />
                          Stats
                        </Button>
                        <button
                          onClick={() => handleDelete(link.link_id, link.original_url)}
                          className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          title="Delete link"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
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
