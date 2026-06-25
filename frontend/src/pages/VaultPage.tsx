import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, FileText, Film, Image as ImageIcon, Radio, Search } from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, EmptyState, Input, LoadingSpinner } from '../components/ui';
import { champvaultApi, type VaultAsset } from '../api/champvault';
import { utmApi, type Domain } from '../api/utm';

const TYPE_ICON: Record<string, typeof FileText> = {
  video: Film,
  image: ImageIcon,
};

function iconFor(type: string) {
  return TYPE_ICON[type] ?? FileText;
}

export function VaultPage() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [beamDomain, setBeamDomain] = useState('');
  const [lastBeam, setLastBeam] = useState<{ id: string; url: string } | null>(null);

  const { data: assets = [], isLoading, isError, error } = useQuery<VaultAsset[]>({
    queryKey: ['vault-assets', submitted],
    queryFn: () => champvaultApi.listAssets({ q: submitted || undefined }),
  });

  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
  });
  const activeDomains = useMemo(() => domains.filter((d) => d.status === 'active'), [domains]);

  const beamMutation = useMutation({
    mutationFn: (assetId: string) => champvaultApi.beam(assetId, { domain_id: beamDomain || undefined }),
    onSuccess: async (res) => {
      setLastBeam({ id: res.asset_id, url: res.beam_url });
      await navigator.clipboard.writeText(res.beam_url).catch(() => {});
      toast.success('Beam created and link copied to your clipboard.');
      queryClient.invalidateQueries({ queryKey: ['links'] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? 'Could not create the beam.');
    },
  });

  const notConfigured =
    isError && (error as { response?: { status?: number } })?.response?.status === 503;

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Vault</h1>
        <p className="text-slate-600 mt-1">
          Browse the ChampVault content hub and beam an asset — we wrap it in a tracked link and
          record every open.
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

          {activeDomains.length > 0 && (
            <div className="mb-6 flex items-center gap-3 text-sm">
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

          <Card>
            <CardHeader>
              <CardTitle>Assets</CardTitle>
            </CardHeader>
            {isLoading ? (
              <div className="py-10 flex justify-center">
                <LoadingSpinner />
              </div>
            ) : assets.length === 0 ? (
              <EmptyState
                icon={FileText}
                title="No assets"
                description="The ChampVault library is empty or no assets match your search. Assets are added on the ChampVault side."
              />
            ) : (
              <div className="divide-y divide-slate-100 -mx-6 -mb-6">
                {assets.map((a) => {
                  const Icon = iconFor(a.type);
                  const beaming = beamMutation.isPending && beamMutation.variables === a.id;
                  return (
                    <div key={a.id} className="px-6 py-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Icon className="h-4 w-4 text-slate-400" />
                            <span className="font-medium text-slate-900">{a.title}</span>
                            <Badge variant="default" size="sm">{a.type}</Badge>
                            {a.storage === 'stream' && a.duration_s ? (
                              <span className="text-xs text-slate-400">{a.duration_s}s</span>
                            ) : null}
                          </div>
                          {a.description && (
                            <p className="text-sm text-slate-500 mt-1">{a.description}</p>
                          )}
                          {a.tags.length > 0 && (
                            <div className="flex gap-1 mt-1 flex-wrap">
                              {a.tags.map((t) => (
                                <span key={t} className="text-xs text-slate-400">#{t}</span>
                              ))}
                            </div>
                          )}
                          {lastBeam?.id === a.id && (
                            <div className="mt-2 flex items-center gap-2 rounded-lg bg-green-50 border border-green-200 px-3 py-2 text-sm">
                              <code className="font-mono text-green-800 break-all flex-1">{lastBeam.url}</code>
                              <button
                                type="button"
                                className="text-green-700 hover:text-green-900"
                                onClick={() => {
                                  navigator.clipboard.writeText(lastBeam.url);
                                  toast.success('Copied');
                                }}
                                aria-label="Copy beam link"
                              >
                                <Copy className="h-4 w-4" />
                              </button>
                            </div>
                          )}
                        </div>
                        <Button
                          size="sm"
                          onClick={() => beamMutation.mutate(a.id)}
                          isLoading={beaming}
                          leftIcon={<Radio className="h-4 w-4" />}
                          className="flex-shrink-0"
                        >
                          Beam
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
