import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Download, FileSpreadsheet } from 'lucide-react';
import { Card, CardHeader, CardTitle, Button } from '../components/ui';
import { FileUploadZone } from '../components/ui/FileUploadZone';
import { utmApi } from '../api/utm';

export function BulkPage() {
  const [isProcessing, setIsProcessing] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState('');

  const { data: presets = [] } = useQuery({
    queryKey: ['utm', 'presets'],
    queryFn: () => utmApi.getPresets(),
  });

  const handleDownloadTemplate = async () => {
    try {
      const blob = await utmApi.downloadTemplate();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'utm_template.csv';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Template downloaded');
    } catch {
      toast.error('Failed to download template');
    }
  };

  const handleFileSelected = async (file: File) => {
    setIsProcessing(true);
    try {
      const blob = await utmApi.processBulkCSV(file, selectedPresetId || undefined);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'utm_links.csv';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('CSV processed! Download started.');
    } catch {
      toast.error('Failed to process CSV. Make sure it has a "url" column.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-slate-900">Bulk UTM Generator</h1>
        <p className="text-slate-600 mt-1">
          Upload a CSV of URLs and batch-apply UTM parameters.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration</CardTitle>
        </CardHeader>
        <div className="space-y-4">
          {/* Preset selector */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Apply Preset (optional)
            </label>
            <select
              className="w-full max-w-md h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
              value={selectedPresetId}
              onChange={(e) => setSelectedPresetId(e.target.value)}
            >
              <option value="">-- No preset (use CSV columns) --</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.is_default ? '(default)' : ''}
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 mt-1">
              Preset values are used as defaults. Per-row UTM columns in the CSV override them.
            </p>
          </div>

          {/* Template download */}
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleDownloadTemplate} leftIcon={<Download className="h-4 w-4" />}>
              Download CSV Template
            </Button>
            <span className="text-xs text-slate-500">
              Template includes: url, utm_source, utm_medium, utm_campaign, utm_content, utm_term
            </span>
          </div>
        </div>
      </Card>

      {/* Upload zone */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5" />
            Upload CSV
          </CardTitle>
        </CardHeader>
        <FileUploadZone onFileSelected={handleFileSelected} isUploading={isProcessing} />
      </Card>

      {/* Instructions */}
      <Card className="bg-slate-50">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">How it works</h3>
        <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
          <li>Download the CSV template or prepare your own CSV with a <code className="bg-white px-1 py-0.5 rounded text-brand-purple">url</code> column.</li>
          <li>Optionally include <code className="bg-white px-1 py-0.5 rounded text-brand-purple">utm_source</code>, <code className="bg-white px-1 py-0.5 rounded text-brand-purple">utm_medium</code>, etc. columns for per-row overrides.</li>
          <li>Select a preset if you want default UTM values applied to all rows.</li>
          <li>Upload the CSV — a processed file with <code className="bg-white px-1 py-0.5 rounded text-brand-purple">tracked_url</code> column will download automatically.</li>
        </ol>
      </Card>
    </div>
  );
}
