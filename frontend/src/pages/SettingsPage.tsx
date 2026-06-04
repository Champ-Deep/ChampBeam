import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BookmarkCheck,
  CheckCircle2,
  Copy,
  Globe,
  Info,
  Plus,
  RefreshCw,
  Star,
  Trash2,
  Zap,
} from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, Input } from '../components/ui';
import { utmApi } from '../api/utm';
import type { Domain, DomainsConfig, DomainStatus } from '../api/utm';
import { PresetsManager } from './PresetsManager';

type SettingsTab = 'domains' | 'presets';

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending_cname: 'Waiting on CNAME',
  pending_ssl: 'Issuing certificate',
  active: 'Active',
  failed: 'Failed',
};

const STATUS_VARIANT: Record<DomainStatus, 'default' | 'warning' | 'info' | 'success' | 'danger'> = {
  pending_cname: 'warning',
  pending_ssl: 'info',
  active: 'success',
  failed: 'danger',
};

// A single DNS label: lowercase a to z, 0 to 9 and hyphens, no leading or
// trailing hyphen, 1 to 63 characters.
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function validateSlug(slug: string): string | null {
  if (!slug) return null;
  if (slug.length > 63) return 'Use 63 characters or fewer.';
  if (!SLUG_PATTERN.test(slug)) {
    return 'Use lowercase letters, numbers and hyphens. No leading or trailing hyphen.';
  }
  return null;
}

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(
    searchParams.get('tab') === 'presets' ? 'presets' : 'domains'
  );

  const { data: config } = useQuery<DomainsConfig>({
    queryKey: ['domains-config'],
    queryFn: () => utmApi.getDomainsConfig(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: domains = [], isLoading } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
    // Poll every 15s while any row is mid-verification.
    refetchInterval: (query) => {
      const data = query.state.data as Domain[] | undefined;
      const pending = data?.some(
        (d) => d.status === 'pending_cname' || d.status === 'pending_ssl'
      );
      return pending ? 15_000 : false;
    },
  });

  const createMutation = useMutation({
    mutationFn: (hostname: string) => utmApi.createDomain(hostname),
    onSuccess: (created) => {
      if (created.status === 'active') {
        toast.success(`${created.hostname} is ready to use.`);
      } else {
        toast.success('Domain added. Follow the setup steps below.');
      }
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Could not add domain.';
      toast.error(msg);
    },
  });

  const refreshMutation = useMutation({
    mutationFn: (id: string) => utmApi.refreshDomain(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['domains'] }),
  });

  const primaryMutation = useMutation({
    mutationFn: (id: string) => utmApi.setPrimaryDomain(id),
    onSuccess: () => {
      toast.success('Primary domain updated.');
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Could not set primary.';
      toast.error(msg);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ id, force }: { id: string; force: boolean }) =>
      utmApi.deleteDomain(id, force),
    onSuccess: () => {
      toast.success('Domain removed.');
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: unknown) => {
      const detail =
        (err as { response?: { data?: { detail?: string }; status?: number } })?.response;
      if (detail?.status === 409) {
        toast.error(detail.data?.detail ?? 'Domain has links attached.');
      } else {
        toast.error('Could not remove domain.');
      }
    },
  });

  const pending = useMemo(
    () => domains.filter((d) => d.status === 'pending_cname' || d.status === 'pending_ssl'),
    [domains]
  );

  // Auto-refresh pending rows on mount so the UI flips quickly after DNS lands.
  useEffect(() => {
    pending.forEach((d) => refreshMutation.mutate(d.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = (d: Domain) => {
    const confirmMsg = `Remove ${d.hostname}? Links generated with this domain will stop resolving.`;
    if (!window.confirm(confirmMsg)) return;
    deleteMutation.mutate({ id: d.id, force: false });
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-slate-900">Settings</h1>
        <p className="text-slate-600 mt-1">
          Manage your custom domains and saved UTM presets.
        </p>
      </div>

      {/* Sub-tab bar */}
      <div className="border-b border-slate-200 mb-6">
        <div className="flex gap-6">
          <button
            onClick={() => setTab('domains')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'domains'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Globe className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Domains
          </button>
          <button
            onClick={() => setTab('presets')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'presets'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <BookmarkCheck className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Presets
          </button>
        </div>
      </div>

      {tab === 'domains' && (
        <>
          {config?.subdomain_enabled && config.platform_subdomain_base && (
            <ClaimSubdomainCard
              base={config.platform_subdomain_base}
              onClaim={(hostname) => createMutation.mutate(hostname)}
              submitting={createMutation.isPending}
            />
          )}

          <AddOwnDomainCard
            config={config}
            onAdd={(hostname) => createMutation.mutate(hostname)}
            submitting={createMutation.isPending}
          />

          <Card>
            <CardHeader>
              <CardTitle>Your domains</CardTitle>
            </CardHeader>
            {isLoading ? (
              <div className="py-8 text-center text-sm text-slate-500">Loading.</div>
            ) : domains.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                No custom domains yet. Claim a subdomain or add your own above to start
                sharing branded short links.
              </div>
            ) : (
              <div className="divide-y divide-slate-100 -mx-6 -mb-6">
                {domains.map((d) => (
                  <DomainRow
                    key={d.id}
                    domain={d}
                    config={config}
                    onRefresh={() => refreshMutation.mutate(d.id)}
                    onSetPrimary={() => primaryMutation.mutate(d.id)}
                    onDelete={() => handleDelete(d)}
                    refreshing={refreshMutation.isPending && refreshMutation.variables === d.id}
                  />
                ))}
              </div>
            )}
          </Card>
        </>
      )}

      {tab === 'presets' && <PresetsManager />}
    </div>
  );
}

interface ClaimSubdomainCardProps {
  base: string;
  onClaim: (hostname: string) => void;
  submitting: boolean;
}

function ClaimSubdomainCard({ base, onClaim, submitting }: ClaimSubdomainCardProps) {
  const [slug, setSlug] = useState('');
  const normalized = slug.trim().toLowerCase();
  const error = validateSlug(normalized);
  const preview = normalized ? `${normalized}.${base}` : `your-brand.${base}`;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!normalized) {
      toast.error('Pick a subdomain.');
      return;
    }
    if (error) {
      toast.error(error);
      return;
    }
    onClaim(`${normalized}.${base}`);
    setSlug('');
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-brand-purple" />
          Claim a subdomain
        </CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit} className="flex items-start gap-3">
        <div className="flex-1">
          <Input
            label="Subdomain"
            placeholder="your-brand"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            error={normalized ? error ?? undefined : undefined}
            helperText="This is instant and hosted on our domain."
            aria-label="Subdomain slug"
          />
          <p className="mt-2 text-sm text-slate-500">
            Preview:{' '}
            <code className="font-mono text-slate-900 break-all">{preview}</code>
          </p>
        </div>
        <Button
          type="submit"
          isLoading={submitting}
          disabled={!normalized || !!error}
          leftIcon={<Plus className="h-4 w-4" />}
          className="mt-7"
        >
          Claim
        </Button>
      </form>
    </Card>
  );
}

interface AddOwnDomainCardProps {
  config: DomainsConfig | undefined;
  onAdd: (hostname: string) => void;
  submitting: boolean;
}

function AddOwnDomainCard({ config, onAdd, submitting }: AddOwnDomainCardProps) {
  const [hostname, setHostname] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const h = hostname.trim().toLowerCase().replace(/\.$/, '');
    if (!h) {
      toast.error('Enter a domain.');
      return;
    }
    if (!h.includes('.')) {
      toast.error('Enter a full domain, for example track.acme.com.');
      return;
    }
    onAdd(h);
    setHostname('');
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          Add your own domain
        </CardTitle>
      </CardHeader>
      <form onSubmit={handleSubmit} className="flex items-end gap-3">
        <div className="flex-1">
          <Input
            label="Domain"
            placeholder="track.acme.com"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            helperText="Use a subdomain you control. You will add a CNAME record after this step."
          />
        </div>
        <Button type="submit" isLoading={submitting} leftIcon={<Plus className="h-4 w-4" />}>
          Add domain
        </Button>
      </form>
      {config && !config.byod_enabled && (
        <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            Custom certificate issuance is off on this environment, so your domain will
            be marked active for testing without issuing a real certificate.
          </span>
        </div>
      )}
    </Card>
  );
}

interface DomainRowProps {
  domain: Domain;
  config: DomainsConfig | undefined;
  onRefresh: () => void;
  onSetPrimary: () => void;
  onDelete: () => void;
  refreshing: boolean;
}

function DomainRow({ domain, config, onRefresh, onSetPrimary, onDelete, refreshing }: DomainRowProps) {
  const isActive = domain.status === 'active';
  const isFailed = domain.status === 'failed';

  return (
    <div className="px-6 py-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-medium text-slate-900 break-all">
              {domain.hostname}
            </span>
            <Badge variant={STATUS_VARIANT[domain.status]} size="sm">
              {STATUS_LABEL[domain.status]}
            </Badge>
            {domain.is_primary && (
              <Badge variant="info" size="sm">
                <Star className="h-3 w-3 mr-1 inline" />
                Primary
              </Badge>
            )}
            {!domain.cloudflare_managed && (
              <Badge variant="default" size="sm">Local mode</Badge>
            )}
          </div>
          {domain.ssl_status && (
            <p className="text-xs text-slate-500 mt-1">SSL: {domain.ssl_status}</p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            leftIcon={<RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />}
          >
            {refreshing ? 'Checking' : 'Refresh'}
          </Button>
          {isActive && !domain.is_primary && (
            <Button variant="outline" size="sm" onClick={onSetPrimary} leftIcon={<Star className="h-4 w-4" />}>
              Set primary
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onDelete}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
            leftIcon={<Trash2 className="h-4 w-4" />}
          >
            Remove
          </Button>
        </div>
      </div>

      {!isActive && <SetupInstructions domain={domain} config={config} />}

      {isFailed && domain.verification_errors && (
        <div className="mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Verification failed</p>
            <pre className="text-xs mt-1 whitespace-pre-wrap font-mono">
              {JSON.stringify(domain.verification_errors, null, 2)}
            </pre>
          </div>
        </div>
      )}

      {isActive && (
        <div className="mt-3 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Ready: pick this domain when generating a link.
        </div>
      )}
    </div>
  );
}

function SetupInstructions({
  domain,
  config,
}: {
  domain: Domain;
  config: DomainsConfig | undefined;
}) {
  if (!domain.cloudflare_managed && !config?.byod_enabled) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
        <p className="font-medium mb-1">Local-development mode</p>
        <p>
          Cloudflare is not configured on this deployment, so the domain is active
          immediately without a certificate. Test by curl with a spoofed Host header:
        </p>
        <pre className="text-xs mt-2 p-2 bg-white rounded font-mono whitespace-pre-wrap">
          {`curl -i -H "Host: ${domain.hostname}" http://localhost:8000/r/<short_code>`}
        </pre>
      </div>
    );
  }
  // Prefer the domain-level target, then the platform config target, then a
  // generic instruction to point at the platform host.
  const cname = domain.cname_target || config?.cname_target || 'your platform host';
  return (
    <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700">
      <p className="font-medium text-slate-900 mb-2">Setup steps</p>
      <ol className="list-decimal list-inside space-y-2">
        <li>
          In your DNS provider, add a CNAME record from{' '}
          <code className="font-mono text-slate-900">{domain.hostname}</code> to{' '}
          <code className="font-mono text-slate-900">{cname}</code>:
          <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <CopyableField label="Name" value={domain.hostname} />
            <CopyableField label="Value" value={cname} />
          </div>
        </li>
        <li>Wait 1 to 5 minutes for DNS to propagate, then click "Refresh".</li>
        <li>We issue a TLS certificate; the status flips to Active automatically.</li>
      </ol>
    </div>
  );
}

function CopyableField({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 bg-white border border-slate-200 rounded px-2 py-1">
      <span className="text-xs text-slate-500 w-12 flex-shrink-0">{label}</span>
      <code className="text-xs font-mono text-slate-900 break-all flex-1">{value}</code>
      <button
        type="button"
        className="text-slate-400 hover:text-slate-700"
        onClick={() => {
          navigator.clipboard.writeText(value);
          toast.success('Copied');
        }}
        aria-label={`Copy ${label}`}
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
