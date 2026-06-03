import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Copy,
  Eye,
  FileText,
  FileVideo,
  FileCode,
  Image as ImageIcon,
  File as FileIcon,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, FileUploadZone } from '../components/ui';
import { filesApi } from '../api/files';
import type { FileAsset, FileKind } from '../api/files';
import { utmApi } from '../api/utm';
import type { Domain } from '../api/utm';

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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function FilesPage() {
  const queryClient = useQueryClient();
  const [progress, setProgress] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedDomainId, setSelectedDomainId] = useState<string>('');

  const { data: files = [], isLoading } = useQuery<FileAsset[]>({
    queryKey: ['files'],
    queryFn: () => filesApi.list(),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
  });

  const activeDomains = useMemo(
    () => domains.filter((d) => d.status === 'active'),
    [domains],
  );

  const deleteMutation = useMutation({
    mutationFn: (id: string) => filesApi.delete(id),
    onSuccess: () => {
      toast.success('File removed.');
      queryClient.invalidateQueries({ queryKey: ['files'] });
    },
    onError: () => toast.error('Could not remove file.'),
  });

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
      toast.success('Uploaded — your file is live.');
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

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">Files</h1>
        <p className="text-slate-600 mt-1">
          Host PDFs, videos, HTML, and images on your domain. Every view is tracked.
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
          hint="PDF/HTML/image ≤ 10 MB · video ≤ 500 MB"
          uploadingLabel={
            progress !== null ? `Uploading… ${progress}%` : 'Uploading…'
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

      <Card>
        <CardHeader>
          <CardTitle>Your files</CardTitle>
        </CardHeader>
        {isLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">Loading…</div>
        ) : files.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            No files yet. Upload one above to get a trackable link.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 -mx-6 -mb-6">
            {files.map((f) => (
              <FileRow
                key={f.id}
                file={f}
                onCopy={() => copyUrl(f.serve_url)}
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
  );
}

interface FileRowProps {
  file: FileAsset;
  onCopy: () => void;
  onDelete: () => void;
}

function FileRow({ file, onCopy, onDelete }: FileRowProps) {
  const Icon = KIND_ICON[file.kind] ?? FileIcon;
  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
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
            </div>
            <div className="text-xs text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
              <span>{formatBytes(file.size_bytes)}</span>
              <span className="flex items-center gap-1">
                <Eye className="h-3 w-3" />
                {file.view_count} {file.view_count === 1 ? 'view' : 'views'}
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
                onClick={onCopy}
                className="text-slate-400 hover:text-slate-700"
                aria-label="Copy link"
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-600 hover:text-red-700 hover:bg-red-50 flex-shrink-0"
          leftIcon={<Trash2 className="h-4 w-4" />}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}
