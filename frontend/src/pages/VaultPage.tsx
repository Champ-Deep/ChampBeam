import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, FileText, Film, Image as ImageIcon, Inbox, Radio, Search, Send, Star } from 'lucide-react';
import { clsx } from 'clsx';
import { Badge, Button, Card, CardHeader, CardTitle, EmptyState, Input, LoadingSpinner } from '../components/ui';
import { champvaultApi, type VaultAsset } from '../api/champvault';
import { assignmentsApi, orgApi, type Assignment, type MemberStats } from '../api/org';
import { utmApi, type Domain } from '../api/utm';
import { useOrgContext } from '../hooks/useOrgContext';

const TYPE_ICON: Record<string, typeof FileText> = {
  video: Film,
  image: ImageIcon,
};

function iconFor(type: string) {
  return TYPE_ICON[type] ?? FileText;
}

function errDetail(err: unknown): string | undefined {
  return (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
}

export function VaultPage() {
  const queryClient = useQueryClient();
  const { inOrg, canManageTeam } = useOrgContext();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [beamDomain, setBeamDomain] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [lastBeam, setLastBeam] = useState<{ id: string; url: string } | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);

  const { data: assets = [], isLoading, isError, error } = useQuery<VaultAsset[]>({
    queryKey: ['vault-assets', submitted],
    queryFn: () => champvaultApi.listAssets({ q: submitted || undefined }),
  });

  // The My Favorites shelf resolves independently of the search, so a favorite
  // shows even when it isn't in the current results. Fetched only when viewing.
  const { data: favoriteAssets = [], isLoading: favLoading } = useQuery<VaultAsset[]>({
    queryKey: ['champvault-favorites'],
    queryFn: () => champvaultApi.listFavorites(),
    enabled: favoritesOnly,
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
  });
  const activeDomains = useMemo(() => domains.filter((d) => d.status === 'active'), [domains]);

  // The assets a leader has recommended to this user (their shelf).
  const { data: assignments = [] } = useQuery<Assignment[]>({
    queryKey: ['assignments-mine'],
    queryFn: () => assignmentsApi.mine(),
    enabled: inOrg,
  });

  const beamMutation = useMutation({
    mutationFn: (assetId: string) => champvaultApi.beam(assetId, { domain_id: beamDomain || undefined }),
    onSuccess: async (res) => {
      setLastBeam({ id: res.asset_id, url: res.beam_url });
      await navigator.clipboard.writeText(res.beam_url).catch(() => {});
      toast.success('Beam created and link copied to your clipboard.');
      queryClient.invalidateQueries({ queryKey: ['links'] });
      queryClient.invalidateQueries({ queryKey: ['assignments-mine'] });
    },
    onError: (err: unknown) => toast.error(errDetail(err) ?? 'Could not create the beam.'),
  });

  const favoriteMutation = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? champvaultApi.addFavorite(id) : champvaultApi.removeFavorite(id),
    onMutate: async ({ id, on }) => {
      // Optimistic: flip the star immediately.
      await queryClient.cancelQueries({ queryKey: ['vault-assets', submitted] });
      const prev = queryClient.getQueryData<VaultAsset[]>(['vault-assets', submitted]);
      queryClient.setQueryData<VaultAsset[]>(['vault-assets', submitted], (old) =>
        (old ?? []).map((a) => (a.id === id ? { ...a, favorited: on } : a)),
      );
      return { prev };
    },
    onError: (err: unknown, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(['vault-assets', submitted], ctx.prev);
      toast.error(errDetail(err) ?? 'Could not update favorite.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['vault-assets', submitted] });
      queryClient.invalidateQueries({ queryKey: ['champvault-favorites'] });
    },
  });

  const notConfigured =
    isError && (error as { response?: { status?: number } })?.response?.status === 503;

  const visibleAssets = favoritesOnly ? favoriteAssets : assets;
  const listLoading = favoritesOnly ? favLoading : isLoading;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Vault</h1>
        <p className="text-slate-600 mt-1">
          Browse the ChampVault hub, favorite what you send often, and beam an asset — we wrap it in
          a tracked link and record every open.
        </p>
      </div>

      {notConfigured ? (
        <EmptyState
          icon={Radio}
          title="ChampVault isn't connected"
          description="This environment has no ChampVault hub configured. Set CHAMPVAULT_URL and CHAMPVAULT_API_KEY on the backend to enable it."
        />
      ) : (
        <>
          {inOrg && assignments.length > 0 && (
            <AssignedShelf
              assignments={assignments}
              beamingId={beamMutation.isPending ? (beamMutation.variables as string) : null}
              onSend={(assetId) => beamMutation.mutate(assetId)}
            />
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(query.trim());
            }}
            className="flex items-start gap-3 mb-4"
          >
            <div className="flex-1">
              <Input
                label="Search the library"
                placeholder="title…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <Button type="submit" leftIcon={<Search className="h-4 w-4" />} className="mt-7 whitespace-nowrap">
              Search
            </Button>
          </form>

          <div className="mb-6 flex flex-wrap items-center gap-3 text-sm">
            <Button
              type="button"
              variant={favoritesOnly ? 'primary' : 'outline'}
              size="sm"
              onClick={() => setFavoritesOnly((v) => !v)}
              leftIcon={<Star className={clsx('h-4 w-4', favoritesOnly && 'fill-current')} />}
            >
              {favoritesOnly ? 'Favorites' : 'All assets'}
            </Button>
            {activeDomains.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-slate-600">Beam on:</span>
                <select
                  value={beamDomain}
                  onChange={(e) => setBeamDomain(e.target.value)}
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
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{favoritesOnly ? 'My favorites' : 'Assets'}</CardTitle>
            </CardHeader>
            {listLoading ? (
              <div className="py-10 flex justify-center">
                <LoadingSpinner />
              </div>
            ) : visibleAssets.length === 0 ? (
              <EmptyState
                icon={favoritesOnly ? Star : FileText}
                title={favoritesOnly ? 'No favorites yet' : 'No assets'}
                description={
                  favoritesOnly
                    ? 'Tap the star on an asset to keep it here for quick sending.'
                    : 'The ChampVault library is empty or no assets match your search. Assets are added on the ChampVault side.'
                }
              />
            ) : (
              <div className="divide-y divide-slate-100 -mx-6 -mb-6">
                {visibleAssets.map((a) => (
                  <AssetRow
                    key={a.id}
                    asset={a}
                    beaming={beamMutation.isPending && beamMutation.variables === a.id}
                    lastBeamUrl={lastBeam?.id === a.id ? lastBeam.url : null}
                    canManageTeam={canManageTeam}
                    assignOpen={assigningId === a.id}
                    onBeam={() => beamMutation.mutate(a.id)}
                    onToggleFavorite={() => favoriteMutation.mutate({ id: a.id, on: !a.favorited })}
                    onToggleAssign={() => setAssigningId((cur) => (cur === a.id ? null : a.id))}
                    onAssigned={() => setAssigningId(null)}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function AssignedShelf({
  assignments,
  beamingId,
  onSend,
}: {
  assignments: Assignment[];
  beamingId: string | null;
  onSend: (assetId: string) => void;
}) {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="h-5 w-5 text-brand-purple" />
          Assigned to you
        </CardTitle>
      </CardHeader>
      <div className="divide-y divide-slate-100 -mx-6 -mb-6">
        {assignments.map((a) => (
          <div key={a.id} className="px-6 py-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-slate-900">{a.asset_title || a.champvault_asset_id}</span>
                {a.sent ? (
                  <Badge variant="success" size="sm">Sent</Badge>
                ) : (
                  <Badge variant="warning" size="sm">Not sent</Badge>
                )}
              </div>
              {a.note && <p className="text-sm text-slate-500 mt-1">“{a.note}”</p>}
            </div>
            <Button
              size="sm"
              variant={a.sent ? 'outline' : 'primary'}
              onClick={() => onSend(a.champvault_asset_id)}
              isLoading={beamingId === a.champvault_asset_id}
              leftIcon={<Send className="h-4 w-4" />}
              className="flex-shrink-0"
            >
              {a.sent ? 'Send again' : 'Send'}
            </Button>
          </div>
        ))}
      </div>
    </Card>
  );
}

function AssetRow({
  asset,
  beaming,
  lastBeamUrl,
  canManageTeam,
  assignOpen,
  onBeam,
  onToggleFavorite,
  onToggleAssign,
  onAssigned,
}: {
  asset: VaultAsset;
  beaming: boolean;
  lastBeamUrl: string | null;
  canManageTeam: boolean;
  assignOpen: boolean;
  onBeam: () => void;
  onToggleFavorite: () => void;
  onToggleAssign: () => void;
  onAssigned: () => void;
}) {
  const Icon = iconFor(asset.type);
  return (
    <div className="px-6 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Icon className="h-4 w-4 text-slate-400" />
            <span className="font-medium text-slate-900">{asset.title}</span>
            <Badge variant="default" size="sm">{asset.type}</Badge>
            {asset.storage === 'stream' && asset.duration_s ? (
              <span className="text-xs text-slate-400">{asset.duration_s}s</span>
            ) : null}
          </div>
          {asset.description && <p className="text-sm text-slate-500 mt-1">{asset.description}</p>}
          {asset.tags.length > 0 && (
            <div className="flex gap-1 mt-1 flex-wrap">
              {asset.tags.map((t) => (
                <span key={t} className="text-xs text-slate-400">#{t}</span>
              ))}
            </div>
          )}
          {lastBeamUrl && (
            <div className="mt-2 flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm">
              <code className="font-mono text-green-800 break-all flex-1">{lastBeamUrl}</code>
              <button
                type="button"
                className="text-green-700 hover:text-green-900"
                onClick={() => {
                  navigator.clipboard.writeText(lastBeamUrl);
                  toast.success('Copied');
                }}
                aria-label="Copy beam link"
              >
                <Copy className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={onToggleFavorite}
            aria-label={asset.favorited ? 'Remove favorite' : 'Add favorite'}
            aria-pressed={asset.favorited}
            className={clsx(
              'p-2 rounded-lg transition-colors',
              asset.favorited ? 'text-amber-500 hover:text-amber-600' : 'text-slate-300 hover:text-slate-500',
            )}
          >
            <Star className={clsx('h-4 w-4', asset.favorited && 'fill-current')} />
          </button>
          {canManageTeam && (
            <Button size="sm" variant="outline" onClick={onToggleAssign}>
              Assign
            </Button>
          )}
          <Button size="sm" onClick={onBeam} isLoading={beaming} leftIcon={<Radio className="h-4 w-4" />}>
            Beam
          </Button>
        </div>
      </div>

      {assignOpen && <AssignPanel asset={asset} onDone={onAssigned} />}
    </div>
  );
}

function AssignPanel({ asset, onDone }: { asset: VaultAsset; onDone: () => void }) {
  const [repId, setRepId] = useState('');
  const [note, setNote] = useState('');

  // Reps the caller can assign to: members (not leaders/admins) in their scope.
  const { data: members = [] } = useQuery<MemberStats[]>({
    queryKey: ['org-members'],
    queryFn: () => orgApi.listMembers(),
  });
  const reps = useMemo(
    () => members.filter((m) => !m.role.toLowerCase().endsWith('admin') && m.role.toLowerCase() !== 'leader'),
    [members],
  );

  const assign = useMutation({
    mutationFn: () =>
      assignmentsApi.create({
        champvault_asset_id: asset.id,
        asset_title: asset.title,
        assigned_to_user_id: repId,
        note: note || undefined,
      }),
    onSuccess: () => {
      toast.success('Assigned.');
      onDone();
    },
    onError: (err: unknown) => toast.error(errDetail(err) ?? 'Could not assign.'),
  });

  return (
    <div className="mt-3 rounded-lg bg-slate-50 border border-slate-200 p-3 space-y-2">
      {reps.length === 0 ? (
        <p className="text-sm text-slate-500">No reps to assign to yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={repId}
              onChange={(e) => setRepId(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            >
              <option value="">Choose a rep…</option>
              {reps.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {m.full_name || m.email || m.user_id.slice(0, 8)}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="flex-1 min-w-[10rem] rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
            />
            <Button
              size="sm"
              onClick={() => assign.mutate()}
              isLoading={assign.isPending}
              disabled={!repId}
            >
              Assign
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
