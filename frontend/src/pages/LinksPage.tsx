import { useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Link2, Copy, BarChart3, Trash2, FolderOpen, Plus, Save, X,
  Pencil, MousePointerClick, ExternalLink, Inbox, GripVertical, CheckSquare,
} from 'lucide-react';
import { Card, Button, Input, Badge, LoadingSpinner, EmptyState } from '../components/ui';
import { utmApi } from '../api/utm';
import type { LinkPerformanceItem, Project, ProjectCreate } from '../api/utm';

const EMPTY_FORM: ProjectCreate = { name: '', description: '' };

// Sentinel filter values for the two synthetic folders. Real projects use
// their UUID, so these underscore-wrapped strings can't collide.
const FILTER_ALL = '';
const FILTER_UNFILED = '__unfiled__';

// Drop-target ids. Projects use their UUID; "Unfiled" uses this sentinel.
// "All links" is intentionally NOT a drop target (no meaningful action).
const DROP_UNFILED = '__unfiled__';

/** Shape dragged via the native DnD dataTransfer payload. */
interface DragPayload {
  linkIds: string[];
}

export function LinksPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // --- Data (react-query) ---
  // Fetch ALL links once (no project filter) so we can filter client-side by
  // each link's project_id and recompute per-project counts instantly after a
  // drag-and-drop move (we invalidate this cache on every mutation).
  const { data: links = [], isLoading: linksLoading } = useQuery<LinkPerformanceItem[]>({
    queryKey: ['utm', 'links', 365],
    queryFn: () => utmApi.getLinkPerformance({ days: 365 }),
  });

  const { data: projects = [], isLoading: projectsLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => utmApi.getProjects(),
  });

  const refresh = useCallback(() => {
    // Counts (projects) and rows (links) both move when links are reassigned.
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['utm', 'links'] });
  }, [queryClient]);

  // --- Project form state ---
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProjectCreate>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  // --- Filter + search ---
  const [filterProject, setFilterProject] = useState<string>(FILTER_ALL);
  const [search, setSearch] = useState('');

  // --- Per-row inline dropdown (non-drag fallback) ---
  const [movingLinkId, setMovingLinkId] = useState<string | null>(null);

  // --- Multi-select ---
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- Drag-and-drop ---
  // Which folder is currently under the cursor during a drag (for highlight),
  // and whether a drag is in progress at all (to surface drop hints).
  const [dragOverTarget, setDragOverTarget] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // ---------------------------------------------------------------
  // Derived data
  // ---------------------------------------------------------------

  // Live per-project link counts computed from the loaded links so they update
  // the instant a move's cache invalidation lands, with the server count as a
  // fallback when links are still loading.
  const countByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const l of links) {
      if (l.project_id) map.set(l.project_id, (map.get(l.project_id) ?? 0) + 1);
    }
    return map;
  }, [links]);

  const unfiledCount = useMemo(
    () => links.filter((l) => !l.project_id).length,
    [links],
  );

  // Links after the active folder filter + text search.
  const visibleLinks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return links.filter((l) => {
      // Folder filter
      if (filterProject === FILTER_UNFILED) {
        if (l.project_id) return false;
      } else if (filterProject !== FILTER_ALL) {
        if (l.project_id !== filterProject) return false;
      }
      // Text search
      if (!q) return true;
      return (
        l.original_url.toLowerCase().includes(q) ||
        (l.utm_source || '').toLowerCase().includes(q) ||
        (l.utm_medium || '').toLowerCase().includes(q) ||
        (l.utm_campaign || '').toLowerCase().includes(q)
      );
    });
  }, [links, filterProject, search]);

  const visibleIds = useMemo(() => visibleLinks.map((l) => l.link_id), [visibleLinks]);

  // Selection limited to what's currently visible (the basis for "select all"
  // and the bulk-move action), so a filter change can't act on hidden rows.
  const selectedVisibleIds = useMemo(
    () => visibleIds.filter((id) => selectedIds.has(id)),
    [visibleIds, selectedIds],
  );
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleIds.length === visibleIds.length;
  const someVisibleSelected = selectedVisibleIds.length > 0 && !allVisibleSelected;

  // ---------------------------------------------------------------
  // Selection helpers
  // ---------------------------------------------------------------

  const toggleOne = (linkId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(linkId)) next.delete(linkId);
      else next.add(linkId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        // Deselect everything currently visible.
        for (const id of visibleIds) next.delete(id);
      } else {
        // Select everything currently visible.
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  // ---------------------------------------------------------------
  // Move links to a folder (shared by DnD, the selection bar, and the
  // per-row dropdown). `targetId` is a project UUID, DROP_UNFILED, or ''.
  // ---------------------------------------------------------------

  const moveLinks = useCallback(
    async (linkIds: string[], targetId: string) => {
      if (linkIds.length === 0) return;
      const newProjectId = targetId === DROP_UNFILED || targetId === '' ? null : targetId;
      const targetProject = newProjectId ? projects.find((p) => p.id === newProjectId) : null;
      const destLabel = newProjectId ? (targetProject?.name ?? 'project') : 'Unfiled';

      try {
        await Promise.all(linkIds.map((id) => utmApi.updateLink(id, { project_id: newProjectId })));
        const n = linkIds.length;
        const noun = n === 1 ? 'link' : 'links';
        toast.success(
          newProjectId
            ? `Moved ${n} ${noun} to ${destLabel}`
            : `Moved ${n} ${noun} to Unfiled`,
        );
        // Drop the moved rows from the current selection so the bar resets.
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of linkIds) next.delete(id);
          return next;
        });
        refresh();
      } catch {
        toast.error('Failed to move links');
      }
    },
    [projects, refresh],
  );

  // ---------------------------------------------------------------
  // Native HTML5 drag-and-drop
  // ---------------------------------------------------------------

  const handleDragStart = (e: React.DragEvent, linkId: string) => {
    // If the grabbed row is part of the current selection, drag the whole
    // selection. Otherwise drag just that single row (and it becomes the
    // effective payload without disturbing the existing selection).
    const dragIds = selectedIds.has(linkId) && selectedIds.size > 0
      ? Array.from(selectedIds)
      : [linkId];
    const payload: DragPayload = { linkIds: dragIds };
    e.dataTransfer.setData('application/json', JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'move';
    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
    setDragOverTarget(null);
  };

  const handleFolderDragOver = (e: React.DragEvent, targetId: string) => {
    // Must preventDefault to allow a drop.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverTarget !== targetId) setDragOverTarget(targetId);
  };

  const handleFolderDragLeave = (targetId: string) => {
    setDragOverTarget((cur) => (cur === targetId ? null : cur));
  };

  const handleFolderDrop = (e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDragOverTarget(null);
    setIsDragging(false);
    let payload: DragPayload | null = null;
    try {
      payload = JSON.parse(e.dataTransfer.getData('application/json')) as DragPayload;
    } catch {
      payload = null;
    }
    if (!payload || !Array.isArray(payload.linkIds) || payload.linkIds.length === 0) return;

    // No-op guard: dropping onto the folder the links already live in.
    const destProjectId = targetId === DROP_UNFILED ? null : targetId;
    const draggedLinks = links.filter((l) => payload!.linkIds.includes(l.link_id));
    const allAlreadyThere =
      draggedLinks.length > 0 &&
      draggedLinks.every((l) => (l.project_id ?? null) === destProjectId);
    if (allAlreadyThere) {
      toast.message(
        destProjectId
          ? 'Already in this project'
          : 'Already unfiled',
      );
      return;
    }

    moveLinks(payload.linkIds, targetId);
  };

  // ---------------------------------------------------------------
  // Link actions
  // ---------------------------------------------------------------

  const handleDelete = async (linkId: string, url: string) => {
    if (!window.confirm(`Delete link for "${url}"?\n\nThis will also delete all click tracking data.`)) return;
    try {
      await utmApi.deleteLink(linkId);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(linkId);
        return next;
      });
      toast.success('Link deleted');
      refresh();
    } catch {
      toast.error('Failed to delete link');
    }
  };

  // Per-row dropdown fallback (single link). Reuses moveLinks for consistency.
  const handleRowAssign = async (linkId: string, targetId: string) => {
    setMovingLinkId(null);
    await moveLinks([linkId], targetId);
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success('Copied to clipboard');
  };

  // ---------------------------------------------------------------
  // Project CRUD
  // ---------------------------------------------------------------

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
      refresh();
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
      if (filterProject === id) setFilterProject(FILTER_ALL);
      refresh();
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

  const openCreateForm = () => {
    setForm({ ...EMPTY_FORM });
    setEditingId(null);
    setShowForm(true);
  };

  // ---------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------

  // Shared classes for a folder row, with a drop-target highlight ring.
  const folderClasses = (active: boolean, dropTarget: boolean) =>
    [
      'w-full text-left rounded-lg border p-3 transition-all',
      dropTarget
        ? 'border-brand-purple bg-brand-purple/10 ring-2 ring-brand-purple/40 shadow'
        : active
          ? 'border-brand-purple bg-brand-purple/5 shadow-sm'
          : 'border-slate-200 hover:border-slate-300 hover:shadow-sm',
    ].join(' ');

  return (
    <div className="max-w-7xl mx-auto py-8 px-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Links</h1>
          <p className="text-slate-600 mt-1">
            Manage all your tracked UTM links and organize them into projects. Drag links onto a folder to file them.
          </p>
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Main pane: Links */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Search */}
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              placeholder="Search links..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 min-w-[200px] rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
            />
            {filterProject !== FILTER_ALL && (
              <span className="text-xs text-slate-500">
                Filtered by{' '}
                <span className="font-medium text-slate-700">
                  {filterProject === FILTER_UNFILED
                    ? 'Unfiled'
                    : projects.find((p) => p.id === filterProject)?.name ?? 'project'}
                </span>
              </span>
            )}
          </div>

          {/* Selection bar */}
          {selectedVisibleIds.length > 0 && (
            <div className="flex items-center justify-between gap-3 flex-wrap rounded-lg border border-brand-purple/30 bg-brand-purple/5 px-3 py-2">
              <div className="flex items-center gap-2 text-sm text-slate-700">
                <CheckSquare className="h-4 w-4 text-brand-purple" />
                <span className="font-medium">{selectedVisibleIds.length}</span>
                <span>selected</span>
                <span className="hidden sm:inline text-slate-400">
                  · drag any selected row onto a folder, or pick a destination
                </span>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs text-slate-700 focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
                  value=""
                  onChange={(e) => {
                    if (e.target.value === '') return;
                    const target = e.target.value === DROP_UNFILED ? DROP_UNFILED : e.target.value;
                    moveLinks(selectedVisibleIds, target);
                    e.currentTarget.selectedIndex = 0;
                  }}
                >
                  <option value="">Move to...</option>
                  <option value={DROP_UNFILED}>Unfiled (no project)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
                <button
                  onClick={clearSelection}
                  className="text-xs text-slate-500 hover:text-slate-700 underline"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Links table */}
          {linksLoading ? (
            <LoadingSpinner />
          ) : visibleLinks.length === 0 ? (
            <EmptyState
              icon={Link2}
              title="No Links Found"
              description={search || filterProject !== FILTER_ALL
                ? "No links match your current filters. Try adjusting your search or folder."
                : "Generate UTM links from the Generator to see them here."
              }
            />
          ) : (
            <Card padding="none">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 w-10 text-left">
                        <input
                          type="checkbox"
                          aria-label="Select all visible links"
                          checked={allVisibleSelected}
                          ref={(el) => {
                            if (el) el.indeterminate = someVisibleSelected;
                          }}
                          onChange={toggleAllVisible}
                          className="h-4 w-4 rounded border-gray-300 text-brand-purple focus:ring-brand-purple cursor-pointer"
                        />
                      </th>
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
                    {visibleLinks.map((link) => {
                      const isSelected = selectedIds.has(link.link_id);
                      return (
                        <tr
                          key={link.link_id}
                          draggable
                          onDragStart={(e) => handleDragStart(e, link.link_id)}
                          onDragEnd={handleDragEnd}
                          className={`group cursor-grab active:cursor-grabbing transition-colors ${
                            isSelected ? 'bg-brand-purple/5' : 'hover:bg-gray-50'
                          }`}
                        >
                          {/* Select */}
                          <td className="px-3 py-3">
                            <div className="flex items-center gap-1">
                              <GripVertical className="h-4 w-4 text-gray-300 group-hover:text-gray-400 flex-shrink-0" />
                              <input
                                type="checkbox"
                                aria-label="Select link"
                                checked={isSelected}
                                onChange={() => toggleOne(link.link_id)}
                                onClick={(e) => e.stopPropagation()}
                                className="h-4 w-4 rounded border-gray-300 text-brand-purple focus:ring-brand-purple cursor-pointer"
                              />
                            </div>
                          </td>

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

                          {/* Project (per-row dropdown fallback) */}
                          <td className="px-4 py-3 text-sm">
                            {movingLinkId === link.link_id ? (
                              <select
                                autoFocus
                                className="rounded border border-brand-purple bg-white px-2 py-1 text-xs focus:outline-none"
                                defaultValue={link.project_id || ''}
                                onChange={(e) => handleRowAssign(link.link_id, e.target.value)}
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
                            {(link.click_count ?? 0).toLocaleString()}
                          </td>

                          {/* Unique */}
                          <td className="px-4 py-3 text-sm text-gray-600 text-right">
                            {(link.unique_clicks ?? 0).toLocaleString()}
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
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>

        {/* Right pane: Projects (folders) */}
        <div className="w-full lg:w-72 flex-shrink-0">
          <div className="lg:sticky lg:top-6 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FolderOpen className="h-4 w-4 text-slate-400" />
                <h2 className="text-sm font-semibold text-slate-900 uppercase tracking-wider">Projects</h2>
              </div>
              {!showForm && (
                <button
                  onClick={openCreateForm}
                  className="p-1.5 text-slate-400 hover:text-brand-purple hover:bg-brand-purple/10 rounded-lg transition-colors"
                  title="New project"
                >
                  <Plus className="h-4 w-4" />
                </button>
              )}
            </div>

            {isDragging && (
              <p className="text-xs text-brand-purple font-medium">
                Drop on a folder to file the dragged links.
              </p>
            )}

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

            {/* Synthetic folders: All links + Unfiled (always present, both are
                drop-aware where it makes sense). */}
            <div className="space-y-2">
              {/* All links (filter only, not a drop target) */}
              <button
                onClick={() => setFilterProject(FILTER_ALL)}
                className={folderClasses(filterProject === FILTER_ALL, false)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Link2 className={`h-4 w-4 ${filterProject === FILTER_ALL ? 'text-brand-purple' : 'text-slate-400'}`} />
                    <span className={`text-sm font-medium ${filterProject === FILTER_ALL ? 'text-brand-purple' : 'text-slate-700'}`}>
                      All links
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">{links.length}</span>
                </div>
              </button>

              {/* Unfiled (filter + drop target -> project_id null) */}
              <button
                onClick={() => setFilterProject(FILTER_UNFILED)}
                onDragOver={(e) => handleFolderDragOver(e, DROP_UNFILED)}
                onDragLeave={() => handleFolderDragLeave(DROP_UNFILED)}
                onDrop={(e) => handleFolderDrop(e, DROP_UNFILED)}
                className={folderClasses(filterProject === FILTER_UNFILED, dragOverTarget === DROP_UNFILED)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Inbox className={`h-4 w-4 ${filterProject === FILTER_UNFILED ? 'text-brand-purple' : 'text-slate-400'}`} />
                    <span className={`text-sm font-medium ${filterProject === FILTER_UNFILED ? 'text-brand-purple' : 'text-slate-700'}`}>
                      Unfiled
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">{unfiledCount}</span>
                </div>
              </button>
            </div>

            {/* Project folders */}
            {projectsLoading ? (
              <LoadingSpinner />
            ) : projects.length === 0 ? (
              <div className="text-center py-6 border border-dashed border-slate-200 rounded-lg">
                <FolderOpen className="h-8 w-8 text-slate-300 mx-auto mb-2" />
                <p className="text-sm text-slate-500">No projects yet</p>
                <button
                  onClick={openCreateForm}
                  className="text-sm text-brand-purple hover:underline mt-1"
                >
                  Create your first project
                </button>
              </div>
            ) : (
              <div className="space-y-2">
                {projects.map((project) => {
                  const active = filterProject === project.id;
                  const isDropTarget = dragOverTarget === project.id;
                  // Prefer the live client-side count; fall back to the
                  // server's count when links haven't loaded yet.
                  const count = links.length > 0
                    ? (countByProject.get(project.id) ?? 0)
                    : project.link_count;
                  return (
                    <div
                      key={project.id}
                      onDragOver={(e) => handleFolderDragOver(e, project.id)}
                      onDragLeave={() => handleFolderDragLeave(project.id)}
                      onDrop={(e) => handleFolderDrop(e, project.id)}
                      className={folderClasses(active, isDropTarget)}
                    >
                      <div className="flex items-start justify-between">
                        <button
                          onClick={() => setFilterProject(active ? FILTER_ALL : project.id)}
                          className="flex items-center gap-2 text-left flex-1 min-w-0"
                        >
                          <FolderOpen className={`h-4 w-4 flex-shrink-0 ${
                            active || isDropTarget ? 'text-brand-purple' : 'text-slate-400'
                          }`} />
                          <div className="min-w-0">
                            <p className={`text-sm font-medium truncate ${
                              active || isDropTarget ? 'text-brand-purple' : 'text-slate-800'
                            }`}>
                              {project.name}
                            </p>
                            <div className="flex items-center gap-3 mt-0.5 text-xs text-slate-500">
                              <span className="flex items-center gap-0.5">
                                <Link2 className="h-3 w-3" /> {count}
                              </span>
                              <span className="flex items-center gap-0.5">
                                <MousePointerClick className="h-3 w-3" /> {(project.total_clicks ?? 0).toLocaleString()}
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
                            title="Rename / edit"
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
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
