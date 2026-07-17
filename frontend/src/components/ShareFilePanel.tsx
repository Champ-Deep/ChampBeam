import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BarChart3,
  Check,
  Copy,
  ExternalLink,
  Eye,
  FileText,
  Sparkles,
  UserPlus,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, CardHeader, CardTitle, QrCode, QrButton, QrDownloadButton } from './ui';
import { FileUploadZone } from './ui/FileUploadZone';
import { UPLOAD_ACCEPT, UPLOAD_HINT_COMPACT, UPLOAD_HINT_GUEST, UPLOAD_LABEL } from '../config/uploadLimits';
import { filesApi } from '../api/files';

const FILE_HISTORY_KEY = 'champbeam_file_history';

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

/**
 * The centerpiece result for a just-shared file: short URL large + monospaced
 * with a Copy button, the QR code with Download, and a prominent read receipt
 * that polls the file status endpoint ("Seen" vs "Not opened yet").
 */
function FileResultCard({ file }: { file: SharedFile }) {
  const { data } = useQuery({
    queryKey: ['file-status', file.fileId],
    queryFn: () => filesApi.getStatus(file.fileId, file.ownerToken),
    refetchInterval: 10_000,
    retry: false,
  });

  const seen = !!data?.seen;
  const viewCount = data?.view_count ?? 0;

  const handleCopy = () => {
    navigator.clipboard.writeText(file.serveUrl);
    toast.success('Link copied');
  };

  return (
    <Card className="border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 to-brand-teal/5">
      <div className="flex items-center gap-2 mb-5">
        <div className="h-9 w-9 rounded-lg bg-brand-purple/10 flex items-center justify-center">
          <Sparkles className="h-5 w-5 text-brand-purple" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">Your file is live</h3>
          <p className="text-xs text-slate-500 truncate" title={file.filename}>
            {file.filename}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-5 items-start">
        <div className="min-w-0 space-y-4">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Share link
            </p>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-4 py-3 font-mono text-base sm:text-lg font-semibold text-brand-purple break-all">
                {file.serveUrl}
              </div>
              <Button onClick={handleCopy} leftIcon={<Copy className="h-4 w-4" />} className="flex-shrink-0">
                Copy
              </Button>
            </div>
          </div>

          {/* Prominent read receipt. */}
          <div
            className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
              seen ? 'border-green-200 bg-green-50' : 'border-slate-200 bg-white'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              {seen ? (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-green-100 flex-shrink-0">
                  <Check className="h-4 w-4 text-green-600" />
                </span>
              ) : (
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-100 flex-shrink-0">
                  <Eye className="h-4 w-4 text-slate-400" />
                </span>
              )}
              <div className="min-w-0">
                <p className={`text-sm font-semibold ${seen ? 'text-green-700' : 'text-slate-700'}`}>
                  {seen ? 'Seen' : 'Not opened yet'}
                </p>
                <p className="text-xs text-slate-500">
                  {seen
                    ? `Opened ${viewCount.toLocaleString()} ${viewCount === 1 ? 'time' : 'times'}`
                    : 'Live read receipt, updates the moment it is opened'}
                </p>
              </div>
            </div>
            <Link to={`/files/${file.fileId}/analytics`} className="flex-shrink-0">
              <Button variant="outline" size="sm" leftIcon={<BarChart3 className="h-4 w-4" />}>
                View analytics
              </Button>
            </Link>
          </div>

          <div className="flex items-center gap-3">
            <a href={file.serveUrl} target="_blank" rel="noreferrer">
              <Button variant="ghost" size="sm" leftIcon={<ExternalLink className="h-4 w-4" />}>
                Open file
              </Button>
            </a>
            {expiresLabel(file.expiresAt) && (
              <span className="text-xs text-slate-500">{expiresLabel(file.expiresAt)}</span>
            )}
          </div>
        </div>

        {/* QR code + download */}
        <div className="flex flex-col items-center gap-2">
          <QrCode value={file.serveUrl} size={150} />
          <QrDownloadButton value={file.serveUrl} filename={`${file.shortCode}.svg`} />
        </div>
      </div>
    </Card>
  );
}

/**
 * File-share state lifted into a hook so the creator card and the recent-files
 * list can live in separate columns of the home page while sharing one history,
 * upload progress, and "most recently shared" result.
 */
export function useFileShareHistory() {
  const [history, setHistory] = useState<SharedFile[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  // The most recently shared file, surfaced as the centerpiece result card.
  const [lastShared, setLastShared] = useState<SharedFile | null>(null);

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
      setHistory((prev) => {
        const next = [item, ...prev.filter((h) => h.fileId !== item.fileId)].slice(0, 10);
        saveHistory(next);
        return next;
      });
      setLastShared(item);
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

  return { history, lastShared, isUploading, progress, handleFile };
}

type FileShareState = ReturnType<typeof useFileShareHistory>;

/**
 * The "Share a file" creator: drop zone, inline result card once a file is
 * finalized, and (for guests) the sign-up nudge. Designed to stack in the home
 * page's main column directly beneath the link shortener.
 */
export function ShareFileCreator({
  isAuthenticated,
  share,
}: {
  isAuthenticated: boolean;
  share: FileShareState;
}) {
  const { lastShared, isUploading, progress, handleFile } = share;

  const hint = isAuthenticated ? UPLOAD_HINT_COMPACT : UPLOAD_HINT_GUEST;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            Share a file
          </CardTitle>
        </CardHeader>
        <p className="text-sm text-slate-600 mb-4">
          Drop a file to get a short, trackable link plus a QR code. You will see the moment it is
          opened, no account needed to start.
        </p>
        <FileUploadZone
          onFileSelected={handleFile}
          isUploading={isUploading}
          accept={UPLOAD_ACCEPT}
          label={UPLOAD_LABEL}
          hint={hint}
          uploadingLabel={progress !== null ? `Uploading… ${progress}%` : 'Uploading…'}
        />
        {progress !== null && (
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
            <div className="h-full bg-brand-purple transition-all" style={{ width: `${progress}%` }} />
          </div>
        )}
      </Card>

      {/* The result card appears inline directly beneath this creator. */}
      {lastShared && <FileResultCard file={lastShared} />}

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
  );
}

/** The "Your files" list for the home page sidebar, driven by shared history. */
export function RecentFilesCard({
  share,
  isAuthenticated = false,
}: {
  share: FileShareState;
  isAuthenticated?: boolean;
}) {
  const { history } = share;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Your files
        </CardTitle>
      </CardHeader>
      {history.length === 0 ? (
        <div className="text-center text-sm text-slate-500 py-4">
          No files shared yet
          {isAuthenticated && (
            <>
              {'. '}
              <Link to="/files" className="text-brand-purple hover:underline">
                Manage all files
              </Link>
            </>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-100 -mx-6 -mb-6">
          {history.map((f) => (
            <div key={f.fileId} className="px-6 py-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
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
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => {
                      navigator.clipboard.writeText(f.serveUrl);
                      toast.success('Copied');
                    }}
                    title="Copy link"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <QrButton value={f.serveUrl} filename={`${f.shortCode}.svg`} />
                  <Link to={`/files/${f.fileId}/analytics`} title="View analytics">
                    <Button variant="ghost" size="sm" className="h-7 px-2 text-brand-purple">
                      <BarChart3 className="h-3.5 w-3.5" />
                    </Button>
                  </Link>
                  <a href={f.serveUrl} target="_blank" rel="noreferrer" title="Open file">
                    <Button variant="ghost" size="sm" className="h-7 px-2">
                      <ExternalLink className="h-3.5 w-3.5" />
                    </Button>
                  </a>
                </div>
              </div>
            </div>
          ))}
          {isAuthenticated && (
            <Link
              to="/files"
              className="block px-6 py-3 text-sm text-brand-purple hover:underline"
            >
              Manage all files
            </Link>
          )}
        </div>
      )}
    </Card>
  );
}
