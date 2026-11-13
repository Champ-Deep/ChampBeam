import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { OrganizationSettings } from '../components/OrganizationSettings';
import { useOrgContext } from '../hooks/useOrgContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, AlertTriangle, Bell, BookmarkCheck, Bot, CheckCircle2, Globe, Info, KeyRound, Palette, Plus, RefreshCw, Search, ShoppingCart, Trash2, Zap } from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, Input, useConfirm } from '../components/ui';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { ApiKeysSettings } from '../components/ApiKeysSettings';
import { AssistantSettings } from '../components/AssistantSettings';
import { utmApi } from '../api/utm';
import type { Domain, DomainSearchResult, DomainsConfig, DomainStatus } from '../api/utm';

import { SystemSettings } from '../components/SystemSettings';
import { apiErrorDetail, apiErrorStatus } from '../api/_shared';
import { systemApi } from '../api/system';
import { useAuth } from '../lib/authClient';
import { useAppConfig } from '../hooks/useAppConfig';
import { CreateOrgDialog } from '../components/org/CreateOrgDialog';
import { DnsRecordsCard } from '../components/org/DnsRecords';
import { dnsRecordsFor } from '../lib/selfServeRules';

type SettingsTab = 'domains' | 'apikeys' | 'appearance' | 'notifications' | 'system' | 'assistant';

function initialTab(param: string | null): SettingsTab {
  if (param === 'appearance' || param === 'apikeys' || param === 'notifications' || param === 'system' || param === 'assistant')
    return param;
  return 'domains';
}

const STATUS_LABEL: Record<DomainStatus, string> = {
  pending_cname: 'Pending',
  pending_ssl: 'Verifying',
  active: 'Active',
  failed: 'Error',
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
  const [params] = useSearchParams();
  const { inOrg, permissions, isLoading, error } = useOrgContext();
  if (params.get('tab') === 'presets' || params.get('tab') === 'utm') return <Navigate to="/links?tab=utm&panel=presets" replace />;
  if (isLoading) return <p role="status">Loading workspace settings…</p>;
  if (error) return <p role="alert">Could not verify workspace access. Reload or sign in again.</p>;
  return <div className="cb-workspace"><div className="cb-section-head"><h1>Settings</h1><CreateOrgEntry /></div>{inOrg && <OrganizationSettings />}{(!inOrg || permissions.includes('org.domains.manage')) ? <PersonalSettings /> : <AppearanceSettings />}</div>;
}

/** Settings entry point for creating an organization; only accounts allowed to create one see it. */
export function CreateOrgEntry() {
  const { data: config } = useAppConfig();
  const [open, setOpen] = useState(false);
  if (!config?.can_create_org) return null;
  return <><Button variant="outline" leftIcon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>Create organization</Button>
    <CreateOrgDialog open={open} onOpenChange={setOpen} platformHost={config.platform_host} /></>;
}

function PersonalSettings() {
  const { userId } = useAuth();
  const { data: appConfig } = useAppConfig();
  const customDomains = !!appConfig?.custom_domains_enabled;
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [tab, setTab] = useState<SettingsTab>(initialTab(searchParams.get('tab')));
  const { data: systemAccess } = useQuery({
    queryKey: ['system', 'access', userId],
    queryFn: () => systemApi.access(),
    enabled: !!userId,
  });
  const canViewSystem = !!systemAccess?.is_admin;
  const clearNotifications = useMutation({
    mutationFn: () => utmApi.clearRecentClicks(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['recent-clicks'] });
      toast.success('Recent opens cleared.');
    },
    onError: (error: unknown) => toast.error(apiErrorDetail(error) ?? 'Could not clear recent opens.'),
  });

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
      const data = query.state.data;
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
        apiErrorDetail(err) ??
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
      toast.success('Default domain updated. New links use it.');
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: unknown) => {
      const msg =
        apiErrorDetail(err) ??
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
      if (apiErrorStatus(err) === 409) {
        toast.error(apiErrorDetail(err) ?? 'Domain has links attached.');
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

  const handleDelete = async (d: Domain) => {
    const confirmMsg = `Remove ${d.hostname}? Links generated with this domain will stop resolving.`;
    if (!(await confirm({ message: confirmMsg, confirmLabel: 'Remove' }))) return;
    deleteMutation.mutate({ id: d.id, force: false });
  };

  return (
    <div className="max-w-4xl mx-auto py-8 px-4">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900">Personal settings</h2>
        <p className="text-slate-600 mt-1">
          Manage your domains and account preferences. UTM presets live in Links.
        </p>
      </div>

      {/* Sub-tab bar */}
      <div className="border-b border-slate-200 mb-6">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
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
          <Link
            to="/links?tab=utm&panel=presets"
            className="pb-3 text-sm font-medium border-b-2 border-transparent text-slate-500 hover:text-slate-700"
          >
            <BookmarkCheck className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            UTM presets
          </Link>
          <button
            onClick={() => setTab('apikeys')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'apikeys'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <KeyRound className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            API keys
          </button>
          <button
            onClick={() => setTab('appearance')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'appearance'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Palette className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Appearance
          </button>
          <button onClick={() => setTab('notifications')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${tab === 'notifications' ? 'border-brand-purple text-brand-purple' : 'border-transparent text-slate-500 hover:text-slate-700'}`}>
            <Bell className="h-4 w-4 inline mr-1.5 -mt-0.5" />Notifications
          </button>
          {canViewSystem && <button
            onClick={() => setTab('system')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'system'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Activity className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            System
          </button>}
          <button
            onClick={() => setTab('assistant')}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === 'assistant'
                ? 'border-brand-purple text-brand-purple'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Bot className="h-4 w-4 inline mr-1.5 -mt-0.5" />
            Assistant
          </button>
        </div>
      </div>

      {tab === 'appearance' && <AppearanceSettings />}
      {tab === 'notifications' && <Card>
        <CardHeader><CardTitle>Recent opens</CardTitle></CardHeader>
        <p className="mb-4 text-sm text-slate-600">Opens stay in your notifications across sessions until you clear them. Your analytics history is not deleted.</p>
        <Button variant="outline" onClick={() => clearNotifications.mutate()} disabled={clearNotifications.isPending}>Clear All</Button>
      </Card>}

      {tab === 'system' && (canViewSystem ? <SystemSettings /> : <p className="text-sm text-slate-600">System access requires a platform admin.</p>)}

      {tab === 'assistant' && <AssistantSettings />}

      {tab === 'domains' && (
        <>
          {config?.subdomain_enabled && config.platform_subdomain_base && (
            <ClaimSubdomainCard
              base={config.platform_subdomain_base}
              onClaim={(hostname) => createMutation.mutate(hostname)}
              submitting={createMutation.isPending}
            />
          )}

          {customDomains ? (
            <AddOwnDomainCard
              config={config}
              onAdd={(hostname) => createMutation.mutate(hostname)}
              submitting={createMutation.isPending}
            />
          ) : appConfig && (
            <div className="cb-notice mb-6" role="note">
              <p className="cb-notice-title">Custom domains are being set up</p>
              <p>Soon you can share from your own domain, such as share.yourcompany.com. Links you make now keep working when it arrives.</p>
            </div>
          )}

          {customDomains && config?.procurement_enabled && <BuyDomainCard />}

          <Card>
            <CardHeader>
              <CardTitle>Your domains</CardTitle>
            </CardHeader>
            {isLoading ? (
              <div className="py-8 text-center text-sm text-slate-500">Loading.</div>
            ) : domains.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                {customDomains
                  ? 'No custom domains yet. Claim a subdomain or add your own above to start sharing branded short links.'
                  : config?.subdomain_enabled && config.platform_subdomain_base
                    ? 'No domains yet. Claim a subdomain above to start sharing branded short links.'
                    : `No domains yet. Your links use ${appConfig?.platform_host ?? 'the ChampBeam address'} for now.`}
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

      {tab === 'apikeys' && <ApiKeysSettings />}


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
      <form onSubmit={handleSubmit} className="flex flex-col sm:flex-row items-start gap-3">
        <div className="w-full min-w-0 flex-1">
          <Input
            label="Domain"
            placeholder="track.acme.com"
            value={hostname}
            onChange={(e) => setHostname(e.target.value)}
            helperText="Use a subdomain you control. You will add a CNAME record after this step."
          />
        </div>
        <Button
          type="submit"
          isLoading={submitting}
          leftIcon={<Plus className="h-4 w-4" />}
          className="sm:mt-7 whitespace-nowrap"
        >
          Add domain
        </Button>
      </form>
      {config && !config.byod_enabled && (
        <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800 flex items-start gap-2">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            After adding the domain, follow the CNAME steps shown below it, then click
            Refresh. The domain is only marked Live once it actually routes here and its
            certificate is issued, so it may take a few minutes to show Live.
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
      <div className="flex flex-col lg:flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-medium text-slate-900 break-all">
              {domain.hostname}
            </span>
            <Badge variant={STATUS_VARIANT[domain.status]} size="sm">
              {STATUS_LABEL[domain.status]}
            </Badge>
            {!domain.cloudflare_managed && (
              <Badge variant="default" size="sm">Local mode</Badge>
            )}
          </div>
          {domain.ssl_status && (
            <p className="text-xs text-slate-500 mt-1">SSL: {domain.ssl_status}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 max-w-full">
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            leftIcon={<RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />}
          >
            {refreshing ? 'Checking' : 'Recheck'}
          </Button>
          <DefaultToggle domain={domain} onSetPrimary={onSetPrimary} />
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
  // Prefer the domain-level target, then the platform config target. As long
  // as a target is configured, show real setup steps -- the local-mode
  // reachability check verifies the domain regardless of whether Cloudflare
  // certificate automation is on.
  const cname = domain.cname_target || config?.cname_target;
  if (!cname) {
    return (
      <div className="mt-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
        <p className="font-medium mb-1">Pending verification</p>
        <p>
          No CNAME target is configured on this environment. Point this domain at the
          backend host, then click "Refresh". It is only marked Live once it actually
          routes here.
        </p>
      </div>
    );
  }
  // The subdomain label ("beam" for beam.acme.com) -- registrar dashboards ask
  // for the host/name field without the root domain.
  const label = domain.hostname.split('.').slice(0, -2).join('.') || '@';
  return (
    <div className="mt-4 p-3 rounded-lg bg-slate-50 border border-slate-200 text-sm text-slate-700">
      <p className="font-medium text-slate-900 mb-2">Setup steps</p>
      <ol className="list-decimal list-inside space-y-2">
        <li>
          In your DNS provider, add the record below, or send it to your IT team:
          <DnsRecordsCard hostname={domain.hostname} records={dnsRecordsFor(domain.hostname, cname)} />
          <p className="mt-2 text-xs text-slate-500">
            Where to add it: <span className="font-medium">Namecheap</span>: Domain List
            &rarr; Manage &rarr; Advanced DNS &rarr; Add New Record (Type: CNAME, Host:{' '}
            <code className="font-mono">{label}</code>, Value: the target above).{' '}
            <span className="font-medium">GoDaddy</span>: DNS &rarr; Add &rarr; CNAME.{' '}
            <span className="font-medium">Cloudflare</span>: DNS &rarr; Add record (set
            it to "DNS only" while verifying).
          </p>
        </li>
        <li>Wait 1 to 5 minutes for DNS to propagate, then click "Recheck".</li>
        <li>We issue a TLS certificate; the status flips to Active automatically.</li>
      </ol>
    </div>
  );
}

function BuyDomainCard() {
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<DomainSearchResult[] | null>(null);

  const searchMutation = useMutation({
    mutationFn: (q: string) => utmApi.searchDomains(q),
    onSuccess: (rows) => setResults(rows),
    onError: (err: unknown) => {
      const msg = apiErrorDetail(err);
      toast.error(msg ?? 'Search failed.');
    },
  });

  const purchaseMutation = useMutation({
    mutationFn: (name: string) => utmApi.purchaseDomain(name),
    onSuccess: (domain) => {
      toast.success(`${domain.hostname} is being set up. Watch its status below.`);
      setResults(null);
      setQuery('');
      queryClient.invalidateQueries({ queryKey: ['domains'] });
    },
    onError: (err: unknown) => {
      const msg = apiErrorDetail(err);
      toast.error(msg ?? 'Could not register that domain.');
    },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) {
      toast.error('Type a name or keyword to search.');
      return;
    }
    searchMutation.mutate(q);
  };

  const confirmBuy = async (r: DomainSearchResult) => {
    const price = r.registration_cost ? ` for ${r.currency ?? '$'}${r.registration_cost}/yr` : '';
    if (await confirm({ title: 'Register domain', message: `Register ${r.name}${price}? This is billed immediately and is non-refundable.`, confirmLabel: 'Register', destructive: false })) {
      purchaseMutation.mutate(r.name);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShoppingCart className="h-5 w-5 text-brand-purple" />
          Get a new domain
        </CardTitle>
      </CardHeader>
      <form onSubmit={handleSearch} className="flex items-start gap-3">
        <div className="flex-1">
          <Input
            label="Search domains"
            placeholder="acme, acmepitch.com…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            helperText="We register it and wire it up automatically. No DNS steps."
          />
        </div>
        <Button
          type="submit"
          isLoading={searchMutation.isPending}
          leftIcon={<Search className="h-4 w-4" />}
          className="mt-7 whitespace-nowrap"
        >
          Search
        </Button>
      </form>

      {results && (
        <div className="mt-4 divide-y divide-slate-100 border-t border-slate-100">
          {results.length === 0 ? (
            <p className="py-4 text-sm text-slate-500">No suggestions. Try another keyword.</p>
          ) : (
            results.map((r) => (
              <div key={r.name} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <span className="font-mono text-sm text-slate-900 break-all">{r.name}</span>
                  {!r.available && (
                    <Badge variant="default" size="sm" className="ml-2">
                      {r.reason === 'domain_unavailable' ? 'Taken' : r.reason ?? 'Unavailable'}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  {r.registration_cost && (
                    <span className="text-sm text-slate-600">
                      {r.currency ?? '$'}
                      {r.registration_cost}
                      <span className="text-slate-400">/yr</span>
                    </span>
                  )}
                  <Button
                    size="sm"
                    disabled={!r.available}
                    isLoading={purchaseMutation.isPending && purchaseMutation.variables === r.name}
                    onClick={() => confirmBuy(r)}
                    leftIcon={<ShoppingCart className="h-4 w-4" />}
                  >
                    Buy
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </Card>
  );
}

/** "Use as default for new links". There is no unset call, so the default is changed by picking another domain. */
function DefaultToggle({ domain, onSetPrimary }: { domain: Domain; onSetPrimary: () => void }) {
  const why = domain.is_primary ? 'This is your default. Turn it on for another domain to change it.'
    : domain.status !== 'active' ? 'Available once the domain is active.' : '';
  return <span className="cb-switch-wrap">
    <label className="cb-switch">
      <input type="checkbox" role="switch" checked={domain.is_primary} disabled={domain.is_primary || domain.status !== 'active'} onChange={onSetPrimary} aria-describedby={why ? `why-${domain.id}` : undefined} />
      <span>Use as default for new links</span>
    </label>
    {why && <span id={`why-${domain.id}`} className="cb-hint">{why}</span>}
  </span>;
}
