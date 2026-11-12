import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { CopyButton } from '../components/ui/copy-button';
import './domain-records.css';
import { OrganizationSettings } from '../components/OrganizationSettings';
import { useOrgContext } from '../hooks/useOrgContext';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Activity, AlertTriangle, Bell, BookmarkCheck, Bot, CheckCircle2, Globe, Info, KeyRound, Palette, Plus, RefreshCw, Search, ShoppingCart, Star, Trash2, Zap } from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, Input, useConfirm } from '../components/ui';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { ApiKeysSettings } from '../components/ApiKeysSettings';
import { AssistantSettings } from '../components/AssistantSettings';
import { utmApi } from '../api/utm';
import type { Domain, DomainSearchResult, DomainsConfig, DomainStatus } from '../api/utm';

import { SystemSettings } from '../components/SystemSettings';
import { apiErrorDetail, apiErrorStatus } from '../api/_shared';
import { systemApi } from '../api/system';
import { useAuth } from '@clerk/react';

type SettingsTab = 'domains' | 'apikeys' | 'appearance' | 'notifications' | 'system' | 'assistant';

function initialTab(param: string | null): SettingsTab {
  if (param === 'appearance' || param === 'apikeys' || param === 'notifications' || param === 'system' || param === 'assistant')
    return param;
  return 'domains';
}

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
  const [params] = useSearchParams();
  const { inOrg, permissions, isLoading, error } = useOrgContext();
  if (params.get('tab') === 'presets' || params.get('tab') === 'utm') return <Navigate to="/links?tab=utm&panel=presets" replace />;
  if (isLoading) return <p role="status">Loading workspace settings…</p>;
  if (error) return <p role="alert">Could not verify workspace access. Reload or sign in again.</p>;
  return <div className="cb-workspace"><h1>Settings</h1>{inOrg && <OrganizationSettings />}{(!inOrg || permissions.includes('org.domains.manage')) ? <PersonalSettings /> : <AppearanceSettings />}</div>;
}

function PersonalSettings() {
  const { userId } = useAuth();
  const { orgId } = useOrgContext();
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

  const { data: domains = [], isLoading, isError: domainsError, refetch: reloadDomains } = useQuery<Domain[]>({
    queryKey: ['domains', orgId, userId],
    queryFn: async () => {
      const rows = await utmApi.listDomains();
      return Promise.all(rows.map(async (d) =>
        d.status === 'pending_cname' || d.status === 'pending_ssl' ? utmApi.refreshDomain(d.id).catch(() => d) : d
      ));
    },
    // Listing alone does not recheck DNS on the backend.
    refetchInterval: (query) => {
      const data = query.state.data;
      const pending = data?.some(
        (d) => d.status === 'pending_cname' || d.status === 'pending_ssl'
      );
      return pending ? 20_000 : false;
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
    onError: (err: unknown) => toast.error(apiErrorDetail(err) ?? 'Could not check this domain. Try Refresh again.'),
  });

  const primaryMutation = useMutation({
    mutationFn: (id: string) => utmApi.setPrimaryDomain(id),
    onSuccess: () => {
      toast.success('Primary domain updated.');
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

  const handleDelete = async (d: Domain) => {
    const confirmMsg = `Remove ${d.hostname}? Links generated with this domain will stop resolving.`;
    if (!(await confirm({ message: confirmMsg, confirmLabel: 'Remove' }))) return;
    deleteMutation.mutate({ id: d.id, force: false });
  };

  return (
    <div className="cb-domain-settings max-w-4xl mx-auto py-8 px-4">
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

          <AddOwnDomainCard
            config={config}
            onAdd={(hostname) => createMutation.mutate(hostname)}
            submitting={createMutation.isPending}
          />

          {config?.procurement_enabled && <BuyDomainCard />}

          {domainsError && <div role="alert"><p>Could not update domain status. Check your connection and retry.</p><Button variant="secondary" onClick={() => void reloadDomains()}>Retry domains</Button></div>}
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

export function DomainRow({ domain, config, onRefresh, onSetPrimary, onDelete, refreshing }: DomainRowProps) {
  const isActive = domain.status === 'active';
  const isFailed = domain.status === 'failed';

  return (
    <div className="cb-domain-row px-6 py-5">
      <div className="flex flex-col lg:flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-medium text-slate-900 break-all">
              {domain.hostname}
            </span>
            <Badge className="cb-domain-badge" variant={STATUS_VARIANT[domain.status]} size="sm">
              {STATUS_LABEL[domain.status]}
            </Badge>
            {domain.is_primary && (
              <Badge className="cb-domain-badge" variant="info" size="sm">
                <Star className="h-3 w-3 mr-1 inline" />
                Primary
              </Badge>
            )}
            {!domain.cloudflare_managed && (
              <Badge className="cb-domain-badge" variant="default" size="sm">Local mode</Badge>
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

      <p className="cb-domain-next" role="status">{domain.status === 'pending_cname' ? 'Add the DNS records below. We check automatically every 20 seconds.' : domain.status === 'pending_ssl' ? 'DNS is being verified and the certificate is being issued. We check every 20 seconds.' : isFailed ? 'Review the verification error, correct your DNS records, then Refresh to retry.' : 'DNS and certificate are ready.'}</p>
      {!isActive && <SetupInstructions domain={domain} config={config} />}

      {isFailed && domain.verification_errors && (
        <div className="cb-domain-error mt-3 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-start gap-2">
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
        <div className="cb-domain-ready mt-3 p-3 rounded-lg bg-green-50 border border-green-200 text-sm text-green-800 flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          Ready: pick this domain when generating a link.
        </div>
      )}
    </div>
  );
}

function SetupInstructions({ domain, config }: { domain: Domain; config: DomainsConfig | undefined }) {
  const target = domain.cname_target || config?.cname_target;
  const records = domain.dns_records ?? (target ? [{
    type: 'CNAME', name: domain.hostname, value: target, purpose: 'Routes traffic to ChampBeam',
  }] : []);
  const [notice, setNotice] = useState('');
  const handoff = useMutation({
    mutationFn: async (download: boolean) => {
      const text = await utmApi.domainRecordsText(domain.id);
      if (download) {
        const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url; a.download = `${domain.hostname}-dns-records.txt`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      } else await navigator.clipboard.writeText(text);
      return download;
    },
    onMutate: () => setNotice(''),
    onSuccess: (download) => setNotice(download ? 'DNS records downloaded.' : 'Copied all records for IT.'),
    onError: () => setNotice('Could not prepare the DNS handoff. Check your connection or clipboard permission and try again.'),
  });
  return <Card className="cb-dns-records mt-4" padding="sm">
    <h4>DNS records for IT</h4>
    <p>Add TXT records first to validate ownership and the certificate. Add the CNAME only when ready to switch traffic.</p>
    {records.length ? <table>
      <caption className="sr-only">DNS records for {domain.hostname}</caption>
      <thead><tr><th scope="col">Type</th><th scope="col">Name</th><th scope="col">Value</th><th scope="col">Purpose</th></tr></thead>
      <tbody>{records.map((r) => <tr key={`${r.type}:${r.name}:${r.value}`}>
        <td data-label="Type"><code>{r.type}</code></td>
        <td data-label="Name"><div className="cb-dns-value"><code>{r.name}</code><CopyButton text={r.name} aria-label={`Copy ${r.type} name`} /></div></td>
        <td data-label="Value"><div className="cb-dns-value"><code>{r.value}</code><CopyButton text={r.value} aria-label={`Copy ${r.type} value`} /></div></td>
        <td data-label="Purpose">{r.purpose}{r.type === 'CNAME' && <Badge className="cb-domain-badge" variant="default" size="sm">DNS only (grey cloud)</Badge>}</td>
      </tr>)}</tbody>
    </table> : <p role="status">DNS records are not available yet. Refresh to request them again.</p>}
    {!records.some((r) => r.type === 'TXT') && domain.cloudflare_managed && <p>TXT records have not been issued yet. We will check again automatically.</p>}
    <div className="cb-dns-actions">
      <Button variant="secondary" onClick={() => handoff.mutate(false)} isLoading={handoff.isPending && handoff.variables === false}>Copy all for IT</Button>
      <Button variant="ghost" onClick={() => handoff.mutate(true)} isLoading={handoff.isPending && handoff.variables === true}>Download .txt</Button>
    </div>
    <p role={handoff.isError ? 'alert' : 'status'}>{notice}</p>
  </Card>;
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
