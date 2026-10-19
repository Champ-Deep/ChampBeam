import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, Link2, Wand2 } from 'lucide-react';
import { Button, Input } from './ui';
import { utmApi } from '../api/utm';
import type { UTMPreset } from '../api/utm';

/**
 * UTM builder in append-only mode: takes a URL (or several, one per line) and
 * returns the URL with UTM parameters appended. No short link, no tracking,
 * no API call: the result is computed in the browser so it can be pasted
 * straight into ad platforms or CRMs without an extra redirect hop.
 */
export function UtmUrlBuilder({ onClose }: { onClose: () => void }) {
  const [batch, setBatch] = useState(false);
  const [targets, setTargets] = useState('');
  const [utmSource, setUtmSource] = useState('');
  const [utmMedium, setUtmMedium] = useState('');
  const [utmCampaign, setUtmCampaign] = useState('');
  const [utmContent, setUtmContent] = useState('');
  const [utmTerm, setUtmTerm] = useState('');
  const [presetId, setPresetId] = useState('');

  const { data: presets = [] } = useQuery<UTMPreset[]>({
    queryKey: ['utm', 'presets'],
    queryFn: () => utmApi.getPresets(),
  });

  const applyParams = (url: string): string => {
    try {
      const u = new URL(url.startsWith('http') ? url : `https://${url}`);
      if (utmSource) u.searchParams.set('utm_source', utmSource);
      if (utmMedium) u.searchParams.set('utm_medium', utmMedium);
      if (utmCampaign) u.searchParams.set('utm_campaign', utmCampaign);
      if (utmContent) u.searchParams.set('utm_content', utmContent);
      if (utmTerm) u.searchParams.set('utm_term', utmTerm);
      return u.toString();
    } catch {
      return '';
    }
  };

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setUtmSource(p.utm_source ?? '');
    setUtmMedium(p.utm_medium ?? '');
    setUtmCampaign(p.utm_campaign ?? '');
    setUtmContent(p.utm_content ?? '');
    setUtmTerm(p.utm_term ?? '');
  };

  const targetsList = targets
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean);

  const singleUrl = !batch ? targets.trim() : '';
  const result = singleUrl ? applyParams(singleUrl) : '';
  const batchResults = batch
    ? targetsList.map((t) => ({ from: t, to: applyParams(t) }))
    : [];

  const hasAnything = !!(utmSource || utmMedium || utmCampaign || utmContent || utmTerm);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  const name = (label: string, value: string, set: (v: string) => void) => (
    <div>
      <label className="block text-xs font-medium text-slate-700 mb-1">{label}</label>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={label === 'Campaign' ? 'e.g. bts-2026' : ''}
        className="w-full h-9 rounded-md border border-gray-300 px-2.5 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-brand-purple/10 flex items-center justify-center">
            <Wand2 className="h-4 w-4 text-brand-purple" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Add UTM parameters to your links</h3>
            <p className="text-xs text-slate-500">
              No short link, no tracking: just tagged URLs, ready to paste.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1 text-xs">
          <button
            type="button"
            onClick={() => setBatch(false)}
            className={`rounded-md px-2.5 py-1 font-medium ${!batch ? 'bg-brand-purple/10 text-brand-purple' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Single
          </button>
          <button
            type="button"
            onClick={() => setBatch(true)}
            className={`rounded-md px-2.5 py-1 font-medium ${batch ? 'bg-brand-purple/10 text-brand-purple' : 'text-slate-500 hover:text-slate-700'}`}
          >
            Batch
          </button>
        </div>
      </div>

      {batch ? (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">URLs (one per line)</label>
          <textarea
            value={targets}
            onChange={(e) => setTargets(e.target.value)}
            rows={5}
            placeholder={'https://example.com/a\nhttps://example.com/b'}
            spellCheck={false}
            className="w-full rounded-md border border-gray-300 px-2.5 py-2 font-mono text-xs focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          />
        </div>
      ) : (
        <Input
          label="URL"
          value={targets}
          onChange={(e) => setTargets(e.target.value)}
          placeholder="https://example.com/campaign"
        />
      )}

      {presets.length > 0 && (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Preset</label>
          <select
            value={presetId}
            onChange={(e) => applyPreset(e.target.value)}
            className="w-full h-9 rounded-md border border-gray-300 bg-white px-2.5 text-sm focus:border-brand-purple focus:outline-none focus:ring-1 focus:ring-brand-purple"
          >
            <option value="">None (fill fields manually)</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {name('Source', utmSource, setUtmSource)}
        {name('Medium', utmMedium, setUtmMedium)}
        {name('Campaign', utmCampaign, setUtmCampaign)}
        {name('Content', utmContent, setUtmContent)}
        {name('Term', utmTerm, setUtmTerm)}
      </div>

      {batch ? (
        batchResults.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-700">Tagged URLs</p>
            {batchResults.map((r) => (
              <div
                key={r.from}
                className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5"
              >
                <code className="flex-1 min-w-0 font-mono text-[11px] text-slate-700 break-all">
                  {r.to || r.from}
                </code>
                {r.to && (
                  <button
                    type="button"
                    onClick={() => copy(r.to)}
                    className="text-slate-400 hover:text-brand-purple flex-shrink-0"
                    title="Copy tagged URL"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            <Button size="sm" leftIcon={<Copy className="h-3.5 w-3.5" />} disabled={batchResults.length === 0} onClick={() => copy(batchResults.map((r) => r.to || r.from).join('\n'))}>
              Copy all
            </Button>
          </div>
        )
      ) : singleUrl ? (
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-700">Tagged URL</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-2 font-mono text-xs text-slate-800 break-all">
              {result || singleUrl}
            </code>
            <Button size="sm" leftIcon={<Copy className="h-3.5 w-3.5" />} disabled={!result} onClick={() => copy(result)}>
              Copy
            </Button>
          </div>
          {!hasAnything && (
            <p className="text-xs text-slate-500 flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              Add at least one parameter to see a tagged URL.
            </p>
          )}
        </div>
      ) : null}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}