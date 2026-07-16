import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  ExternalLink,
  FileText,
  Library,
  Link as LinkIcon,
  Plus,
  Radio,
  Search,
  Share2,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, EmptyState, Input, LoadingSpinner } from '../components/ui';
import { contentApi, type ContentItem } from '../api/org';
import { champvaultApi, type VaultAsset } from '../api/champvault';
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
  const isVault = Boolean(content.champvault_asset_id);
  const KindIcon = isVault ? Radio : content.kind === 'file' ? FileText : LinkIcon;
  return (
    <div className="px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <KindIcon className="h-4 w-4 text-slate-400" />
            <span className="font-medium text-slate-900">{content.title}</span>
            {isVault ? (
              <span
                className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                style={{
                  backgroundColor: 'var(--cb-accent-soft)',
                  color: 'var(--cb-accent)',
                  border: '1px solid var(--cb-accent-border)',
                }}
              >
                <Radio className="h-3 w-3" /> ChampVault
              </span>
            ) : (
              <Badge variant="default" size="sm">
                {content.kind}
              </Badge>
            )}
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
          {content.canonical_url && !isVault && (
            <p className="text-xs text-slate-400 mt-1 font-mono break-all">
              {content.canonical_url}
            </p>
          )}
          {isVault && (
            <p className="text-xs text-slate-400 mt-1">
              Live ChampVault asset — each share re-mints a fresh delivery link on open.
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

type ContentSource = 'link' | 'file' | 'champvault';

function NewContentCard() {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<ContentSource>('link');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [canonicalUrl, setCanonicalUrl] = useState('');
  const [fileId, setFileId] = useState('');

  // Only offer the ChampVault source when the hub is configured (same signal the
  // sidebar Vault item uses).
  const { data: vaultConfig } = useQuery({
    queryKey: ['champvault-config'],
    queryFn: () => champvaultApi.config(),
    staleTime: 5 * 60 * 1000,
  });
  const vaultEnabled = Boolean(vaultConfig?.configured);

  const { data: files = [] } = useQuery<FileAsset[]>({
    queryKey: ['files'],
    queryFn: () => filesApi.list(),
    enabled: source === 'file',
  });
  const activeFiles = useMemo(() => files.filter((f) => f.status === 'active'), [files]);

  const createMutation = useMutation({
    mutationFn: () =>
      contentApi.create({
        title: title.trim(),
        description: description.trim() || undefined,
        kind: source === 'file' ? 'file' : 'link',
        canonical_url: source === 'link' ? canonicalUrl.trim() : undefined,
        file_id: source === 'file' ? fileId : undefined,
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
    title.trim() && (source === 'link' ? !!canonicalUrl.trim() : !!fileId);

  const sources: { id: ContentSource; label: string; icon: typeof LinkIcon }[] = [
    { id: 'link', label: 'Link', icon: LinkIcon },
    { id: 'file', label: 'File', icon: FileText },
    ...(vaultEnabled ? [{ id: 'champvault' as const, label: 'ChampVault', icon: Radio }] : []),
  ];

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plus className="h-5 w-5 text-brand-purple" />
          Add content
        </CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <div className="flex gap-2 flex-wrap">
          {sources.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSource(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border ${
                source === id
                  ? 'border-brand-purple text-brand-purple bg-brand-purple/5'
                  : 'border-slate-200 text-slate-600'
              }`}
            >
              <Icon className="h-4 w-4" /> {label}
            </button>
          ))}
        </div>

        {source === 'champvault' ? (
          <ChampVaultPicker />
        ) : (
          <>
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

            {source === 'link' ? (
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
          </>
        )}
      </div>
    </Card>
  );
}

// Search all published ChampVault assets and add any into the library. Each add
// is a live reference (re-mints delivery on open); idempotent per (org, asset).
function ChampVaultPicker() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [added, setAdded] = useState<Set<string>>(new Set());

  const { data: assets = [], isLoading } = useQuery<VaultAsset[]>({
    queryKey: ['champvault-assets', query],
    queryFn: () => champvaultApi.listAssets(query.trim() ? { q: query.trim() } : {}),
  });

  const addMutation = useMutation({
    mutationFn: (asset: VaultAsset) =>
      contentApi.addFromChampVault({ asset_id: asset.id, title: asset.title || undefined }),
    onSuccess: (_res, asset) => {
      setAdded((prev) => new Set(prev).add(asset.id));
      toast.success('Added to the library.');
      queryClient.invalidateQueries({ queryKey: ['content'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? 'Could not add from ChampVault.');
    },
  });

  return (
    <div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ChampVault…"
          className="w-full rounded-lg border border-slate-300 pl-9 pr-3 py-2 text-sm"
        />
      </div>

      <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
        {isLoading ? (
          <div className="py-8 flex justify-center">
            <LoadingSpinner />
          </div>
        ) : assets.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-500">
            {query.trim() ? 'No matching ChampVault assets.' : 'No ChampVault assets found.'}
          </p>
        ) : (
          assets.map((asset) => {
            const isAdded = added.has(asset.id);
            const adding = addMutation.isPending && addMutation.variables?.id === asset.id;
            return (
              <div key={asset.id} className="flex items-center gap-3 px-3 py-2.5">
                <Radio className="h-4 w-4 flex-shrink-0 text-slate-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-900">
                    {asset.title || asset.id}
                  </p>
                  <p className="truncate text-xs text-slate-400">
                    {asset.type}
                    {asset.tags && asset.tags.length > 0 ? ` · ${asset.tags.join(', ')}` : ''}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={isAdded ? 'ghost' : 'primary'}
                  disabled={isAdded}
                  isLoading={adding}
                  onClick={() => addMutation.mutate(asset)}
                  leftIcon={isAdded ? <Check className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                >
                  {isAdded ? 'Added' : 'Add'}
                </Button>
              </div>
            );
          })
        )}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        Added assets stay in sync — each share re-mints a fresh delivery link on open.
      </p>
    </div>
  );
}
