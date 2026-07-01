import { useMemo, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import {
  BarChart3,
  Clock,
  Copy,
  Eye,
  FileText,
  FileVideo,
  FileCode,
  Image as ImageIcon,
  File as FileIcon,
  Trash2,
  FolderOpen,
  Plus,
  Save,
  X,
  Pencil,
  Inbox,
  GripVertical,
  CheckSquare,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  FileUploadZone,
  Input,
  LoadingSpinner,
  EmptyState,
  QrButton,
} from '../components/ui';
import { filesApi } from '../api/files';
import type { FileAsset, FileKind } from '../api/files';
import { utmApi } from '../api/utm';
import type { Domain, Project, ProjectCreate } from '../api/utm';

const KIND_ICON: Record<FileKind, typeof FileText> = {
  pdf: FileText,
  video: FileVideo,
  html: FileCode,
  image: ImageIcon,
  other: FileIcon,
};

const STATUS_VARIANT: Record<FileAsset['status'], 'default' | 'warning' | 'success' | 'danger'> = {
  pending_upload: 'warning',
  active: 'success',
  failed: 'danger',
  deleted: 'default',
};

const EMPTY_FORM: ProjectCreate = { name: '', description: '' };

// Sentinel filter values for the two synthetic folders. Real projects use
// their UUID, so these underscore-wrapped strings can't collide.
const FILTER_ALL = '';
const FILTER_UNFILED = '__unfiled__';

// Drop-target ids. Projects use their UUID; "Unfiled" uses this sentinel.
// "All files" is intentionally NOT a drop target (no meaningful action).
const DROP_UNFILED = '__unfiled__';

/** Shape dragged via the native DnD dataTransfer payload. */
interface DragPayload {
  fileIds: string[];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function FilesPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [progress, setProgress] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');

  // --- Data (react-query) ---
  const { data: files = [], isLoading } = useQuery<FileAsset[]>({
    queryKey: ['files'],
    queryFn: () => filesApi.list(),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
  });

  const { data: projects = [], isLoading: projectsLoading } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => utmApi.getProjects(),
  });

  const activeDomains = useMemo(
    () => domains.filter((d) => d.status === 'active'),
    [domains],
  );

  const refresh = useCallback(() => {
    // Counts (projects) and rows (files) both move when files are reassigned.
    queryClient.invalidateQueries({ queryKey: ['projects'] });
    queryClient.invalidateQueries({ queryKey: ['files'] });
  }, [queryClient]);

  // --- Project form state ---
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProjectCreate>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  // --- Filter ---
  const [filterProject, setFilterProject] = useState<string>(FILTER_ALL);

  // --- Per-row inline dropdown (non-drag fallback) ---
  const [movingFileId, setMovingFileId] = useState<string | null>(null);

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

  // Resolve a project name from the loaded projects (FileAsset only carries the
  // project_id, unlike links which embed project_name).
  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  // Live per-project file counts computed from the loaded files so they update
  // the instant a move's cache invalidation lands.
  const countByProject = useMemo(() => {
    const map = new Map<string, number>();
    for (const f of files) {
      if (f.project_id) map.set(f.project_id, (map.get(f.project_id) ?? 0) + 1);
    }
    return map;
  }, [files]);

  const unfiledCount = useMemo(
    () => files.filter((f) => !f.project_id).length,
    [files],
  );

  // Files after the active folder filter.
  const visibleFiles = useMemo(() => {
    return files.filter((f) => {
      if (filterProject === FILTER_UNFILED) return !f.project_id;
      if (filterProject !== FILTER_ALL) return f.project_id === filterProject;
      return true;
    });
  }, [files, filterProject]);

  const visibleIds = useMemo(() => visibleFiles.map((f) => f.id), [visibleFiles]);

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

  const toggleOne = (fileId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelectedIds(new Set());

  // ---------------------------------------------------------------
  // Move files to a folder (shared by DnD, the selection bar, and the
  // per-row dropdown). `targetId` is a project UUID, DROP_UNFILED, or ''.
  // ---------------------------------------------------------------

  const moveFiles = useCallback(
    async (fileIds: string[], targetId: string) => {
      if (fileIds.length === 0) return;
      const newProjectId = targetId === DROP_UNFILED || targetId === '' ? null : targetId;
      const targetProject = newProjectId ? projects.find((p) => p.id === newProjectId) : null;
      const destLabel = newProjectId ? (targetProject?.name ?? 'project') : 'Unfiled';

      try {
        await Promise.all(fileIds.map((id) => filesApi.updateFile(id, { project_id: newProjectId })));
        const n = fileIds.length;
        const noun = n === 1 ? 'file' : 'files';
        toast.success(
          newProjectId
            ? `Moved ${n} ${noun} to ${destLabel}`
            : `Moved ${n} ${noun} to Unfiled`,
        );
        // Drop the moved rows from the current selection so the bar resets.
        setSelectedIds((prev) => {
          const next = new Set(prev);
          for (const id of fileIds) next.delete(id);
          return next;
        });
        refresh();
      } catch {
        toast.error('Failed to move files');
      }
    },
    [projects, refresh],
  );

  // ---------------------------------------------------------------
  // Native HTML5 drag-and-drop
  // ---------------------------------------------------------------

  const handleDragStart = (e: React.DragEvent, fileId: string) => {
    // If the grabbed row is part of the current selection, drag the whole
    // selection. Otherwise drag just that single row (and it becomes the
    // effective payload without disturbing the existing selection).
    const dragIds = selectedIds.has(fileId) && selectedIds.size > 0
      ? Array.from(selectedIds)
      : [fileId];
    const payload: DragPayload = { fileIds: dragIds };
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
    if (!payload || !Array.isArray(payload.fileIds) || payload.fileIds.length === 0) return;

    // No-op guard: dropping onto the folder the files already live in.
    const destProjectId = targetId === DROP_UNFILED ? null : targetId;
    const draggedFiles = files.filter((f) => payload!.fileIds.includes(f.id));
    const allAlreadyThere =
      draggedFiles.length > 0 &&
      draggedFiles.every((f) => (f.project_id ?? null) === destProjectId);
    if (allAlreadyThere) {
      toast.message(
        destProjectId
          ? 'Already in this project'
          : 'Already unfiled',
      );
      return;
    }

    moveFiles(payload.fileIds, targetId);
  };

  // ---------------------------------------------------------------
  // File actions
  // ---------------------------------------------------------------

  const deleteMutation = useMutation({
    mutationFn: (id: string) => filesApi.delete(id),
    onSuccess: (_data, id) => {
      toast.success('File removed.');
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['files'] });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
    onError: () => toast.error('Could not remove file.'),
  });

  // Per-row dropdown fallback (single file). Reuses moveFiles for consistency.
  const handleRowAssign = async (fileId: string, targetId: string) => {
    setMovingFileId(null);
    await moveFiles([fileId], targetId);
  };

  async function handleFile(file: File) {
    setIsUploading(true);
    setProgress(0);
    try {
      const intent = await filesApi.initUpload({
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
        domain_id: selectedDomainId || undefined,
      });

      await filesApi.uploadBytes(
        intent.presigned_put_url,
        file,
        intent.headers,
        intent.upload_via_backend,
        (pct) => setProgress(pct),
      );

      const finalized = await filesApi.finalize(intent.file_id);
      toast.success('Uploaded. Your file is live.');
      // Optimistically push the new row in case the list refetch lags.
      queryClient.setQueryData<FileAsset[]>(['files'], (prev) => {
        const next = prev ? [finalized, ...prev.filter((f) => f.id !== finalized.id)] : [finalized];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ['files'] });
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail ?? 'Upload failed.');
    } finally {
      setIsUploading(false);
      setProgress(null);
    }
  }

  function copyUrl(url: string) {
    navigator.clipboard.writeText(url);
    toast.success('Copied link.');
  }

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
    if (!window.confirm('Delete this project? Files will be unassigned but not deleted.')) return;
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
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Files</h1>
        <p className="text-slate-600 mt-1">
          Host PDFs, videos, HTML, and images on your domain. Every view is tracked. Drag files onto a folder to file them.
        </p>
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Upload a file
          </CardTitle>
        </CardHeader>

        {activeDomains.length > 0 && (
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Host on
            </label>
            <select
              value={selectedDomainId}
              onChange={(e) => setSelectedDomainId(e.target.value)}
              disabled={isUploading}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple disabled:opacity-50"
            >
              <option value="">Platform default</option>
              {activeDomains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                  {d.is_primary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        <FileUploadZone
          onFileSelected={handleFile}
          isUploading={isUploading}
          accept=".pdf,.html,.htm,.mp4,.webm,.png,.jpg,.jpeg,.webp"
          label="Drop a PDF, video, HTML, or image here"
          hint="HTML up to 20 MB, PDF/image up to 10 MB, video up to 500 MB"
          uploadingLabel={
            progress !== null ? `Uploading... ${progress}%` : 'Uploading...'
          }
        />

        {progress !== null && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-brand-purple transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
      </Card>

      <div className="flex flex-col lg:flex-row gap-6">
        {/* Main pane: Files */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* Filter indicator */}
          {filterProject !== FILTER_ALL && (
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-slate-500">
                Filtered by{' '}
                <span className="font-medium text-slate-700">
                  {filterProject === FILTER_UNFILED
                    ? 'Unfiled'
                    : projectNameById.get(filterProject) ?? 'project'}
                </span>
              </span>
            </div>
          )}

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
                    moveFiles(selectedVisibleIds, target);
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

          {/* Files list */}
          <Card padding="none">
            <CardHeader className="px-6 pt-6">
              <div className="flex items-center justify-between gap-3">
                <CardTitle>Your files</CardTitle>
                {visibleFiles.length > 0 && (
                  <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      aria-label="Select all visible files"
                      checked={allVisibleSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someVisibleSelected;
                      }}
                      onChange={toggleAllVisible}
                      className="h-4 w-4 rounded border-gray-300 text-brand-purple focus:ring-brand-purple cursor-pointer"
                    />
                    Select all
                  </label>
                )}
              </div>
            </CardHeader>
            {isLoading ? (
              <div className="py-8">
                <LoadingSpinner />
              </div>
            ) : visibleFiles.length === 0 ? (
              filterProject !== FILTER_ALL ? (
                <div className="px-6">
                  <EmptyState
                    icon={FileText}
                    title="No Files Found"
                    description="No files match your current folder. Try a different folder or move files here."
                  />
                </div>
              ) : (
                <div className="py-8 text-center text-sm text-slate-500">
                  No files yet. Upload one above to get a trackable link.
                </div>
              )
            ) : (
              <div className="divide-y divide-slate-100">
                {visibleFiles.map((f) => (
                  <FileRow
                    key={f.id}
                    file={f}
                    projects={projects}
                    projectName={f.project_id ? projectNameById.get(f.project_id) ?? null : null}
                    isSelected={selectedIds.has(f.id)}
                    isMoving={movingFileId === f.id}
                    onToggleSelect={() => toggleOne(f.id)}
                    onStartMoving={() => setMovingFileId(f.id)}
                    onAssign={(target) => handleRowAssign(f.id, target)}
                    onCancelMoving={() => setMovingFileId(null)}
                    onDragStart={(e) => handleDragStart(e, f.id)}
                    onDragEnd={handleDragEnd}
                    onCopy={() => copyUrl(f.serve_url)}
                    onAnalytics={() => navigate(`/files/${f.id}/analytics`)}
                    onDelete={() => {
                      if (!window.confirm(`Remove ${f.filename}? Existing links will stop working.`)) {
                        return;
                      }
                      deleteMutation.mutate(f.id);
                    }}
                  />
                ))}
              </div>
            )}
          </Card>
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
                Drop on a folder to file the dragged files.
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

            {/* Synthetic folders: All files + Unfiled (always present, both are
                drop-aware where it makes sense). */}
            <div className="space-y-2">
              {/* All files (filter only, not a drop target) */}
              <button
                onClick={() => setFilterProject(FILTER_ALL)}
                className={folderClasses(filterProject === FILTER_ALL, false)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <FileIcon className={`h-4 w-4 ${filterProject === FILTER_ALL ? 'text-brand-purple' : 'text-slate-400'}`} />
                    <span className={`text-sm font-medium ${filterProject === FILTER_ALL ? 'text-brand-purple' : 'text-slate-700'}`}>
                      All files
                    </span>
                  </div>
                  <span className="text-xs text-slate-500">{files.length}</span>
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
                  const count = countByProject.get(project.id) ?? 0;
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
                                <FileIcon className="h-3 w-3" /> {count}
                              </span>
                            </div>
                          </div>
                        </button>
                        <div className="flex items-center gap-0.5 flex-shrink-0 ml-1">
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

interface FileRowProps {
  file: FileAsset;
  projects: Project[];
  projectName: string | null;
  isSelected: boolean;
  isMoving: boolean;
  onToggleSelect: () => void;
  onStartMoving: () => void;
  onAssign: (target: string) => void;
  onCancelMoving: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onCopy: () => void;
  onAnalytics: () => void;
  onDelete: () => void;
}

function FileRow({
  file,
  projects,
  projectName,
  isSelected,
  isMoving,
  onToggleSelect,
  onStartMoving,
  onAssign,
  onCancelMoving,
  onDragStart,
  onDragEnd,
  onCopy,
  onAnalytics,
  onDelete,
}: FileRowProps) {
  const Icon = KIND_ICON[file.kind] ?? FileIcon;
  const lastOpened = file.last_viewed_at
    ? `Opened ${formatDistanceToNow(new Date(file.last_viewed_at), { addSuffix: true })}`
    : 'Not opened yet';
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`group px-6 py-4 cursor-grab active:cursor-grabbing transition-colors ${
        isSelected ? 'bg-brand-purple/5' : 'hover:bg-gray-50'
      }`}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          {/* Select + grip */}
          <div className="flex items-center gap-1 pt-0.5">
            <GripVertical className="h-4 w-4 text-gray-300 group-hover:text-gray-400 flex-shrink-0" />
            <input
              type="checkbox"
              aria-label="Select file"
              checked={isSelected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className="h-4 w-4 rounded border-gray-300 text-brand-purple focus:ring-brand-purple cursor-pointer"
            />
          </div>
          <div className="h-10 w-10 rounded-lg bg-brand-purple/10 flex items-center justify-center flex-shrink-0">
            <Icon className="h-5 w-5 text-brand-purple" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm text-slate-900 truncate">
                {file.filename}
              </span>
              <Badge variant={STATUS_VARIANT[file.status]} size="sm">
                {file.status === 'active' ? 'Live' : file.status.replace('_', ' ')}
              </Badge>
              <Badge variant="default" size="sm">
                {file.kind.toUpperCase()}
              </Badge>
              {/* Project (per-row dropdown fallback) */}
              {isMoving ? (
                <select
                  autoFocus
                  className="rounded border border-brand-purple bg-white px-2 py-1 text-xs focus:outline-none"
                  defaultValue={file.project_id || ''}
                  onChange={(e) => onAssign(e.target.value)}
                  onBlur={onCancelMoving}
                  onClick={(e) => e.stopPropagation()}
                >
                  <option value="">No Project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartMoving();
                  }}
                  className="inline-flex items-center gap-1 text-left hover:text-brand-purple transition-colors"
                  title="Click to assign/change project"
                >
                  {projectName ? (
                    <Badge variant="info" size="sm">{projectName}</Badge>
                  ) : (
                    <span className="text-gray-400 text-xs flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" /> Assign
                    </span>
                  )}
                </button>
              )}
            </div>
            <div className="text-xs text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
              <span>{formatBytes(file.size_bytes)}</span>
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {file.view_count} {file.view_count === 1 ? 'view' : 'views'}
              </span>
              <span className="flex items-center gap-1" title={lastOpened}>
                <Clock className="h-3 w-3" />
                {lastOpened}
              </span>
              <span>
                {file.serve_mode === 'redirect' ? 'Redirect serve' : 'Stream serve'}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded px-2 py-1">
              <code className="text-xs font-mono text-slate-900 break-all flex-1">
                {file.serve_url}
              </code>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onCopy();
                }}
                className="text-slate-400 hover:text-slate-700"
                aria-label="Copy link"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
              <span onClick={(e) => e.stopPropagation()} className="inline-flex">
                <QrButton value={file.serve_url} filename={`${file.short_code}.svg`} />
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onAnalytics}
            className="text-brand-purple hover:text-brand-purple hover:bg-brand-purple/10"
            leftIcon={<BarChart3 className="h-4 w-4" />}
            title="View analytics"
          >
            Analytics
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            Remove
          </Button>
        </div>
      </div>
    </div>
  );
}
