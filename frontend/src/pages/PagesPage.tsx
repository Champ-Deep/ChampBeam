import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  BarChart3,
  Clock,
  Code2,
  Copy,
  Eye,
  Globe,
  History,
  KeyRound,
  Pencil,
  RefreshCw,
  Repeat,
  Timer,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  CardTitle,
  EmptyState,
  FileUploadZone,
  Input,
  LoadingSpinner,
  QrButton,
} from '../components/ui';
import { pagesApi } from '../api/pages';
import type { BeamPage, PagePatch, PageVersion } from '../api/pages';
import { utmApi } from '../api/utm';
import type { Domain } from '../api/utm';
import { apiErrorDetail, apiErrorStatus } from '../api/_shared';
import { PAGE_ACCEPT, PAGE_CAP_MB, PAGE_HINT, PAGE_LABEL } from '../config/uploadLimits';
import { formatBytes, formatDwell, formatRelative } from '../lib/format';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const BEAM_STATE_DOCS_URL = 'https://github.com/Champ-Deep/ChampUTM/blob/main/docs/API.md#pages';

type PublishMode = 'upload' | 'paste';
type RowPanel = { mode: 'idle' } | { mode: 'edit' } | { mode: 'versions' };

function isHtmlFile(file: File): boolean {
  return /\.html?$/i.test(file.name) || file.type === 'text/html';
}

/** Map backend publish failures to copy a marketer can act on. */
function publishErrorMessage(err: unknown): string {
  const status = apiErrorStatus(err);
  const detail = apiErrorDetail(err) ?? '';
  if (status === 413) return `File too large (${PAGE_CAP_MB} MB max).`;
  if (/server-side|php/i.test(detail)) return 'This looks like server-side code. Beam Pages serves static HTML only.';
  return detail || 'Publish failed.';
}

export function PagesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: pages = [], isLoading } = useQuery({ queryKey: ['pages'], queryFn: () => pagesApi.list() });
  const { data: domains = [] } = useQuery({ queryKey: ['domains'], queryFn: () => utmApi.listDomains() });
  const activeDomains = useMemo(() => domains.filter((d) => d.status === 'active'), [domains]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['pages'] });

  const createMutation = useMutation({
    mutationFn: (data: { html: string; title?: string; domain_id?: string }) => pagesApi.create(data),
    onSuccess: (created) => {
      toast.success('Published. Your page is live.');
      queryClient.setQueryData<BeamPage[]>(['pages'], (prev) => [created, ...(prev ?? []).filter((p) => p.page_id !== created.page_id)]);
      invalidate();
    },
    onError: (err: unknown) => toast.error(publishErrorMessage(err)),
  });

  const replaceMutation = useMutation({
    mutationFn: ({ id, html }: { id: string; html: string }) => pagesApi.update(id, { html }),
    onSuccess: () => {
      toast.success('Page updated. Same link, new content.');
      invalidate();
    },
    onError: (err: unknown) => toast.error(publishErrorMessage(err)),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: PagePatch }) => pagesApi.patch(id, data),
    onSuccess: () => invalidate(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => pagesApi.delete(id),
    onSuccess: () => {
      toast.success('Page removed.');
      invalidate();
    },
    onError: (err: unknown) => toast.error(apiErrorDetail(err) ?? 'Could not remove page.'),
  });

  const rollbackMutation = useMutation({
    mutationFn: ({ id, version }: { id: string; version: number }) => pagesApi.rollback(id, version),
    onSuccess: (_, { id }) => {
      toast.success('Rolled back. The link now serves that version.');
      queryClient.invalidateQueries({ queryKey: ['pages', id, 'versions'] });
      invalidate();
    },
    onError: (err: unknown) => toast.error(apiErrorDetail(err) ?? 'Rollback failed.'),
  });

  const copyUrl = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('Could not copy link.');
    }
  };

  return (
    <div className="max-w-5xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Pages</h1>
        <p className="text-slate-600 mt-1">
          Publish a single HTML file on your domain. Every open is tracked — views, revisits and time on page — and
          Beam State (comments + shared checklist state) is on by default.
        </p>
      </div>

      <PublishCard
        domains={activeDomains}
        isPublishing={createMutation.isPending}
        onPublish={(data) => createMutation.mutate(data)}
      />

      <Card padding="none">
        <div className="p-6 pb-0">
          <CardHeader>
            <CardTitle>Your pages</CardTitle>
            {pages.length > 0 && <span className="text-sm text-slate-500">{pages.length} {pages.length === 1 ? 'page' : 'pages'}</span>}
          </CardHeader>
        </div>
        {isLoading ? (
          <div className="py-10"><LoadingSpinner /></div>
        ) : pages.length === 0 ? (
          <div className="px-6 pb-6">
            <EmptyState
              icon={Globe}
              title="No pages yet"
              description="Drop an .html file above to publish it on your domain with view, dwell and revisit tracking."
            />
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {pages.map((page) => (
              <PageRow
                key={page.page_id}
                page={page}
                onCopy={() => copyUrl(page.url)}
                onAnalytics={() => navigate(`/pages/${page.page_id}/analytics`)}
                onReplace={(html) => replaceMutation.mutate({ id: page.page_id, html })}
                onPatch={(data) => patchMutation.mutateAsync({ id: page.page_id, data })}
                onDelete={() => {
                  if (window.confirm(`Remove "${page.title}"? Its URL will stop working.`)) {
                    deleteMutation.mutate(page.page_id);
                  }
                }}
                onRollback={(version) => rollbackMutation.mutate({ id: page.page_id, version })}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Publish card
// ---------------------------------------------------------------------------

interface PublishCardProps {
  domains: Domain[];
  isPublishing: boolean;
  onPublish: (data: { html: string; title?: string; domain_id?: string }) => void;
}

function PublishCard({ domains, isPublishing, onPublish }: PublishCardProps) {
  const [mode, setMode] = useState<PublishMode>('upload');
  const [title, setTitle] = useState('');
  const [domainId, setDomainId] = useState('');
  const [pasted, setPasted] = useState('');

  const submit = (html: string, fallbackTitle?: string) => {
    onPublish({
      html,
      title: title.trim() || fallbackTitle || undefined,
      domain_id: domainId || undefined,
    });
  };

  const handleFile = async (file: File) => {
    if (!isHtmlFile(file)) {
      toast.error('Only .html files can be published.');
      return;
    }
    if (file.size > PAGE_CAP_MB * 1024 * 1024) {
      toast.error(`Over ${PAGE_CAP_MB} MB. Pages must be a single HTML file under ${PAGE_CAP_MB} MB.`);
      return;
    }
    submit(await file.text(), file.name.replace(/\.html?$/i, '').replace(/[-_]+/g, ' '));
  };

  const modeButton = (value: PublishMode, label: string, Icon: typeof Upload) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
        mode === value ? 'bg-brand-purple/10 text-brand-purple' : 'text-slate-500 hover:text-slate-700'
      }`}
    >
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          Publish a page
        </CardTitle>
        <div className="flex items-center gap-1">
          {modeButton('upload', 'Upload file', Upload)}
          {modeButton('paste', 'Paste HTML', Code2)}
        </div>
      </CardHeader>

      <div className="grid gap-4 sm:grid-cols-2 mb-4">
        <Input
          label="Title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Q3 onboarding checklist"
          maxLength={200}
          disabled={isPublishing}
        />
        {domains.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Host on</label>
            <select
              value={domainId}
              onChange={(e) => setDomainId(e.target.value)}
              disabled={isPublishing}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple disabled:opacity-50"
            >
              <option value="">Platform default</option>
              {domains.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.hostname}
                  {d.is_primary ? ' (primary)' : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {mode === 'upload' ? (
        <FileUploadZone
          onFileSelected={handleFile}
          isUploading={isPublishing}
          accept={PAGE_ACCEPT}
          label={PAGE_LABEL}
          hint={PAGE_HINT}
          uploadingLabel="Publishing…"
        />
      ) : (
        <div className="space-y-3">
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            rows={10}
            spellCheck={false}
            disabled={isPublishing}
            placeholder="<!doctype html>…"
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple disabled:opacity-50"
          />
          <div className="flex items-center justify-between">
            <span className="text-xs text-slate-500">{PAGE_HINT}</span>
            <Button
              onClick={() => submit(pasted)}
              disabled={isPublishing || pasted.trim().length === 0}
              leftIcon={<Upload className="h-4 w-4" />}
            >
              {isPublishing ? 'Publishing…' : 'Publish'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page row
// ---------------------------------------------------------------------------

interface PageRowProps {
  page: BeamPage;
  onCopy: () => void;
  onAnalytics: () => void;
  onReplace: (html: string) => void;
  onPatch: (data: PagePatch) => Promise<BeamPage>;
  onDelete: () => void;
  onRollback: (version: number) => void;
}

function statusBadge(page: BeamPage) {
  if (!page.enabled) return <Badge variant="warning" size="sm">Disabled</Badge>;
  if (page.has_access_code) return <Badge variant="info" size="sm">Gated</Badge>;
  return <Badge variant="success" size="sm">Live</Badge>;
}

function PageRow({ page, onCopy, onAnalytics, onReplace, onPatch, onDelete, onRollback }: PageRowProps) {
  const [panel, setPanel] = useState<RowPanel>({ mode: 'idle' });
  const fileInput = useRef<HTMLInputElement>(null);
  const avgDwell = page.view_count > 0 ? page.total_dwell_ms / page.view_count : 0;
  const toggle = (mode: Exclude<RowPanel['mode'], 'idle'>) =>
    setPanel((p) => (p.mode === mode ? { mode: 'idle' } : { mode }));

  const handleReplaceFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!isHtmlFile(file)) {
      toast.error('Only .html files can be published.');
      return;
    }
    if (file.size > PAGE_CAP_MB * 1024 * 1024) {
      toast.error(`Over ${PAGE_CAP_MB} MB.`);
      return;
    }
    onReplace(await file.text());
  };

  return (
    <div className="px-6 py-4 hover:bg-gray-50 transition-colors">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <div className="h-10 w-10 rounded-lg bg-brand-purple/10 flex items-center justify-center flex-shrink-0">
            <Globe className="h-5 w-5 text-brand-purple" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-sm text-slate-900 truncate">{page.title}</span>
              {statusBadge(page)}
              <Badge variant="default" size="sm">v{page.current_version}</Badge>
            </div>
            <div className="text-xs text-slate-500 mt-1 flex items-center gap-3 flex-wrap">
              <span>{formatBytes(page.size_bytes)}</span>
              <span className="flex items-center gap-1"><Eye className="h-3 w-3" />{page.view_count} {page.view_count === 1 ? 'view' : 'views'}</span>
              <span className="flex items-center gap-1"><Users className="h-3 w-3" />{page.unique_visitors} unique</span>
              <span className="flex items-center gap-1"><Repeat className="h-3 w-3" />{page.revisits} revisits</span>
              <span className="flex items-center gap-1"><Timer className="h-3 w-3" />{formatDwell(avgDwell)} avg</span>
              <span className="flex items-center gap-1"><Clock className="h-3 w-3" />Updated {formatRelative(page.updated_at)}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded px-2 py-1">
              <code className="text-xs font-mono text-slate-900 break-all flex-1">{page.url}</code>
              <button type="button" onClick={onCopy} className="text-slate-400 hover:text-slate-700" aria-label="Copy link">
                <Copy className="h-3.5 w-3.5" />
              </button>
              <QrButton value={page.url} filename={`${page.slug ?? page.short_code}.svg`} />
            </div>
            <div className="mt-1 text-[11px] text-slate-400 flex items-center gap-2 flex-wrap">
              <span>legacy {page.legacy_url}</span>
              <span>·</span>
              <span>
                Beam State: on ·{' '}
                <a href={BEAM_STATE_DOCS_URL} target="_blank" rel="noreferrer" className="underline hover:text-slate-600">
                  how it works
                </a>
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0 flex-wrap justify-end">
          <Button variant="ghost" size="sm" onClick={onAnalytics} className="text-brand-purple hover:bg-brand-purple/10" leftIcon={<BarChart3 className="h-4 w-4" />}>
            Analytics
          </Button>
          <input ref={fileInput} type="file" accept={PAGE_ACCEPT} className="hidden" onChange={handleReplaceFile} />
          <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()} leftIcon={<RefreshCw className="h-4 w-4" />} title="Upload new content at the same URL">
            Replace
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggle('edit')} leftIcon={<Pencil className="h-4 w-4" />}>
            Edit
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggle('versions')} leftIcon={<History className="h-4 w-4" />}>
            Versions
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete} className="text-red-600 hover:text-red-700 hover:bg-red-50" leftIcon={<Trash2 className="h-4 w-4" />}>
            Remove
          </Button>
        </div>
      </div>

      {panel.mode === 'edit' && (
        <EditPanel page={page} onPatch={onPatch} onDone={() => setPanel({ mode: 'idle' })} />
      )}
      {panel.mode === 'versions' && (
        <VersionsPanel page={page} onRollback={onRollback} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline edit panel
// ---------------------------------------------------------------------------

function EditPanel({ page, onPatch, onDone }: { page: BeamPage; onPatch: PageRowProps['onPatch']; onDone: () => void }) {
  const [slug, setSlug] = useState(page.slug ?? '');
  const [title, setTitle] = useState(page.title);
  const [enabled, setEnabled] = useState(page.enabled);
  const [accessCode, setAccessCode] = useState('');
  const [clearCode, setClearCode] = useState(false);
  const [slugError, setSlugError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const slugValid = slug === '' || SLUG_RE.test(slug);
  const host = (() => {
    try {
      return new URL(page.url).host;
    } catch {
      return '';
    }
  })();

  const save = async () => {
    if (!slugValid) {
      setSlugError('Use 3–60 lowercase letters, numbers and hyphens.');
      return;
    }
    const data: PagePatch = {};
    if (slug && slug !== page.slug) data.slug = slug;
    if (title.trim() && title.trim() !== page.title) data.title = title.trim();
    if (enabled !== page.enabled) data.enabled = enabled;
    if (clearCode) data.access_code = null;
    else if (accessCode.trim()) data.access_code = accessCode.trim();
    if (Object.keys(data).length === 0) {
      onDone();
      return;
    }
    setSaving(true);
    setSlugError(undefined);
    try {
      await onPatch(data);
      toast.success('Page updated.');
      onDone();
    } catch (err: unknown) {
      const status = apiErrorStatus(err);
      const detail = apiErrorDetail(err);
      if (status === 409) setSlugError('That slug is taken.');
      else if (status === 400 && data.slug) setSlugError(detail ?? 'Invalid slug.');
      else toast.error(detail ?? 'Could not update page.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-brand-purple/30 bg-white p-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Slug"
          value={slug}
          onChange={(e) => {
            setSlug(e.target.value.toLowerCase());
            setSlugError(undefined);
          }}
          error={slugError ?? (slugValid ? undefined : 'Use 3–60 lowercase letters, numbers and hyphens.')}
          helperText={host && slug ? `https://${host}/p/${slug}` : undefined}
          placeholder="pallab-northstar"
          maxLength={60}
        />
        <Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1.5">Access code</label>
          {page.has_access_code && !clearCode ? (
            <div className="flex items-center gap-2 text-sm text-slate-700">
              <KeyRound className="h-4 w-4 text-brand-purple" />
              Code set
              <Button variant="ghost" size="sm" onClick={() => setClearCode(true)}>Clear</Button>
              <span className="text-slate-400">or</span>
            </div>
          ) : null}
          {clearCode ? (
            <p className="text-xs text-amber-700">Code will be removed on save.</p>
          ) : (
            <Input
              type="password"
              inputMode="numeric"
              value={accessCode}
              onChange={(e) => setAccessCode(e.target.value.replace(/\D/g, '').slice(0, 8))}
              placeholder={page.has_access_code ? 'Replace with a new 4–8 digit code' : '4–8 digits (optional)'}
              helperText="Visitors must enter this before the page renders."
            />
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-700 sm:mt-7">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-gray-300 text-brand-purple focus:ring-brand-purple" />
          Enabled (off = instant 410 for every visitor)
        </label>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>Cancel</Button>
        <Button size="sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Versions panel
// ---------------------------------------------------------------------------

function VersionsPanel({ page, onRollback }: { page: BeamPage; onRollback: (version: number) => void }) {
  const { data: versions = [], isLoading } = useQuery<PageVersion[]>({
    queryKey: ['pages', page.page_id, 'versions'],
    queryFn: () => pagesApi.versions(page.page_id),
  });

  return (
    <div className="mt-4 rounded-lg border border-slate-200 bg-white">
      {isLoading ? (
        <div className="py-6"><LoadingSpinner /></div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {versions.map((v) => (
            <li key={v.version_no} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
              <div className="flex items-center gap-3 min-w-0">
                <span className="font-mono text-slate-900">v{v.version_no}</span>
                <span className="text-slate-500">{formatBytes(v.size_bytes)}</span>
                <span className="text-slate-500">{formatRelative(v.created_at)}</span>
              </div>
              {v.current ? (
                <Badge variant="success" size="sm">Current</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (window.confirm(`Roll back to v${v.version_no}? The link will serve that content immediately.`)) {
                      onRollback(v.version_no);
                    }
                  }}
                >
                  Roll back
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
