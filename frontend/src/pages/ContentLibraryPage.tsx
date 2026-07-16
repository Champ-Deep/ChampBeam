import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  Copy,
  ExternalLink,
  FileText,
  Library,
  Link as LinkIcon,
  Plus,
  Share2,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, EmptyState, Input, LoadingSpinner } from '../components/ui';
import { contentApi, type ContentItem, type ContentKind } from '../api/org';
import { utmApi, type Domain } from '../api/utm';
import { filesApi, type FileAsset } from '../api/files';
import { useOrgContext } from '../hooks/useOrgContext';

export function ContentLibraryPage() {
  const queryClient = useQueryClient();
  const { isAdmin } = useOrgContext();
  const [shareDomain, setShareDomain] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);

  const { data: items = [], isLoading } = useQuery<ContentItem[]>({
    queryKey: ['content'],
    queryFn: () => contentApi.list(),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
  });
  const activeDomains = useMemo(() => domains.filter((d) => d.status === 'active'), [domains]);

  const shareMutation = useMutation({
    mutationFn: (id: string) => contentApi.share(id, shareDomain || undefined),
    onSuccess: async (res) => {
      await navigator.clipboard.writeText(res.share_url).catch(() => {});
      toast.success('Your share link is ready and copied to your clipboard.');
      queryClient.invalidateQueries({ queryKey: ['content'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? 'Could not create a share link.');
    },
  });

  const archiveMutation = useMutation({
    mutationFn: ({ id, is_archived }: { id: string; is_archived: boolean }) =>
      contentApi.update(id, { is_archived }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['content'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => contentApi.remove(id),
    onSuccess: () => {
      toast.success('Content removed.');
      queryClient.invalidateQueries({ queryKey: ['content'] });
    },
  });

  const visible = useMemo(
    () => items.filter((c) => (showArchived ? true : !c.is_archived)),
    [items, showArchived]
  );

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">Content Library</h1>
          <p className="text-slate-600 mt-1">
            {isAdmin
              ? 'Curate content for your team. Every member can share it with their own tracked link.'
              : 'Shared content from your team. Share any item to get your own tracked link.'}
          </p>
        </div>
      </div>

      {/* Share-on domain selector (applies to new shares). */}
      {activeDomains.length > 0 && (
        <div className="mb-6 flex items-center gap-3 text-sm">
          <span className="text-slate-600">Share links on:</span>
          <select
            value={shareDomain}
            onChange={(e) => setShareDomain(e.target.value)}
            className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
          >
            <option value="">Platform default</option>
            {activeDomains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.hostname}
              </option>
            ))}
          </select>
        </div>
      )}

      {isAdmin && <NewContentCard />}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>Content</CardTitle>
            <label
              className="inline-flex cursor-pointer select-none items-center gap-2.5 rounded-full border border-slate-200 bg-slate-50 px-3.5 py-1.5 text-sm font-medium text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-100"
              style={
                showArchived
                  ? {
                      borderColor: 'var(--cb-accent-border)',
                      backgroundColor: 'var(--cb-accent-soft)',
                      color: 'var(--cb-accent)',
                    }
                  : undefined
              }
            >
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 cursor-pointer rounded border-slate-300 accent-brand-purple"
              />
              Show archived
            </label>
          </div>
        </CardHeader>
        {isLoading ? (
          <div className="py-10 flex justify-center">
            <LoadingSpinner />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon={Library}
            title="Nothing here yet"
            description={
              isAdmin
                ? 'Add a link or file above to start building your team library.'
                : 'Your team admin has not shared any content yet.'
            }
          />
        ) : (
          <div className="divide-y divide-slate-100 -mx-6 -mb-6">
            {visible.map((c) => (
              <ContentRow
                key={c.id}
                content={c}
                isAdmin={isAdmin}
                sharing={shareMutation.isPending && shareMutation.variables === c.id}
                onShare={() => shareMutation.mutate(c.id)}
                onArchive={() =>
                  archiveMutation.mutate({ id: c.id, is_archived: !c.is_archived })
                }
                onDelete={() => {
                  if (window.confirm(`Remove "${c.title}" from the library?`)) {
                    deleteMutation.mutate(c.id);
                  }
                }}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function ContentRow({
  content,
  isAdmin,
  sharing,
  onShare,
  onArchive,
  onDelete,
}: {
  content: ContentItem;
  isAdmin: boolean;
  sharing: boolean;
  onShare: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  const KindIcon = content.kind === 'file' ? FileText : LinkIcon;
  return (
    <div className="px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <KindIcon className="h-4 w-4 text-slate-400" />
            <span className="font-medium text-slate-900">{content.title}</span>
            <Badge variant="default" size="sm">
              {content.kind}
            </Badge>
            {content.is_archived && (
              <Badge variant="warning" size="sm">
                Archived
              </Badge>
            )}
            <span className="text-xs text-slate-400">
              {content.share_count} share{content.share_count === 1 ? '' : 's'}
            </span>
          </div>
          {content.description && (
            <p className="text-sm text-slate-500 mt-1">{content.description}</p>
          )}
          {content.canonical_url && (
            <p className="text-xs text-slate-400 mt-1 font-mono break-all">
              {content.canonical_url}
            </p>
          )}
          {content.my_share && <MyShareRow url={content.my_share.share_url} opens={content.my_share.opens} />}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            size="sm"
            onClick={onShare}
            isLoading={sharing}
            disabled={content.is_archived}
            leftIcon={<Share2 className="h-4 w-4" />}
          >
            {content.my_share ? 'Re-copy link' : 'Share'}
          </Button>
          {isAdmin && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={onArchive}
                leftIcon={
                  content.is_archived ? (
                    <ArchiveRestore className="h-4 w-4" />
                  ) : (
                    <Archive className="h-4 w-4" />
                  )
                }
              >
                {content.is_archived ? 'Restore' : 'Archive'}
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
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MyShareRow({ url, opens }: { url: string; opens: number }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm">
      <code className="font-mono text-green-800 break-all flex-1">{url}</code>
      <span className="text-green-700 whitespace-nowrap">
        {opens} open{opens === 1 ? '' : 's'}
      </span>
      <button
        type="button"
        className="text-green-700 hover:text-green-900"
        onClick={() => {
          navigator.clipboard.writeText(url);
          toast.success('Copied');
        }}
        aria-label="Copy share link"
      >
        <Copy className="h-4 w-4" />
      </button>
      <a href={url} target="_blank" rel="noreferrer" className="text-green-700 hover:text-green-900">
        <ExternalLink className="h-4 w-4" />
      </a>
    </div>
  );
}

function NewContentCard() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<ContentKind>('link');
  const [canonicalUrl, setCanonicalUrl] = useState('');
  const [fileId, setFileId] = useState('');

  const { data: files = [] } = useQuery<FileAsset[]>({
    queryKey: ['files'],
    queryFn: () => filesApi.list(),
    enabled: kind === 'file',
  });
  const activeFiles = useMemo(() => files.filter((f) => f.status === 'active'), [files]);

  const createMutation = useMutation({
    mutationFn: () =>
      contentApi.create({
        title: title.trim(),
        description: description.trim() || undefined,
        kind,
        canonical_url: kind === 'link' ? canonicalUrl.trim() : undefined,
        file_id: kind === 'file' ? fileId : undefined,
      }),
    onSuccess: () => {
      toast.success('Content added to the library.');
      setTitle('');
      setDescription('');
      setCanonicalUrl('');
      setFileId('');
      queryClient.invalidateQueries({ queryKey: ['content'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? 'Could not add content.');
    },
  });

  const canSubmit =
    title.trim() && (kind === 'link' ? !!canonicalUrl.trim() : !!fileId);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="h-5 w-5 text-brand-purple" />
          Add content
        </CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setKind('link')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${
              kind === 'link'
                ? 'border-brand-purple text-brand-purple bg-brand-purple/5'
                : 'border-slate-200 text-slate-600'
            }`}
          >
            <LinkIcon className="h-4 w-4" /> Link
          </button>
          <button
            type="button"
            onClick={() => setKind('file')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${
              kind === 'file'
                ? 'border-brand-purple text-brand-purple bg-brand-purple/5'
                : 'border-slate-200 text-slate-600'
            }`}
          >
            <FileText className="h-4 w-4" /> File
          </button>
        </div>

        <Input
          label="Title"
          placeholder="Q3 Product Pitch"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <Input
          label="Description (optional)"
          placeholder="One-line context for your team"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        {kind === 'link' ? (
          <Input
            label="Destination URL"
            placeholder="https://example.com/pitch"
            value={canonicalUrl}
            onChange={(e) => setCanonicalUrl(e.target.value)}
          />
        ) : (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              Master file
            </label>
            <select
              value={fileId}
              onChange={(e) => setFileId(e.target.value)}
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
            >
              <option value="">Select an uploaded file…</option>
              {activeFiles.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.filename}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-500">
              Upload it on the Files page first; team shares reuse the same file (no re-upload).
            </p>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={() => createMutation.mutate()}
            isLoading={createMutation.isPending}
            disabled={!canSubmit}
            leftIcon={<Plus className="h-4 w-4" />}
          >
            Add to library
          </Button>
        </div>
      </div>
    </Card>
  );
}
