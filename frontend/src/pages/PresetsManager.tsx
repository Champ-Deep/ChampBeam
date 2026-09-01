import { useState, useCallback, useEffect } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil, Star, Save, X, Tag } from 'lucide-react';
import { Card, CardHeader, CardTitle, Button, Badge, Input, LoadingSpinner, EmptyState, useConfirm } from '../components/ui';
import { utmApi } from '../api/utm';
import type { UTMPreset, UTMPresetCreate } from '../api/utm';

const EMPTY_FORM: UTMPresetCreate = {
  name: '',
  utm_source: '',
  utm_medium: '',
  utm_campaign: '',
  utm_content: '',
  utm_term: '',
};

/**
 * Preset CRUD management UI. Rendered as a section inside the Settings page.
 * Self-contained: owns its own data loading, form, and mutations. The generator
 * reads presets independently via utmApi.getPresets, so changes here flow through
 * react-query invalidation / refetch on the generator the next time it mounts.
 */
export function PresetsManager() {
  const confirm = useConfirm();
  const [presets, setPresets] = useState<UTMPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<UTMPresetCreate>({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);

  const loadPresets = useCallback(async () => {
    try {
      setLoading(true);
      const data = await utmApi.getPresets();
      setPresets(data);
    } catch {
      toast.error('Failed to load presets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPresets(); }, [loadPresets]);

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Preset name is required');
      return;
    }
    try {
      setSaving(true);
      if (editingId) {
        await utmApi.updatePreset(editingId, form);
        toast.success('Preset updated');
      } else {
        await utmApi.createPreset(form);
        toast.success('Preset created');
      }
      setShowForm(false);
      setEditingId(null);
      setForm({ ...EMPTY_FORM });
      await loadPresets();
    } catch {
      toast.error('Failed to save preset');
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (preset: UTMPreset) => {
    setEditingId(preset.id);
    setForm({
      name: preset.name,
      utm_source: preset.utm_source || '',
      utm_medium: preset.utm_medium || '',
      utm_campaign: preset.utm_campaign || '',
      utm_content: preset.utm_content || '',
      utm_term: preset.utm_term || '',
    });
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    if (!(await confirm({ message: 'Delete this preset?', confirmLabel: 'Delete' }))) return;
    try {
      await utmApi.deletePreset(id);
      toast.success('Preset deleted');
      await loadPresets();
    } catch {
      toast.error('Failed to delete preset');
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await utmApi.setDefaultPreset(id);
      toast.success('Default preset updated');
      await loadPresets();
    } catch {
      toast.error('Failed to set default');
    }
  };

  const handleCancel = () => {
    setShowForm(false);
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
  };

  if (loading) return <div className="py-8"><LoadingSpinner /></div>;

  return (
    <div className="space-y-6">
      {/* Section header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">UTM Presets</h2>
          <p className="text-slate-600 mt-1 text-sm">Save and reuse UTM parameter templates in the generator.</p>
        </div>
        {!showForm && (
          <Button
            onClick={() => { setForm({ ...EMPTY_FORM }); setEditingId(null); setShowForm(true); }}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Create Preset
          </Button>
        )}
      </div>

      {/* Form */}
      {showForm && (
        <Card padding="lg">
          <CardHeader>
            <CardTitle>{editingId ? 'Edit Preset' : 'Create New Preset'}</CardTitle>
          </CardHeader>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Input
              label="Preset Name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Google Ads Campaign"
            />
            <Input
              label="UTM Source"
              value={form.utm_source || ''}
              onChange={(e) => setForm({ ...form, utm_source: e.target.value })}
              placeholder="e.g. google"
            />
            <Input
              label="UTM Medium"
              value={form.utm_medium || ''}
              onChange={(e) => setForm({ ...form, utm_medium: e.target.value })}
              placeholder="e.g. cpc"
            />
            <Input
              label="UTM Campaign"
              value={form.utm_campaign || ''}
              onChange={(e) => setForm({ ...form, utm_campaign: e.target.value })}
              placeholder="e.g. spring-sale"
            />
            <Input
              label="UTM Content"
              value={form.utm_content || ''}
              onChange={(e) => setForm({ ...form, utm_content: e.target.value })}
              placeholder="Optional"
            />
            <Input
              label="UTM Term"
              value={form.utm_term || ''}
              onChange={(e) => setForm({ ...form, utm_term: e.target.value })}
              placeholder="Optional"
            />
          </div>
          <div className="flex items-center gap-3 mt-5">
            <Button onClick={handleSave} isLoading={saving} leftIcon={<Save className="h-4 w-4" />}>
              {editingId ? 'Update Preset' : 'Save Preset'}
            </Button>
            <Button variant="outline" onClick={handleCancel} leftIcon={<X className="h-4 w-4" />}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Table */}
      {presets.length === 0 ? (
        <EmptyState
          icon={Tag}
          title="No Presets Yet"
          description="Create your first UTM preset to save time when generating links."
        />
      ) : (
        <Card padding="none">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Source</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Medium</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Campaign</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Content</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Term</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">Default</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {presets.map((preset) => (
                  <tr key={preset.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-sm font-medium text-gray-900">{preset.name}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{preset.utm_source || '--'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{preset.utm_medium || '--'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600 font-mono text-xs">{preset.utm_campaign || '--'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{preset.utm_content || '--'}</td>
                    <td className="px-4 py-3 text-sm text-gray-600">{preset.utm_term || '--'}</td>
                    <td className="px-4 py-3 text-center">
                      {preset.is_default ? (
                        <Badge variant="success">Default</Badge>
                      ) : (
                        <button
                          onClick={() => handleSetDefault(preset.id)}
                          className="text-slate-400 hover:text-yellow-500 transition-colors"
                          title="Set as default"
                        >
                          <Star className="h-4 w-4" />
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEdit(preset)}
                          className="p-1.5 text-slate-400 hover:text-brand-purple hover:bg-brand-purple/5 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(preset.id)}
                          className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Delete"
                        >
                          <Trash2 className="h-4 w-4" />
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
