import { useState, useCallback, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Copy, BarChart3, Link2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, Button, EmptyState, LoadingSpinner } from '../components/ui';
import { utmApi } from '../api/utm';
import type { LinkPerformanceItem, Project } from '../api/utm';

export function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [links, setLinks] = useState<LinkPerformanceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState<7 | 30 | 90>(30);

  const loadData = useCallback(async () => {
    if (!projectId) return;
    try {
      setLoading(true);
      const [projects, linkData] = await Promise.all([
        utmApi.getProjects(),
        utmApi.getLinkPerformance({ projectId, days: period }),
      ]);
      const matched = projects.find((p) => p.id === projectId) ?? null;
      setProject(matched);
      setLinks(linkData);
    } catch {
      // Graceful
    } finally {
      setLoading(false);
    }
  }, [projectId, period]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const copyToClipboard = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success('Copied to clipboard');
  };

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto py-8 px-4">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/projects')}
          >
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
          <div>
            <h1 className="text-3xl font-bold text-slate-900">
              {project?.name ?? 'Project'}
            </h1>
            {project?.description && (
              <p className="text-slate-600 mt-1">{project.description}</p>
            )}
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

      {/* Links table */}
      {links.length === 0 ? (
        <EmptyState
          icon={Link2}
          title="No Links Yet"
          description="This project has no tracked links. Generate UTM links and assign them to this project to see them here."
        />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    URL
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Source
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Medium
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Campaign
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Redirect URL
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Clicks
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">
                    Unique
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                    Created
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {links.map((link) => (
                  <tr key={link.link_id} className="hover:bg-gray-50">
                    {/* URL */}
                    <td className="px-4 py-3 text-sm max-w-xs">
                      <a
                        href={link.tracked_url || link.original_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-brand-purple hover:underline font-mono text-xs inline-flex items-center gap-1"
                        title={link.original_url}
                      >
                        {link.original_url.length > 50
                          ? link.original_url.slice(0, 50) + '...'
                          : link.original_url}
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                      </a>
                    </td>

                    {/* Source */}
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {link.utm_source || '--'}
                    </td>

                    {/* Medium */}
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {link.utm_medium || '--'}
                    </td>

                    {/* Campaign */}
                    <td className="px-4 py-3 text-sm text-gray-600">
                      {link.utm_campaign || '--'}
                    </td>

                    {/* Redirect URL with copy button */}
                    <td className="px-4 py-3 text-sm">
                      {link.redirect_url ? (
                        <div className="flex items-center gap-1">
                          <span
                            className="font-mono text-xs text-slate-700 truncate max-w-[160px]"
                            title={link.redirect_url}
                          >
                            {link.redirect_url}
                          </span>
                          <button
                            type="button"
                            onClick={() => copyToClipboard(link.redirect_url!)}
                            className="text-slate-400 hover:text-brand-purple transition-colors flex-shrink-0"
                            title="Copy redirect URL"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <span className="text-gray-400">--</span>
                      )}
                    </td>

                    {/* Clicks */}
                    <td className="px-4 py-3 text-sm text-gray-900 font-semibold text-right">
                      {link.click_count.toLocaleString()}
                    </td>

                    {/* Unique */}
                    <td className="px-4 py-3 text-sm text-gray-600 text-right">
                      {link.unique_clicks.toLocaleString()}
                    </td>

                    {/* Created */}
                    <td className="px-4 py-3 text-sm text-gray-500">
                      {link.created_at
                        ? new Date(link.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })
                        : '--'}
                    </td>

                    {/* View Stats */}
                    <td className="px-4 py-3 text-sm">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          navigate(`/analytics/link/${link.link_id}`)
                        }
                      >
                        <BarChart3 className="h-4 w-4 mr-1" />
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
