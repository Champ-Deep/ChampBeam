import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  Link2, Copy, BarChart3, Trash2, FolderOpen, Plus, Save, X,
  Pencil, MousePointerClick, ExternalLink,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, Button, Input, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { utmApi } from '../api/utm';
import type { LinkPerformanceItem, Project, ProjectCreate } from '../api/utm';

const EMPTY_FORM: ProjectCreate = { name: '', description: '' };

export function LinksPage() {
  const navigate = useNavigate();

  // Links state
  const [links, setLinks] = useState<LinkPerformanceItem[]>([]);
  const [linksLoading, setLinksLoading] = useState(true);
  const [movingLinkId, setMovingLinkId] = useState<string | null>(null);

  // Projects state
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProjectCreate>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  // Filter
  const [filterProject, setFilterProject] = useState<string>('');
  const [search, setSearch] = useState('');

  const loadLinks = useCallback(async () => {
    try {
      setLinksLoading(true);
      const data = await utmApi.getLinkPerformance({
        projectId: filterProject || undefined,
        days: 365,
      });
      setLinks(data);
    } catch {
      // Graceful
    } finally {
      setLinksLoading(false);
    }
  }, [filterProject]);

  const loadProjects = useCallback(async () => {
    try {
      setProjectsLoading(true);
      const data = await utmApi.getProjects();
      setProjects(data);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => { loadLinks(); }, [loadLinks]);
  useEffect(() => { loadProjects(); }, [loadProjects]);

  // --- Link actions ---
  const handleDelete = async (linkId: string, url: string) => {
    if (!window.confirm(`Delete link for "${url}"?\n\nThis will also delete all click tracking data.`)) return;
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
      loadProjects(); // refresh project counts
    } catch {
      toast.error('Failed to update link');
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  // --- Project actions ---
  const handleSaveProject = async () => {
    if (!form.name.trim()) {
      toast.error('Project name is required');
      return;
    }
    try {
      setSaving(true);
      if (editingId) {
        await utmApi.updateProject(editingId, form);
        toast.success('Project updated');
      } else {
        await utmApi.createProject(form);
        toast.success('Project created');
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM });
      await loadProjects();
    } catch {
      toast.error('Failed to save project');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteProject = async (id: string) => {
    if (!window.confirm('Delete this project? Links will be unassigned but not deleted.')) return;
    try {
      await utmApi.deleteProject(id);
      toast.success('Project deleted');
      if (filterProject === id) setFilterProject('');
      await loadProjects();
    } catch {
      toast.error('Failed to delete project');
    }
  };

  const handleEditProject = (project: Project) => {
    setEditingId(project.id);
    setForm({ name: project.name, description: project.description || '' });
    setShowForm(true);
  };

  const handleCancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  };

  // Filtered links
  const filteredLinks = links.filter((l) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      l.original_url.toLowerCase().includes(q) ||
      (l.utm_source || '').toLowerCase().includes(q) ||
      (l.utm_medium || '').toLowerCase().includes(q) ||
      (l.utm_campaign || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="max-w-7xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Links</h1>
          <p className="text-slate-600 mt-1">Manage all your tracked UTM links and organize them into projects.</p>
        </div>
      </div>

      <div className="flex gap-6">
        {/* Main content — Links */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Search + filter */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              placeholder="Search links..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[200px] rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            />
            <select
              value={filterProject}
              onChange={(e) => setFilterProject(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 shadow-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            >
              <option value="">All Projects</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </div>

          {/* Links table */}
          {linksLoading ? (
            <LoadingSpinner />
          ) : filteredLinks.length === 0 ? (
            <EmptyState
              icon={Link2}
              title="No Links Found"
              description={search || filterProject
                ? "No links match your current filters. Try adjusting your search or project filter."
                : "Generate UTM links from the Generator to see them here."
              }
            />
          ) : (
            <Card padding="none">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">URL</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">UTM Params</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Project</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Redirect URL</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Clicks</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Unique</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {filteredLinks.map((link) => (
                      <tr key={link.link_id} className="hover:bg-gray-50 group">
                        {/* URL */}
                        <td className="px-4 py-3 text-sm max-w-[220px]">
                          <button
                            onClick={() => navigate(`/analytics/link/${link.link_id}`)}
                            className="text-brand-purple hover:underline font-mono text-xs inline-flex items-center gap-1 text-left"
                            title={link.original_url}
                          >
                            {link.original_url.length > 40
                              ? link.original_url.slice(0, 40) + '...'
                              : link.original_url}
                            <BarChart3 className="h-3 w-3 flex-shrink-0" />
                          </button>
                        </td>

                        {/* UTM Params (compact) */}
                        <td className="px-4 py-3 text-xs text-gray-500">
                          <div className="flex flex-wrap gap-1">
                            {link.utm_source && (
                              <span className="bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded">{link.utm_source}</span>
                            )}
                            {link.utm_medium && (
                              <span className="bg-green-50 text-green-700 px-1.5 py-0.5 rounded">{link.utm_medium}</span>
                            )}
                            {link.utm_campaign && (
                              <span className="bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded truncate max-w-[100px]" title={link.utm_campaign}>
                                {link.utm_campaign}
                              </span>
                            )}
                            {!link.utm_source && !link.utm_medium && !link.utm_campaign && (
                              <span className="text-gray-400">--</span>
                            )}
                          </div>
                        </td>

                        {/* Project */}
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
                              title="Click to assign/change project"
                            >
                              {link.project_name ? (
                                <Badge variant="info" size="sm">{link.project_name}</Badge>
                              ) : (
                                <span className="text-gray-400 text-xs flex items-center gap-1">
                                  <FolderOpen className="h-3 w-3" /> Assign
                                </span>
                              )}
                            </button>
                          )}
                        </td>

                        {/* Redirect URL */}
                        <td className="px-4 py-3 text-sm max-w-[180px]">
                          {link.redirect_url ? (
                            <div className="flex items-center gap-1">
                              <span
                                className="font-mono text-xs text-slate-700 truncate max-w-[140px]"
                                title={link.redirect_url}
                              >
                                {link.redirect_url}
                              </span>
                              <button
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
                                month: 'short', day: 'numeric',
                              })
                            : '--'}
                        </td>

                        {/* Actions */}
                        <td className="px-4 py-3 text-center">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              onClick={() => navigate(`/analytics/link/${link.link_id}`)}
                              className="p-1.5 text-gray-400 hover:text-brand-purple hover:bg-brand-purple/10 rounded transition-colors"
                              title="View analytics"
                            >
                              <BarChart3 className="h-3.5 w-3.5" />
                            </button>
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

        {/* Right sidebar — Projects */}
        <div className="w-72 flex-shrink-0 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wider">Projects</h2>
            {!showForm && (
              <button
                onClick={() => { setForm({ ...EMPTY_FORM }); setEditingId(null); setShowForm(true); }}
                className="p-1.5 text-slate-400 hover:text-brand-purple hover:bg-brand-purple/10 rounded-lg transition-colors"
                title="New project"
              >
                <Plus className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Create/Edit form */}
          {showForm && (
            <Card className="border-brand-purple/30">
              <div className="space-y-3">
                <Input
                  label="Name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Project name"
                />
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Description</label>
                  <textarea
                    value={form.description || ''}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Optional..."
                    rows={2}
                    className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
                  />
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveProject} isLoading={saving} leftIcon={<Save className="h-3.5 w-3.5" />}>
                    {editingId ? 'Update' : 'Create'}
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleCancelForm} leftIcon={<X className="h-3.5 w-3.5" />}>
                    Cancel
                  </Button>
                </div>
              </div>
            </Card>
          )}

          {/* Project cards */}
          {projectsLoading ? (
            <LoadingSpinner />
          ) : projects.length === 0 ? (
            <div className="text-center py-8">
              <FolderOpen className="h-8 w-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No projects yet</p>
              <button
                onClick={() => { setForm({ ...EMPTY_FORM }); setEditingId(null); setShowForm(true); }}
                className="text-sm text-brand-purple hover:underline mt-1"
              >
                Create your first project
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {/* "All Links" filter card */}
              <button
                onClick={() => setFilterProject('')}
                className={`w-full text-left rounded-lg border p-3 transition-all ${
                  !filterProject
                    ? 'border-brand-purple bg-brand-purple/5 shadow-sm'
                    : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Link2 className={`h-4 w-4 ${!filterProject ? 'text-brand-purple' : 'text-slate-400'}`} />
                  <span className={`text-sm font-medium ${!filterProject ? 'text-brand-purple' : 'text-slate-700'}`}>
                    All Links
                  </span>
                </div>
              </button>

              {projects.map((project) => (
                <div
                  key={project.id}
                  className={`rounded-lg border p-3 transition-all ${
                    filterProject === project.id
                      ? 'border-brand-purple bg-brand-purple/5 shadow-sm'
                      : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'
                  }`}
                >
                  <div className="flex items-start justify-between">
                    <button
                      onClick={() => setFilterProject(filterProject === project.id ? '' : project.id)}
                      className="flex items-center gap-2 text-left flex-1 min-w-0"
                    >
                      <FolderOpen className={`h-4 w-4 flex-shrink-0 ${
                        filterProject === project.id ? 'text-brand-purple' : 'text-slate-400'
                      }`} />
                      <div className="min-w-0">
                        <p className={`text-sm font-medium truncate ${
                          filterProject === project.id ? 'text-brand-purple' : 'text-slate-800'
                        }`}>
                          {project.name}
                        </p>
                        <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500">
                          <span className="flex items-center gap-0.5">
                            <Link2 className="h-3 w-3" /> {project.link_count}
                          </span>
                          <span className="flex items-center gap-0.5">
                            <MousePointerClick className="h-3 w-3" /> {project.total_clicks.toLocaleString()}
                          </span>
                        </div>
                      </div>
                    </button>
                    <div className="flex items-center gap-0.5 flex-shrink-0 ml-1">
                      <button
                        onClick={() => navigate(`/projects/${project.id}`)}
                        className="p-1 text-slate-400 hover:text-brand-purple rounded transition-colors"
                        title="View project detail"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => handleEditProject(project)}
                        className="p-1 text-slate-400 hover:text-brand-purple rounded transition-colors"
                        title="Edit"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                      <button
                        onClick={() => handleDeleteProject(project.id)}
                        className="p-1 text-slate-400 hover:text-red-600 rounded transition-colors"
                        title="Delete project"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
