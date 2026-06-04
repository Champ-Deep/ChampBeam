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
  ChevronDown,
  Check,
  Sparkles,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { SignInButton, SignUpButton, useAuth } from '@clerk/react';
import {
  Card,
  CardHeader,
  CardTitle,
  Button,
  Input,
  Badge,
  QrCode,
  QrButton,
  QrDownloadButton,
} from '../components/ui';
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
            ChampUTM turns any link or file into one short, trackable link with a QR code and read
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
            No credit card. Or just start below, no account required.
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

/**
 * The centerpiece result card shown after a link is generated. Surfaces the
 * short URL large + monospaced with a Copy button, the QR code with Download,
 * and a live tracking state ("Seen" vs "Not opened yet") that polls the link's
 * click count.
 */
function LinkResultCard({
  response,
  utmUrl,
}: {
  response: GenerateLinkResponse;
  utmUrl: string;
}) {
  const shortUrl = response.redirect_url || utmUrl;
  const linkId = response.link_id || undefined;

  // Live click count: poll the per-link performance row so the "they opened it"
  // moment surfaces without a manual refresh. Only when we have a tracked link.
  const { data: clickCount = 0 } = useQuery<number>({
    queryKey: ['link-clicks', linkId],
    queryFn: async () => {
      const links = await utmApi.getLinkPerformance({ days: 365 });
      const row = links.find((l) => l.link_id === linkId);
      return row?.click_count ?? 0;
    },
    enabled: !!linkId,
    refetchInterval: 15_000,
  });

  const seen = clickCount > 0;

  const handleCopy = () => {
    navigator.clipboard.writeText(shortUrl);
    toast.success('Short link copied');
  };

  return (
    <Card className="border-brand-purple/30 bg-gradient-to-br from-brand-purple/5 to-brand-teal/5">
      <div className="flex items-center gap-2 mb-5">
        <div className="h-9 w-9 rounded-lg bg-brand-purple/10 flex items-center justify-center">
          <Sparkles className="h-5 w-5 text-brand-purple" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-slate-900">Your link is ready</h3>
          <p className="text-xs text-slate-500">Share it anywhere. Watch the opens roll in.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-5 items-start">
        {/* Short URL + tracking */}
        <div className="min-w-0 space-y-4">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
              Short link
            </p>
            <div className="flex items-stretch gap-2">
              <div className="flex-1 min-w-0 rounded-lg border border-slate-200 bg-white px-4 py-3 font-mono text-base sm:text-lg font-semibold text-brand-purple break-all">
                {shortUrl}
              </div>
              <Button
                onClick={handleCopy}
                leftIcon={<Copy className="h-4 w-4" />}
                className="flex-shrink-0"
              >
                Copy
              </Button>
            </div>
          </div>

          {/* Live tracking state */}
          {linkId ? (
            <div
              className={`flex items-center justify-between gap-3 rounded-lg border p-3 ${
                seen
                  ? 'border-green-200 bg-green-50'
                  : 'border-slate-200 bg-white'
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
                      ? `${clickCount.toLocaleString()} ${clickCount === 1 ? 'open' : 'opens'} so far`
                      : 'Live, updates the moment it is opened'}
                  </p>
                </div>
              </div>
              <Link to={`/analytics/link/${linkId}`} className="flex-shrink-0">
                <Button variant="outline" size="sm" leftIcon={<BarChart3 className="h-4 w-4" />}>
                  View analytics
                </Button>
              </Link>
            </div>
          ) : (
            <div className="rounded-lg border border-brand-purple/20 bg-white p-3">
              <p className="text-sm text-slate-700">
                Sign in to track opens and see who viewed this link, with live read receipts.
              </p>
            </div>
          )}
        </div>

        {/* QR code + download */}
        <div className="flex flex-col items-center gap-2">
          <QrCode value={shortUrl} size={150} />
          <QrDownloadButton value={shortUrl} />
        </div>
      </div>
    </Card>
  );
}

export function HomePage() {
  const { isSignedIn } = useAuth();
  const isAuthenticated = !!isSignedIn;
  const queryClient = useQueryClient();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<GeneratorMode>('single');
  const [primaryMode, setPrimaryMode] = useState<'link' | 'file'>('link');
  const [showUtm, setShowUtm] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
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
  const [lastUtmUrl, setLastUtmUrl] = useState('');
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

  // Generate the short, trackable link. When signed in this hits the API so we
  // get a redirect URL + link id (and the result card can poll opens); guests
  // get the client-side UTM URL. Either way we surface the result card and
  // copy the most useful URL to the clipboard.
  const handleGenerate = async () => {
    if (!finalUrl) {
      toast.error('Please enter a valid URL');
      return;
    }

    setIsGenerating(true);
    let response: GenerateLinkResponse | null = null;

    if (isAuthenticated) {
      try {
        response = await utmApi.generateLink({
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
        // Bump the projects cache so the per-project counts on the Generator +
        // Analytics pages reflect the new link immediately rather than waiting
        // for react-query's 5-minute staleTime.
        queryClient.invalidateQueries({ queryKey: ['projects'] });
      } catch {
        // Non-blocking: fall back to a client-side UTM-only result below.
      }
    }

    // Guests (or a failed API call) still get a result built from the UTM URL.
    if (!response) {
      response = {
        original_url: baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl,
        tracked_url: finalUrl,
        redirect_url: null,
        short_code: null,
        utm_params: {},
        link_id: null,
      };
    }

    const shortUrl = response.redirect_url || finalUrl;
    setLastGenerateResponse(response);
    setLastUtmUrl(finalUrl);
    navigator.clipboard.writeText(shortUrl).catch(() => undefined);
    toast.success(response.redirect_url ? 'Short link ready and copied' : 'Link ready and copied');

    addHistoryEntry({
      url: finalUrl,
      redirectUrl: response.redirect_url || undefined,
      linkId: response.link_id || undefined,
      generatedAt: new Date().toISOString(),
    });
    setIsGenerating(false);
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

  // Whether any UTM/preset/domain field carries a value, so we can hint that
  // collapsed campaign tags are in effect.
  const hasUtmValues = !!(utmSource || utmMedium || utmCampaign || utmTerm || utmContent || selectedPresetId);

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      {/* Marketing hero + value props for signed-out visitors, above the live generator. */}
      {!isAuthenticated && <GuestMarketing />}

      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">
            {primaryMode === 'file'
              ? 'Share & track files'
              : mode === 'bulk'
                ? 'Bulk import links'
                : 'Shorten & track a link'}
          </h1>
          <p className="text-slate-600 mt-1">
            {primaryMode === 'file'
              ? 'Drop a file and see the moment it is opened, no account needed.'
              : mode === 'bulk'
                ? 'Upload a CSV to generate many tracked short links at once.'
                : 'Paste a link to get a short, trackable URL plus a QR code, then see if it was opened.'}
          </p>
        </div>
        {/* Primary control: a clean two-option Link / File toggle. */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden">
          <button
            onClick={() => { setPrimaryMode('link'); setMode('single'); }}
            className={`flex items-center gap-1.5 px-5 py-2 text-sm font-medium transition-colors ${
              primaryMode === 'link'
                ? 'bg-brand-purple text-white'
                : 'bg-white text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Link2 className="h-4 w-4" />
            Link
          </button>
          <button
            onClick={() => setPrimaryMode('file')}
            className={`flex items-center gap-1.5 px-5 py-2 text-sm font-medium border-l border-slate-200 transition-colors ${
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

      {/* Bulk CSV mode: same container + two-column layout as the Link tab. */}
      {primaryMode === 'link' && mode === 'bulk' && isAuthenticated && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 space-y-6">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <button
                onClick={() => setMode('single')}
                className="text-sm text-brand-purple hover:underline inline-flex items-center gap-1"
              >
                <Link2 className="h-3.5 w-3.5" />
                Back to single link
              </button>
            </div>
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
            <div className="space-y-5">
              {/* One prominent URL input + primary action. */}
              <div>
                <label htmlFor="paste-url" className="block text-sm font-medium text-slate-700 mb-1.5">
                  Paste your link
                </label>
                <div className="flex flex-col sm:flex-row gap-2">
                  <Input
                    id="paste-url"
                    placeholder="Paste a link to shorten and track"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && finalUrl && !isGenerating) handleGenerate();
                    }}
                    className="h-12 text-base"
                  />
                  <Button
                    onClick={handleGenerate}
                    disabled={!finalUrl}
                    isLoading={isGenerating}
                    leftIcon={!isGenerating ? <Zap className="h-4 w-4" /> : undefined}
                    size="lg"
                    className="flex-shrink-0 sm:w-auto"
                  >
                    Shorten and track
                  </Button>
                </div>
              </div>

              {/* Collapsed, optional UTM + preset/domain disclosure. */}
              <div className="rounded-lg border border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowUtm((v) => !v)}
                  className="flex w-full items-center justify-between px-4 py-3 text-left"
                  aria-expanded={showUtm}
                >
                  <span className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    Add campaign tags (UTM), optional
                    {hasUtmValues && (
                      <Badge variant="info" size="sm">Added</Badge>
                    )}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 text-slate-400 transition-transform ${showUtm ? 'rotate-180' : ''}`}
                  />
                </button>

                {showUtm && (
                  <div className="border-t border-slate-200 p-4 space-y-4">
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

                    {/* Live preview of the tagged URL so power users can confirm it. */}
                    {finalUrl && (
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3">
                        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                          Tagged URL preview
                        </p>
                        <p className="text-xs break-all font-mono text-slate-600">{finalUrl}</p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Bulk import: de-emphasized secondary link, signed-in only. */}
              {isAuthenticated && (
                <div className="text-center">
                  <button
                    onClick={() => setMode('bulk')}
                    className="text-sm text-slate-500 hover:text-brand-purple inline-flex items-center gap-1.5"
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" />
                    Bulk import a CSV
                  </button>
                </div>
              )}
            </div>
          </Card>

          {/* The result card is the centerpiece, shown once a link is generated. */}
          {lastGenerateResponse && (
            <LinkResultCard response={lastGenerateResponse} utmUrl={lastUtmUrl} />
          )}

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
                {history.map((item, i) => {
                  const shareUrl = item.redirectUrl || item.url;
                  return (
                    <div key={i} className="px-6 py-3 hover:bg-slate-50 transition-colors">
                      <p
                        className="text-xs text-brand-purple font-mono break-all line-clamp-1 mb-2"
                        title={shareUrl}
                      >
                        {shareUrl}
                      </p>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-slate-400 flex-shrink-0">
                          {new Date(item.generatedAt).toLocaleDateString()}
                        </span>
                        <div className="flex items-center gap-0.5">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => {
                              navigator.clipboard.writeText(shareUrl);
                              toast.success('Copied');
                            }}
                            title="Copy link"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <QrButton value={shareUrl} />
                          {item.linkId && (
                            <Link to={`/analytics/link/${item.linkId}`} title="View analytics">
                              <Button variant="ghost" size="sm" className="h-7 px-2 text-brand-purple">
                                <BarChart3 className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
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
                    <div key={f.id} className="px-6 py-3">
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-sm text-slate-700 truncate" title={f.filename}>
                          {f.filename}
                        </span>
                        <span className="text-xs text-slate-500 flex items-center gap-1 flex-shrink-0">
                          <Eye className="h-3 w-3" />
                          {f.view_count}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <p
                          className="text-[11px] text-brand-purple font-mono break-all line-clamp-1"
                          title={f.serve_url}
                        >
                          {f.serve_url}
                        </p>
                        <div className="flex items-center gap-0.5 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2"
                            onClick={() => {
                              navigator.clipboard.writeText(f.serve_url);
                              toast.success('Copied');
                            }}
                            title="Copy link"
                          >
                            <Copy className="h-3.5 w-3.5" />
                          </Button>
                          <QrButton value={f.serve_url} filename={`${f.short_code}.svg`} />
                          <Link to={`/files/${f.id}/analytics`} title="View analytics">
                            <Button variant="ghost" size="sm" className="h-7 px-2 text-brand-purple">
                              <BarChart3 className="h-3.5 w-3.5" />
                            </Button>
                          </Link>
                        </div>
                      </div>
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
