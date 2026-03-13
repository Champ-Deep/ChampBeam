import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Clock, UserPlus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, CardHeader, CardTitle, Button, Input } from '../components/ui';
import { utmApi } from '../api/utm';
import type { UTMPreset } from '../api/utm';

const STORAGE_KEY = 'champutm_link_history';

interface HistoryItem {
  url: string;
  generatedAt: string;
}

interface HomePageProps {
  isAuthenticated: boolean;
}

export function HomePage({ isAuthenticated }: HomePageProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [utmSource, setUtmSource] = useState('');
  const [utmMedium, setUtmMedium] = useState('');
  const [utmCampaign, setUtmCampaign] = useState('');
  const [utmContent, setUtmContent] = useState('');
  const [utmTerm, setUtmTerm] = useState('');
  const [selectedPresetId, setSelectedPresetId] = useState('');
  const [projectName, setProjectName] = useState('');
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Fetch presets only if authenticated
  const { data: presets = [] } = useQuery<UTMPreset[]>({
    queryKey: ['utm', 'presets'],
    queryFn: () => utmApi.getPresets(),
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

    navigator.clipboard.writeText(finalUrl);
    toast.success('URL copied to clipboard');

    // If authenticated, also track the link via API
    if (isAuthenticated) {
      try {
        await utmApi.generateLink({
          base_url: baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl,
          utm_source: utmSource || undefined,
          utm_medium: utmMedium || undefined,
          utm_campaign: utmCampaign || undefined,
          utm_content: utmContent || undefined,
          utm_term: utmTerm || undefined,
          project_name: projectName || undefined,
          preset_id: selectedPresetId || undefined,
        });
      } catch {
        // Non-blocking — link is already copied
      }
    }

    // Save to localStorage history
    const newHistory = [
      { url: finalUrl, generatedAt: new Date().toISOString() },
      ...history.filter((h) => h.url !== finalUrl),
    ].slice(0, 10);
    setHistory(newHistory);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
  };

  return (
    <div className="max-w-6xl mx-auto py-8 px-4">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-slate-900">UTM Link Generator</h1>
        <p className="text-slate-600 mt-1">
          Create trackable UTM-tagged URLs for your marketing campaigns.
        </p>
      </div>

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

              {/* Preset selector (auth only) */}
              {isAuthenticated && presets.length > 0 && (
                <div className="flex items-center gap-4">
                  <div className="flex-1">
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
                  <div className="flex-1">
                    <Input
                      label="Project Name (optional)"
                      placeholder="e.g. Q1 Launch"
                      value={projectName}
                      onChange={(e) => setProjectName(e.target.value)}
                    />
                  </div>
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
                <Link to="/register">
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
                    <p
                      className="text-xs text-brand-purple font-mono break-all line-clamp-2 mb-2"
                      title={item.url}
                    >
                      {item.url}
                    </p>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-slate-400">
                        {new Date(item.generatedAt).toLocaleString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => {
                          navigator.clipboard.writeText(item.url);
                          toast.success('Copied');
                        }}
                      >
                        Copy
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
