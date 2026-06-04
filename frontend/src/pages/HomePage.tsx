import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Copy,
  Clock,
  Link2,
  FileSpreadsheet,
  FileText,
  Eye,
  Download,
  BarChart3,
  ArrowRight,
  Send,
  Globe,
  ShieldCheck,
  Upload,
  MousePointerClick,
  Zap,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { SignInButton, SignUpButton, useAuth } from '@clerk/react';
import { Card, CardHeader, CardTitle, Button, Input } from '../components/ui';
import { FileUploadZone } from '../components/ui/FileUploadZone';
import { ShareFilePanel } from '../components/ShareFilePanel';
import { utmApi } from '../api/utm';
import type { UTMPreset, Project, GenerateLinkResponse, Domain } from '../api/utm';
import { filesApi } from '../api/files';
import type { FileAsset } from '../api/files';

type GeneratorMode = 'single' | 'bulk';

const STORAGE_KEY = 'champutm_link_history';

interface HistoryItem {
  url: string;
  redirectUrl?: string;
  linkId?: string;
  generatedAt: string;
}

function loadHistory(): HistoryItem[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (Array.isArray(parsed)) return parsed as HistoryItem[];
    localStorage.removeItem(STORAGE_KEY);
    return [];
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return [];
  }
}

function persistHistory(items: HistoryItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // localStorage may be unavailable (private mode, quota). The in-memory
    // history still renders this session, so swallow the error.
  }
}

// Marketing content reused on the signed-out home page.
const VALUE_PROPS = [
  {
    icon: Send,
    title: 'Send anything',
    body: 'Links and files (PDFs, video, images, HTML) become one clean, short link. No account needed to start.',
  },
  {
    icon: Eye,
    title: 'Know it landed',
    body: 'Real-time read receipts. See the moment your link or file is opened, with live open and click counts.',
  },
  {
    icon: BarChart3,
    title: 'Understand the audience',
    body: 'Every open is enriched with location, device, browser, and UTM campaign attribution, automatically.',
  },
];

const STEPS = [
  { icon: Upload, title: 'Paste a URL or drop a file', body: 'Start from the generator below, no signup required.' },
  { icon: Link2, title: 'Get a short, trackable link', body: 'One link to share anywhere: email, chat, or social.' },
  { icon: MousePointerClick, title: 'Watch opens roll in', body: 'See who opened it, when, from where, and on what device.' },
];

const USE_CASES = [
  'Sales collateral & proposals',
  'Candidate & recruiter outreach',
  'Investor updates',
  'Newsletters & launches',
  'Ad & social campaigns',
  'Contracts & one-off file sends',
];

/** Marketing hero + value content shown above the generator for signed-out visitors. */
function GuestMarketing() {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden rounded-2xl border border-slate-200 mb-10">
        <div className="absolute inset-0 bg-gradient-to-br from-brand-purple/10 via-white to-brand-teal/10" />
        <div className="relative max-w-4xl mx-auto px-4 pt-14 pb-12 text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-purple/10 px-3 py-1 text-sm font-medium text-brand-purple mb-6">
            <Zap className="h-4 w-4" />
            Links + files, with read receipts
          </span>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-slate-900">
            Send it.{' '}
            <span className="bg-gradient-to-r from-brand-purple to-brand-teal bg-clip-text text-transparent">
              Know they saw it.
            </span>
          </h1>
          <p className="mt-5 text-lg text-slate-600 max-w-2xl mx-auto">
            ChampUTM turns any link or file into one short, trackable link with read
            receipts. See exactly when, where, and on what device it was opened.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <SignUpButton mode="modal" forceRedirectUrl="/" fallbackRedirectUrl="/">
              <Button size="lg" rightIcon={<ArrowRight className="h-4 w-4" />}>
                Sign up free
              </Button>
            </SignUpButton>
            <SignInButton mode="modal" forceRedirectUrl="/" fallbackRedirectUrl="/">
              <Button size="lg" variant="outline">
                Sign in
              </Button>
            </SignInButton>
          </div>
          <p className="mt-4 text-sm text-slate-500">
            No credit card. Or just start generating links below, no account required.
          </p>
        </div>
      </section>

      {/* Value props */}
      <section className="mb-12">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {VALUE_PROPS.map((p) => {
            const Icon = p.icon;
            return (
              <Card key={p.title} className="h-full">
                <div className="h-12 w-12 rounded-lg bg-brand-purple/10 flex items-center justify-center mb-4">
                  <Icon className="h-6 w-6 text-brand-purple" />
                </div>
                <h3 className="text-lg font-semibold text-slate-900">{p.title}</h3>
                <p className="mt-2 text-sm text-slate-600">{p.body}</p>
              </Card>
            );
          })}
        </div>
      </section>
    </>
  );
}

/** Marketing detail + closing CTA shown below the generator for signed-out visitors. */
function GuestDetails() {
  return (
    <>
      {/* How it works */}
      <section className="mt-16">
        <div className="text-center mb-10">
          <h2 className="text-3xl font-bold text-slate-900">How it works</h2>
          <p className="mt-2 text-slate-600">From share to read receipt in three steps.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {STEPS.map((s, i) => {
            const Icon = s.icon;
            return (
              <Card key={s.title} className="h-full">
                <div className="flex items-center gap-3 mb-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-purple text-white text-sm font-bold">
                    {i + 1}
                  </span>
                  <Icon className="h-5 w-5 text-brand-teal" />
                </div>
                <h3 className="text-base font-semibold text-slate-900">{s.title}</h3>
                <p className="mt-1 text-sm text-slate-600">{s.body}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Files + read receipts highlight */}
      <section className="mt-16">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-center">
          <div>
            <h2 className="text-3xl font-bold text-slate-900">
              Stop wondering if it was opened
            </h2>
            <p className="mt-4 text-slate-600">
              Email attachments disappear into inboxes. ChampUTM links do not. Share a
              proposal, a deck, or a contract and get a live signal the second it is viewed,
              then dig into the geography, device, and campaign behind every open.
            </p>
            <ul className="mt-6 space-y-3">
              {[
                { icon: FileText, text: 'Host PDFs, video, images, and HTML behind one link' },
                { icon: Eye, text: 'Seen / Not opened yet read receipts in real time' },
                { icon: Globe, text: 'Country, region, and city for every open' },
                { icon: ShieldCheck, text: 'VPN detection and per-link, on-your-domain hosting' },
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
          </div>
          <Card className="bg-gradient-to-br from-brand-purple/5 to-brand-teal/5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-3">
              Built for
            </p>
            <div className="flex flex-wrap gap-2">
              {USE_CASES.map((u) => (
                <span
                  key={u}
                  className="rounded-full bg-white border border-slate-200 px-3 py-1.5 text-sm text-slate-700"
                >
                  {u}
                </span>
              ))}
            </div>
          </Card>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="mt-16 rounded-2xl bg-brand-navy">
        <div className="max-w-3xl mx-auto px-4 py-14 text-center">
          <h2 className="text-3xl font-bold text-white">Share something. See who opens it.</h2>
          <p className="mt-3 text-white/70">
            The free UTM generator you already trust, now for files too.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <SignUpButton mode="modal" forceRedirectUrl="/" fallbackRedirectUrl="/">
              <Button size="lg" rightIcon={<ArrowRight className="h-4 w-4" />}>
                Create an account
              </Button>
            </SignUpButton>
            <SignInButton mode="modal" forceRedirectUrl="/" fallbackRedirectUrl="/">
              <Button size="lg" variant="secondary">
                Sign in
              </Button>
            </SignInButton>
          </div>
        </div>
      </section>
    </>
  );
}

export function HomePage() {
  const { isSignedIn } = useAuth();
  const isAuthenticated = !!isSignedIn;
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<GeneratorMode>('single');
  const [primaryMode, setPrimaryMode] = useState<'link' | 'file'>('link');
  const [isProcessing, setIsProcessing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [utmSource, setUtmSource] = useState('');
  const [utmMedium, setUtmMedium] = useState('');
  const [utmCampaign, setUtmCampaign] = useState('');
  const [utmContent, setUtmContent] = useState('');
  const [utmTerm, setUtmTerm] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('project') || '');
  const [selectedDomainId, setSelectedDomainId] = useState('');
  const [lastGenerateResponse, setLastGenerateResponse] = useState<GenerateLinkResponse | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Fetch presets only if authenticated
  const { data: presets = [] } = useQuery<UTMPreset[]>({
    queryKey: ['utm', 'presets'],
    queryFn: () => utmApi.getPresets(),
    enabled: isAuthenticated,
  });

  // Fetch projects only if authenticated
  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: () => utmApi.getProjects(),
    enabled: isAuthenticated,
  });

  // Fetch custom domains so the user can pick one for the short URL.
  const { data: domains = [] } = useQuery<Domain[]>({
    queryKey: ['domains'],
    queryFn: () => utmApi.listDomains(),
    enabled: isAuthenticated,
  });
  const activeDomains = domains.filter((d) => d.status === 'active');

  // Recent files for the signed-in dashboard's "Your Files" card.
  const { data: recentFiles = [] } = useQuery<FileAsset[]>({
    queryKey: ['files'],
    queryFn: () => filesApi.list(),
    enabled: isAuthenticated,
  });

  // Default the selector to the primary domain on first load.
  useEffect(() => {
    if (selectedDomainId) return;
    const primary = activeDomains.find((d) => d.is_primary);
    if (primary) setSelectedDomainId(primary.id);
  }, [activeDomains, selectedDomainId]);

  // Load history from localStorage once on mount.
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  // Fill form from preset
  useEffect(() => {
    if (selectedPresetId) {
      const preset = presets.find((p) => p.id === selectedPresetId);
      if (preset) {
        setUtmSource(preset.utm_source || '');
        setUtmMedium(preset.utm_medium || '');
        setUtmCampaign(preset.utm_campaign || '');
        setUtmContent(preset.utm_content || '');
        setUtmTerm(preset.utm_term || '');
      }
    }
  }, [selectedPresetId, presets]);

  // Client-side URL generation (works without auth)
  const generateUrl = () => {
    if (!baseUrl) return '';
    try {
      let url: URL;
      if (baseUrl.startsWith('http://') || baseUrl.startsWith('https://')) {
        url = new URL(baseUrl);
      } else {
        url = new URL('https://' + baseUrl);
      }
      if (utmSource) url.searchParams.set('utm_source', utmSource);
      if (utmMedium) url.searchParams.set('utm_medium', utmMedium);
      if (utmCampaign) url.searchParams.set('utm_campaign', utmCampaign);
      if (utmContent) url.searchParams.set('utm_content', utmContent);
      if (utmTerm) url.searchParams.set('utm_term', utmTerm);
      return url.toString();
    } catch {
      return '';
    }
  };

  const finalUrl = generateUrl();

  // Prepend the new entry, de-duplicate by URL, cap at 10, and persist.
  // Uses a functional update so rapid successive generations cannot drop
  // an earlier entry by reading a stale `history` closure.
  const addHistoryEntry = (entry: HistoryItem) => {
    setHistory((prev) => {
      const next = [entry, ...prev.filter((h) => h.url !== entry.url)].slice(0, 10);
      persistHistory(next);
      return next;
    });
  };

  const handleCopy = async () => {
    if (!finalUrl) {
      toast.error('Please enter a valid base URL');
      return;
    }

    let redirectUrl: string | undefined;
    let linkId: string | undefined;

    // If authenticated, track the link via API first so we can copy the redirect URL
    if (isAuthenticated) {
      try {
        const response = await utmApi.generateLink({
          base_url: baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl,
          utm_source: utmSource || undefined,
          utm_medium: utmMedium || undefined,
          utm_campaign: utmCampaign || undefined,
          utm_content: utmContent || undefined,
          utm_term: utmTerm || undefined,
          project_id: selectedProjectId || undefined,
          preset_id: selectedPresetId || undefined,
          domain_id: selectedDomainId || undefined,
        });
        setLastGenerateResponse(response);
        redirectUrl = response.redirect_url || undefined;
        linkId = response.link_id || undefined;
        // Bump the projects cache so the per-project counts on the
        // Generator + Analytics pages reflect the new link immediately
        // rather than waiting for react-query's 5-minute staleTime.
        queryClient.invalidateQueries({ queryKey: ['projects'] });
      } catch {
        // Non-blocking: fall back to copying the UTM URL
      }
    }

    // Copy the short link (trackable) if available, otherwise the UTM URL
    const urlToCopy = redirectUrl || finalUrl;
    navigator.clipboard.writeText(urlToCopy);
    toast.success(redirectUrl ? 'Short link generated and copied' : 'URL copied to clipboard');

    // Save to localStorage history with redirect URL + link id (for analytics).
    addHistoryEntry({ url: finalUrl, redirectUrl, linkId, generatedAt: new Date().toISOString() });
  };

  const handleDownloadTemplate = async () => {
    try {
      const blob = await utmApi.downloadTemplate();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'utm_template.csv';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('Template downloaded');
    } catch {
      toast.error('Failed to download template');
    }
  };

  const handleBulkFileSelected = async (file: File) => {
    setIsProcessing(true);
    try {
      const blob = await utmApi.processBulkCSV(file, selectedPresetId || undefined);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'utm_links.csv';
      a.click();
      window.URL.revokeObjectURL(url);
      toast.success('CSV processed! Download started.');
    } catch {
      toast.error('Failed to process CSV. Make sure it has a "url" column.');
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      {/* Marketing hero + value props for signed-out visitors, above the live generator. */}
      {!isAuthenticated && <GuestMarketing />}

      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            {primaryMode === 'file' ? 'Share & Track Files' : 'UTM Link Generator'}
          </h1>
          <p className="text-slate-600 mt-1">
            {primaryMode === 'file'
              ? 'Send a file and see the moment it is opened, no account needed.'
              : 'Create trackable UTM-tagged URLs for your marketing campaigns.'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {/* One segmented control: Link / Bulk / File (Bulk = signed-in only) */}
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            <button
              onClick={() => { setPrimaryMode('link'); setMode('single'); }}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
                primaryMode === 'link' && mode === 'single'
                  ? 'bg-brand-purple text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Link2 className="h-4 w-4" />
              Link
            </button>
            {isAuthenticated && (
              <button
                onClick={() => { setPrimaryMode('link'); setMode('bulk'); }}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-l border-slate-200 transition-colors ${
                  primaryMode === 'link' && mode === 'bulk'
                    ? 'bg-brand-purple text-white'
                    : 'bg-white text-slate-600 hover:bg-slate-50'
                }`}
              >
                <FileSpreadsheet className="h-4 w-4" />
                Bulk
              </button>
            )}
            <button
              onClick={() => setPrimaryMode('file')}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-l border-slate-200 transition-colors ${
                primaryMode === 'file'
                  ? 'bg-brand-purple text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <FileText className="h-4 w-4" />
              File
            </button>
          </div>
        </div>
      </div>

      {/* Bulk CSV mode: same container + two-column layout as the Link tab. */}
      {primaryMode === 'link' && mode === 'bulk' && isAuthenticated && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Configuration</CardTitle>
              </CardHeader>
              <div className="space-y-4">
                {presets.length > 0 && (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Apply Preset (optional)
                    </label>
                    <select
                      className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
                      value={selectedPresetId}
                      onChange={(e) => setSelectedPresetId(e.target.value)}
                    >
                      <option value="">No preset (use CSV columns)</option>
                      {presets.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} {p.is_default ? '(default)' : ''}
                        </option>
                      ))}
                    </select>
                    <p className="text-xs text-slate-500 mt-1">
                      Preset values are used as defaults. Per-row UTM columns in the CSV override them.
                    </p>
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="outline" size="sm" onClick={handleDownloadTemplate} leftIcon={<Download className="h-4 w-4" />}>
                    Download CSV Template
                  </Button>
                  <span className="text-xs text-slate-500">
                    Template includes: url, utm_source, utm_medium, utm_campaign, utm_content, utm_term
                  </span>
                </div>
              </div>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FileSpreadsheet className="h-5 w-5" />
                  Upload CSV
                </CardTitle>
              </CardHeader>
              <FileUploadZone onFileSelected={handleBulkFileSelected} isUploading={isProcessing} />
            </Card>
          </div>

          {/* Sidebar: how it works, matching the Link tab's two-column rhythm. */}
          <div>
            <Card className="bg-slate-50">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">How it works</h3>
              <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
                <li>Download the CSV template or prepare your own CSV with a <code className="bg-white px-1 py-0.5 rounded text-brand-purple">url</code> column.</li>
                <li>Optionally include <code className="bg-white px-1 py-0.5 rounded text-brand-purple">utm_source</code>, <code className="bg-white px-1 py-0.5 rounded text-brand-purple">utm_medium</code>, etc. columns for per-row overrides.</li>
                <li>Select a preset if you want default UTM values applied to all rows.</li>
                <li>Upload the CSV. A processed file with <code className="bg-white px-1 py-0.5 rounded text-brand-purple">tracked_url</code> and <code className="bg-white px-1 py-0.5 rounded text-brand-purple">short_link</code> columns will download automatically. Every short link is tracked, so opens by region and device show up on the Analytics page.</li>
              </ol>
            </Card>
          </div>
        </div>
      )}

      {/* Single URL mode */}
      {primaryMode === 'link' && mode === 'single' && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main form */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <div className="space-y-6">
              <Input
                label="Website URL"
                placeholder="https://example.com/landing-page"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />

              {/* Preset selector (auth only, when presets exist) */}
              {isAuthenticated && presets.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Load from Preset
                  </label>
                  <select
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
                    value={selectedPresetId}
                    onChange={(e) => setSelectedPresetId(e.target.value)}
                  >
                    <option value="">-- Choose a preset --</option>
                    {presets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} {p.is_default ? '(default)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Project selector (auth only, when projects exist) */}
              {isAuthenticated && projects.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Project (optional)
                  </label>
                  <select
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
                    value={selectedProjectId}
                    onChange={(e) => setSelectedProjectId(e.target.value)}
                  >
                    <option value="">No Project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Domain selector (auth only, when at least one active domain exists) */}
              {isAuthenticated && activeDomains.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Short link domain
                  </label>
                  <select
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
                    value={selectedDomainId}
                    onChange={(e) => setSelectedDomainId(e.target.value)}
                  >
                    <option value="">Platform default</option>
                    {activeDomains.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.hostname}{d.is_primary ? ' (primary)' : ''}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="border-t border-slate-200 pt-6">
                <h3 className="text-sm font-medium text-slate-900 mb-4">UTM Parameters</h3>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Input
                      label="Campaign Source (utm_source)"
                      placeholder="e.g. google, newsletter, linkedin"
                      value={utmSource}
                      onChange={(e) => setUtmSource(e.target.value)}
                    />
                    <Input
                      label="Campaign Medium (utm_medium)"
                      placeholder="e.g. cpc, email, social"
                      value={utmMedium}
                      onChange={(e) => setUtmMedium(e.target.value)}
                    />
                  </div>
                  <Input
                    label="Campaign Name (utm_campaign)"
                    placeholder="e.g. spring_sale, product_launch"
                    value={utmCampaign}
                    onChange={(e) => setUtmCampaign(e.target.value)}
                  />
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <Input
                      label="Campaign Term (utm_term)"
                      placeholder="e.g. running+shoes"
                      helperText="Optional: identify paid keywords"
                      value={utmTerm}
                      onChange={(e) => setUtmTerm(e.target.value)}
                    />
                    <Input
                      label="Campaign Content (utm_content)"
                      placeholder="e.g. logo_link, text_link"
                      helperText="Optional: differentiate ads/links"
                      value={utmContent}
                      onChange={(e) => setUtmContent(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Generated URL */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                  Generated URL
                </h4>
                <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                  <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg p-3 min-h-[3rem] text-sm break-all font-mono text-slate-700">
                    {finalUrl || (
                      <span className="text-slate-400 italic">
                        Enter a URL above to generate your trackable link
                      </span>
                    )}
                  </div>
                  <Button
                    onClick={handleCopy}
                    disabled={!finalUrl}
                    leftIcon={<Copy className="h-4 w-4" />}
                    className="w-full sm:w-auto flex-shrink-0"
                  >
                    {isAuthenticated ? 'Generate' : 'Copy'}
                  </Button>
                </div>
                {lastGenerateResponse?.redirect_url && (
                  <div className="mt-3">
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                      Short Link
                    </h4>
                    <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                      <div className="flex-1 min-w-0 bg-white border border-slate-200 rounded-lg p-3 text-sm break-all font-mono text-brand-purple">
                        {lastGenerateResponse.redirect_url}
                      </div>
                      <Button
                        onClick={() => {
                          navigator.clipboard.writeText(lastGenerateResponse.redirect_url!);
                          toast.success('Short link copied');
                        }}
                        leftIcon={<Copy className="h-4 w-4" />}
                        className="w-full sm:w-auto flex-shrink-0"
                      >
                        Copy Short Link
                      </Button>
                    </div>
                    {lastGenerateResponse.link_id && (
                      <div className="mt-3 flex items-center justify-between bg-brand-purple/5 border border-brand-purple/20 rounded-lg p-3">
                        <p className="text-sm text-slate-700">
                          This link is being tracked. Open the short link once and clicks will appear here.
                        </p>
                        <Link to={`/analytics/link/${lastGenerateResponse.link_id}`}>
                          <Button variant="outline" size="sm" leftIcon={<BarChart3 className="h-4 w-4" />}>
                            View Analytics
                          </Button>
                        </Link>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* CTA for unauthenticated users */}
          {!isAuthenticated && (
            <Card className="bg-brand-purple/5 border-brand-purple/20">
              <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                <div className="h-12 w-12 bg-brand-purple/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <BarChart3 className="h-6 w-6 text-brand-purple" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-slate-900">Unlock Advanced Features</h3>
                  <p className="text-sm text-slate-600">
                    Sign up free to save presets, track clicks, view analytics, and process bulk URLs.
                  </p>
                </div>
                <SignUpButton mode="modal" forceRedirectUrl="/" fallbackRedirectUrl="/">
                  <Button size="sm" className="flex-shrink-0">Sign Up Free</Button>
                </SignUpButton>
              </div>
            </Card>
          )}
        </div>

        {/* Recent links sidebar */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4" />
                Recent Links
              </CardTitle>
            </CardHeader>
            {history.length === 0 ? (
              <div className="text-center text-sm text-slate-500 py-4">
                No links generated yet
              </div>
            ) : (
              <div className="divide-y divide-slate-100 max-h-[500px] overflow-y-auto -mx-6 -mb-6">
                {history.map((item, i) => (
                  <div key={i} className="px-6 py-4 hover:bg-slate-50 transition-colors group">
                    {/* Show redirect URL prominently if available */}
                    {item.redirectUrl ? (
                      <>
                        <p className="text-xs text-brand-purple font-mono break-all line-clamp-1 mb-1" title={item.redirectUrl}>
                          {item.redirectUrl}
                        </p>
                        <p className="text-[10px] text-slate-400 font-mono break-all line-clamp-1 mb-2" title={item.url}>
                          {item.url}
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-brand-purple font-mono break-all line-clamp-2 mb-2" title={item.url}>
                        {item.url}
                      </p>
                    )}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-400 flex-shrink-0">
                        {new Date(item.generatedAt).toLocaleString()}
                      </span>
                      <div className="flex items-center gap-1">
                        {item.linkId && (
                          <Link to={`/analytics/link/${item.linkId}`} title="View analytics">
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-brand-purple">
                              <BarChart3 className="h-3.5 w-3.5 mr-1" />
                              Analytics
                            </Button>
                          </Link>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2"
                          onClick={() => {
                            navigator.clipboard.writeText(item.redirectUrl || item.url);
                            toast.success('Copied');
                          }}
                        >
                          <Copy className="h-3.5 w-3.5 mr-1" />
                          Copy
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {isAuthenticated && (
            <Card className="mt-6">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <FileText className="h-4 w-4" />
                  Your Files
                </CardTitle>
              </CardHeader>
              {recentFiles.length === 0 ? (
                <div className="text-center text-sm text-slate-500 py-4">
                  No files yet.{' '}
                  <button
                    onClick={() => setPrimaryMode('file')}
                    className="text-brand-purple hover:underline"
                  >
                    Share one
                  </button>
                </div>
              ) : (
                <div className="divide-y divide-slate-100 -mx-6 -mb-6">
                  {recentFiles.slice(0, 4).map((f) => (
                    <div key={f.id} className="px-6 py-3 flex items-center justify-between gap-2">
                      <span className="text-sm text-slate-700 truncate" title={f.filename}>
                        {f.filename}
                      </span>
                      <span className="text-xs text-slate-500 flex items-center gap-1 flex-shrink-0">
                        <Eye className="h-3 w-3" />
                        {f.view_count}
                      </span>
                    </div>
                  ))}
                  <Link
                    to="/files"
                    className="block px-6 py-3 text-sm text-brand-purple hover:underline"
                  >
                    Manage all files
                  </Link>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      )}

      {primaryMode === 'file' && <ShareFilePanel isAuthenticated={isAuthenticated} />}

      {/* Marketing detail + closing CTA for signed-out visitors, below the generator. */}
      {!isAuthenticated && <GuestDetails />}
    </div>
  );
}
