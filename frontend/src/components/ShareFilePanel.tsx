import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Clock, Copy, ExternalLink, Eye, FileText, Globe, MousePointerClick, UserPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, CardTitle } from './ui';
import { FileUploadZone } from './ui/FileUploadZone';
import { filesApi } from '../api/files';

const FILE_HISTORY_KEY = 'champutm_file_history';

interface SharedFile {
  fileId: string;
  shortCode: string;
  serveUrl: string;
  filename: string;
  ownerToken?: string | null;
  expiresAt?: string | null;
  uploadedAt: string;
}

function loadHistory(): SharedFile[] {
  try {
    const raw = localStorage.getItem(FILE_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SharedFile[]) : [];
  } catch {
    localStorage.removeItem(FILE_HISTORY_KEY);
    return [];
  }
}

function saveHistory(items: SharedFile[]): void {
  localStorage.setItem(FILE_HISTORY_KEY, JSON.stringify(items));
}

function expiresLabel(expiresAt?: string | null): string | null {
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  if (ms <= 0) return 'expired';
  const hrs = Math.round(ms / 3_600_000);
  if (hrs >= 1) return `expires in ${hrs}h`;
  return `expires in ${Math.max(1, Math.round(ms / 60_000))}m`;
}

/** Live "has it been opened?" badge that polls the status endpoint. */
function FileSeenBadge({ file }: { file: SharedFile }) {
  const { data, isError } = useQuery({
    queryKey: ['file-status', file.fileId],
    queryFn: () => filesApi.getStatus(file.fileId, file.ownerToken),
    refetchInterval: 15_000,
    retry: false,
  });

  if (isError) return <Badge variant="default" size="sm">Unavailable</Badge>;
  if (!data) return <Badge variant="default" size="sm">Checking…</Badge>;
  if (data.status === 'expired' || data.status === 'deleted') {
    return <Badge variant="default" size="sm">Expired</Badge>;
  }
  if (data.seen) {
    return <Badge variant="success" size="sm">Opened {data.view_count}×</Badge>;
  }
  return <Badge variant="warning" size="sm">Not opened yet</Badge>;
}

export function ShareFilePanel({ isAuthenticated }: { isAuthenticated: boolean }) {
  const [history, setHistory] = useState<SharedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  async function handleFile(file: File) {
    setIsUploading(true);
    setProgress(0);
    try {
      const intent = await filesApi.initUpload({
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
      });
      await filesApi.uploadBytes(
        intent.presigned_put_url,
        file,
        intent.headers,
        intent.upload_via_backend,
        (pct) => setProgress(pct),
      );
      const finalized = await filesApi.finalize(intent.file_id, intent.owner_token);

      const item: SharedFile = {
        fileId: finalized.id,
        shortCode: finalized.short_code,
        serveUrl: finalized.serve_url,
        filename: finalized.filename,
        ownerToken: intent.owner_token,
        expiresAt: intent.expires_at ?? finalized.expires_at ?? null,
        uploadedAt: new Date().toISOString(),
      };
      const next = [item, ...history.filter((h) => h.fileId !== item.fileId)].slice(0, 10);
      setHistory(next);
      saveHistory(next);
      navigator.clipboard.writeText(finalized.serve_url).catch(() => undefined);
      toast.success('File is live. Link copied to clipboard.');
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(detail ?? 'Upload failed.');
    } finally {
      setIsUploading(false);
      setProgress(null);
    }
  }

  const hint = isAuthenticated
    ? 'PDF ≤ 50 MB · image ≤ 10 MB · video ≤ 500 MB'
    : 'PDF/HTML/image ≤ 10 MB · video ≤ 50 MB · link expires in 24h';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText className="h-5 w-5" />
              Share a file
            </CardTitle>
          </CardHeader>
          <p className="text-sm text-slate-600 mb-4">
            Drop a file to get a short, trackable link. You will see the moment it is opened,
            no account needed to start.
          </p>
          <FileUploadZone
            onFileSelected={handleFile}
            isUploading={isUploading}
            accept=".pdf,.html,.htm,.mp4,.webm,.png,.jpg,.jpeg,.webp"
            label="Drop a PDF, video, HTML, or image here"
            hint={hint}
            uploadingLabel={progress !== null ? `Uploading… ${progress}%` : 'Uploading…'}
          />
          {progress !== null && (
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
              <div className="h-full bg-brand-purple transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </Card>

        {/* Fill the column consistently with what happens after a file is shared. */}
        <Card className="bg-slate-50">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">What happens after you share</h3>
          <ul className="space-y-3">
            {[
              { icon: MousePointerClick, text: 'Anyone with the link opens your file straight in the browser, no download needed.' },
              { icon: Eye, text: 'The Recent Files panel flips to "Opened" the moment it is viewed, with a live open count.' },
              { icon: Globe, text: 'Every open is logged with location and device so you know exactly who saw it.' },
            ].map((item) => {
              const Icon = item.icon;
              return (
                <li key={item.text} className="flex items-start gap-3">
                  <div className="h-6 w-6 rounded-md bg-brand-teal/10 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Icon className="h-3.5 w-3.5 text-brand-teal" />
                  </div>
                  <span className="text-sm text-slate-700">{item.text}</span>
                </li>
              );
            })}
          </ul>
        </Card>

        {!isAuthenticated && (
          <Card className="bg-brand-purple/5 border-brand-purple/20">
            <div className="flex items-center gap-4">
              <div className="h-12 w-12 bg-brand-purple/10 rounded-lg flex items-center justify-center flex-shrink-0">
                <UserPlus className="h-6 w-6 text-brand-purple" />
              </div>
              <div className="flex-1">
                <h3 className="text-sm font-semibold text-slate-900">Keep your files &amp; full analytics</h3>
                <p className="text-sm text-slate-600">
                  Sign up free to drop the 24-hour expiry, host on your own domain, and see geo +
                  device analytics on every open.
                </p>
              </div>
              <Link to="/sign-up">
                <Button size="sm">Sign Up Free</Button>
              </Link>
            </div>
          </Card>
        )}
      </div>

      <div>
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Recent Files
            </CardTitle>
          </CardHeader>
          {history.length === 0 ? (
            <div className="text-center text-sm text-slate-500 py-4">No files shared yet</div>
          ) : (
            <div className="divide-y divide-slate-100 -mx-6 -mb-6 max-h-[500px] overflow-y-auto">
              {history.map((f) => (
                <div key={f.fileId} className="px-6 py-4 group">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-sm font-medium text-slate-900 truncate" title={f.filename}>
                      {f.filename}
                    </span>
                    <FileSeenBadge file={f} />
                  </div>
                  <p
                    className="text-xs text-brand-purple font-mono break-all line-clamp-1 mb-2"
                    title={f.serveUrl}
                  >
                    {f.serveUrl}
                  </p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-400">
                      {expiresLabel(f.expiresAt) ?? 'Saved'}
                    </span>
                    <div className="flex items-center gap-1">
                      <a href={f.serveUrl} target="_blank" rel="noreferrer">
                        <Button variant="ghost" size="sm" className="h-6 px-2">
                          <ExternalLink className="h-3 w-3" />
                        </Button>
                      </a>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2"
                        onClick={() => {
                          navigator.clipboard.writeText(f.serveUrl);
                          toast.success('Copied');
                        }}
                      >
                        <Copy className="h-3 w-3 mr-1" />
                        Copy
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
