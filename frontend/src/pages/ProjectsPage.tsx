import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil, Save, X, FolderOpen, ExternalLink, Link, MousePointerClick } from 'lucide-react';
import { Card, CardHeader, CardTitle, Button, Input, LoadingSpinner, EmptyState } from '../components/ui';
import { utmApi } from '../api/utm';
import type { Project, ProjectCreate } from '../api/utm';

const EMPTY_FORM: ProjectCreate = {
  name: '',
  description: '',
};

export function ProjectsPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ProjectCreate>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const loadProjects = useCallback(async () => {
    try {
      setLoading(true);
      const data = await utmApi.getProjects();
      setProjects(data);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  const handleSave = async () => {
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

  const handleEdit = (project: Project) => {
    setEditingId(project.id);
    setForm({
      name: project.name,
      description: project.description || '',
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Delete this project? Links inside will not be deleted, but they will be unassigned from this project.')) return;
    try {
      await utmApi.deleteProject(id);
      toast.success('Project deleted');
      await loadProjects();
    } catch {
      toast.error('Failed to delete project');
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (loading) return <div className="max-w-4xl mx-auto py-8 px-4"><LoadingSpinner /></div>;

  return (
    <div className="max-w-5xl mx-auto py-8 px-4 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Projects</h1>
          <p className="text-slate-600 mt-1">Organize your UTM links into projects for easy management.</p>
        </div>
        {!showForm && (
          <Button
            onClick={() => { setForm({ ...EMPTY_FORM }); setEditingId(null); setShowForm(true); }}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            New Project
          </Button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <Card padding="lg">
          <CardHeader>
            <CardTitle>{editingId ? 'Edit Project' : 'Create New Project'}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 gap-4">
            <Input
              label="Project Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Q1 Marketing Campaign"
            />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Description
              </label>
              <textarea
                value={form.description || ''}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional description for this project..."
                rows={3}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-purple-500 focus:outline-none focus:ring-1 focus:ring-purple-500"
              />
            </div>
          </div>
          <div className="flex items-center gap-3 mt-5">
            <Button onClick={handleSave} isLoading={saving} leftIcon={<Save className="h-4 w-4" />}>
              {editingId ? 'Update Project' : 'Save Project'}
            </Button>
            <Button variant="outline" onClick={handleCancel} leftIcon={<X className="h-4 w-4" />}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Project Cards */}
      {projects.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No Projects Yet"
          description="Create your first project to start organizing your UTM links into groups."
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {projects.map((project) => (
            <Card key={project.id} padding="none" className="hover:shadow-md transition-shadow">
              <div className="p-5">
                {/* Card Header */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="h-5 w-5 text-brand-purple flex-shrink-0" />
                    <h3 className="font-semibold text-gray-900 truncate">{project.name}</h3>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0 ml-2">
                    <button
                      onClick={() => handleEdit(project)}
                      className="p-1.5 text-slate-400 hover:text-brand-purple hover:bg-brand-purple/5 rounded-lg transition-colors"
                      title="Edit"
                    >
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(project.id)}
                      className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                      title="Delete"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {/* Description */}
                {project.description && (
                  <p className="text-sm text-gray-500 mb-4 line-clamp-2">{project.description}</p>
                )}
                {!project.description && <div className="mb-4" />}

                {/* Stats */}
                <div className="flex items-center gap-4 text-sm text-gray-600 mb-4">
                  <div className="flex items-center gap-1.5" title="Links">
                    <Link className="h-3.5 w-3.5 text-gray-400" />
                    <span>{project.link_count} {project.link_count === 1 ? 'link' : 'links'}</span>
                  </div>
                  <div className="flex items-center gap-1.5" title="Total Clicks">
                    <MousePointerClick className="h-3.5 w-3.5 text-gray-400" />
                    <span>{(project.total_clicks ?? 0).toLocaleString()} {project.total_clicks === 1 ? 'click' : 'clicks'}</span>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-gray-100">
                  <span className="text-xs text-gray-400">
                    Created {formatDate(project.created_at)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(`/projects/${project.id}`)}
                    leftIcon={<ExternalLink className="h-3.5 w-3.5" />}
                  >
                    View Links
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
