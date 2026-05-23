import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Clock, UserPlus, Link2, FileSpreadsheet, Download } from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '@clerk/react';
import { Card, CardHeader, CardTitle, Button, Input } from '../components/ui';
import { FileUploadZone } from '../components/ui/FileUploadZone';
import { utmApi } from '../api/utm';
import type { UTMPreset, Project, GenerateLinkResponse } from '../api/utm';

type GeneratorMode = 'single' | 'bulk';

const STORAGE_KEY = 'champutm_link_history';

interface HistoryItem {
  url: string;
  redirectUrl?: string;
  linkId?: string;
  generatedAt: string;
}

export function HomePage() {
  const { isSignedIn } = useAuth();
  const isAuthenticated = !!isSignedIn;
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<GeneratorMode>('single');
  const [isProcessing, setIsProcessing] = useState(false);
  const [baseUrl, setBaseUrl] = useState('');
  const [utmSource, setUtmSource] = useState('');
  const [utmMedium, setUtmMedium] = useState('');
  const [utmCampaign, setUtmCampaign] = useState('');
  const [utmContent, setUtmContent] = useState('');
  const [utmTerm, setUtmTerm] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState(searchParams.get('project') || '');
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

  // Load history from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setHistory(JSON.parse(stored));
    } catch { /* ignore */ }
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
        });
        setLastGenerateResponse(response);
        redirectUrl = response.redirect_url || undefined;
        linkId = response.link_id || undefined;
      } catch {
        // Non-blocking — fall back to copying the UTM URL
      }
    }

    // Copy the redirect URL (trackable) if available, otherwise the UTM URL
    const urlToCopy = redirectUrl || finalUrl;
    navigator.clipboard.writeText(urlToCopy);
    toast.success(redirectUrl ? 'Trackable redirect URL copied' : 'URL copied to clipboard');

    // Save to localStorage history with redirect URL
    const newHistory = [
      { url: finalUrl, redirectUrl, linkId, generatedAt: new Date().toISOString() },
      ...history.filter((h) => h.url !== finalUrl),
    ].slice(0, 10);
    setHistory(newHistory);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
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
      <div className="mb-8 flex items-end justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-3xl font-bold text-slate-900">UTM Link Generator</h1>
          <p className="text-slate-600 mt-1">
            Create trackable UTM-tagged URLs for your marketing campaigns.
          </p>
        </div>
        {isAuthenticated && (
          <div className="flex rounded-lg border border-slate-200 overflow-hidden">
            <button
              onClick={() => setMode('single')}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
                mode === 'single'
                  ? 'bg-brand-purple text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <Link2 className="h-4 w-4" />
              Single URL
            </button>
            <button
              onClick={() => setMode('bulk')}
              className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors ${
                mode === 'bulk'
                  ? 'bg-brand-purple text-white'
                  : 'bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Bulk CSV
            </button>
          </div>
        )}
      </div>

      {/* Bulk CSV mode */}
      {mode === 'bulk' && isAuthenticated && (
        <div className="max-w-4xl space-y-6">
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
                    className="w-full max-w-md h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
                    value={selectedPresetId}
                    onChange={(e) => setSelectedPresetId(e.target.value)}
                  >
                    <option value="">-- No preset (use CSV columns) --</option>
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
              <div className="flex items-center gap-3">
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
          <Card className="bg-slate-50">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">How it works</h3>
            <ol className="text-sm text-slate-600 space-y-2 list-decimal list-inside">
              <li>Download the CSV template or prepare your own CSV with a <code className="bg-white px-1 py-0.5 rounded text-brand-purple">url</code> column.</li>
              <li>Optionally include <code className="bg-white px-1 py-0.5 rounded text-brand-purple">utm_source</code>, <code className="bg-white px-1 py-0.5 rounded text-brand-purple">utm_medium</code>, etc. columns for per-row overrides.</li>
              <li>Select a preset if you want default UTM values applied to all rows.</li>
              <li>Upload the CSV — a processed file with <code className="bg-white px-1 py-0.5 rounded text-brand-purple">tracked_url</code> column will download automatically.</li>
            </ol>
          </Card>
        </div>
      )}

      {/* Single URL mode */}
      {mode === 'single' && (
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

              {/* Project selector (auth only, always visible) */}
              {isAuthenticated && (
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
                      helperText="Optional — identify paid keywords"
                      value={utmTerm}
                      onChange={(e) => setUtmTerm(e.target.value)}
                    />
                    <Input
                      label="Campaign Content (utm_content)"
                      placeholder="e.g. logo_link, text_link"
                      helperText="Optional — differentiate ads/links"
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
                <div className="flex items-start gap-3">
                  <div className="flex-1 bg-white border border-slate-200 rounded-lg p-3 min-h-[3rem] text-sm break-all font-mono text-slate-700">
                    {finalUrl || (
                      <span className="text-slate-400 italic">
                        Enter a URL above to generate your trackable link
                      </span>
                    )}
                  </div>
                  <Button onClick={handleCopy} disabled={!finalUrl} leftIcon={<Copy className="h-4 w-4" />}>
                    Copy
                  </Button>
                </div>
                {lastGenerateResponse?.redirect_url && (
                  <div className="mt-3">
                    <h4 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">
                      Redirect URL
                    </h4>
                    <div className="flex items-start gap-3">
                      <div className="flex-1 bg-white border border-slate-200 rounded-lg p-3 text-sm break-all font-mono text-brand-purple">
                        {lastGenerateResponse.redirect_url}
                      </div>
                      <Button
                        onClick={() => {
                          navigator.clipboard.writeText(lastGenerateResponse.redirect_url!);
                          toast.success('Redirect URL copied to clipboard');
                        }}
                        leftIcon={<Copy className="h-4 w-4" />}
                      >
                        Copy Redirect URL
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* CTA for unauthenticated users */}
          {!isAuthenticated && (
            <Card className="bg-brand-purple/5 border-brand-purple/20">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 bg-brand-purple/10 rounded-lg flex items-center justify-center flex-shrink-0">
                  <UserPlus className="h-6 w-6 text-brand-purple" />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-slate-900">Unlock Advanced Features</h3>
                  <p className="text-sm text-slate-600">
                    Sign up free to save presets, track clicks, view analytics, and process bulk URLs.
                  </p>
                </div>
                <Link to="/sign-up">
                  <Button size="sm">Sign Up Free</Button>
                </Link>
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
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {item.linkId && (
                          <Link to={`/analytics/link/${item.linkId}`}>
                            <Button variant="ghost" size="sm" className="h-6 px-2">
                              Stats
                            </Button>
                          </Link>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2"
                          onClick={() => {
                            navigator.clipboard.writeText(item.redirectUrl || item.url);
                            toast.success('Copied');
                          }}
                        >
                          <Copy className="h-3 w-3 mr-1" />
                          Copy
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
      )}
    </div>
  );
}
