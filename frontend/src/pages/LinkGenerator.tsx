import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { Button, Input } from '../components/ui';
import { utmApi } from '../api/utm';
import { apiErrorDetail } from '../api/_shared';
import { useOrgContext } from '../hooks/useOrgContext';

export function LinkGenerator() {
  const [params] = useSearchParams();
  const client = useQueryClient();
  const { profile, canShare } = useOrgContext();
  const [url, setUrl] = useState(params.get('url') ?? '');
  const [preset, setPreset] = useState('');
  const [domain, setDomain] = useState<string | null>(null);
  const [project, setProject] = useState(params.get('project') ?? '');
  const [alias, setAlias] = useState('');
  const [tags, setTags] = useState({ utm_source: '', utm_medium: '', utm_campaign: '', utm_term: '', utm_content: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const { data: presets = [] } = useQuery({ queryKey: ['utm', 'presets'], queryFn: () => utmApi.getPresets(), enabled: canShare });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: () => utmApi.getProjects(), enabled: canShare });

  async function generate() {
    setError(''); setResult('');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    } catch { setError('Enter a full http(s) URL.'); return; }
    setBusy(true);
    try {
      const response = await utmApi.generateLink({ base_url: url, ...tags, preset_id: preset || undefined, domain_id: (domain ?? profile?.share_host.default_domain_id) || undefined, project_id: project || undefined, alias: alias || undefined });
      if (!response.redirect_url) throw new Error('No tracked URL returned');
      setResult(response.redirect_url);
      await client.invalidateQueries({ queryKey: ['utm', 'links'] });
      await client.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) { setError(apiErrorDetail(err) ?? 'Could not create a tracked link. Your input is unchanged.'); }
    finally { setBusy(false); }
  }

  async function csv(file?: File) {
    setBusy(true); setError('');
    try {
      const blob = file ? await utmApi.processBulkCSV(file, preset || undefined) : await utmApi.downloadTemplate();
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement('a'); anchor.href = href; anchor.download = file ? 'utm_links.csv' : 'utm_template.csv'; anchor.click(); URL.revokeObjectURL(href);
      if (file) await client.invalidateQueries({ queryKey: ['utm', 'links'] });
    } catch (err) { setError(apiErrorDetail(err) ?? 'CSV request failed. Check that the file has a url column and try again.'); }
    finally { setBusy(false); }
  }

  if (!canShare) return <p>Link creation is unavailable with your current workspace permissions.</p>;
  return <section className="cb-panel"><h2>Create a tracked link</h2><p>Creates a redirect. It does not host a copy or send an email.</p>
    <form onSubmit={(event) => { event.preventDefault(); void generate(); }}><fieldset disabled={busy}>
      <Input label="External URL" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://" type="url" required />
      <div className="cb-form-grid"><label>Preset<select value={preset} onChange={(event) => {
        setPreset(event.target.value); const selected = presets.find((p) => p.id === event.target.value);
        if (selected) setTags({ utm_source: selected.utm_source ?? '', utm_medium: selected.utm_medium ?? '', utm_campaign: selected.utm_campaign ?? '', utm_term: selected.utm_term ?? '', utm_content: selected.utm_content ?? '' });
      }}><option value="">No preset</option>{presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <label className="col-span-full">Share domain<select value={domain ?? profile?.share_host.default_domain_id ?? ''} onChange={(event) => setDomain(event.target.value)}><option value="">{profile?.share_host.default}</option>{profile?.available_hosts.map((h) => <option key={h.id} value={h.id}>{h.hostname}</option>)}</select></label>
      <label>Project<select value={project} onChange={(event) => setProject(event.target.value)}><option value="">Unfiled</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      <Input label="Link name (optional)" value={alias} onChange={(event) => setAlias(event.target.value)} />
      {Object.entries(tags).map(([key, value]) => <Input key={key} label={key} value={value} onChange={(event) => setTags({ ...tags, [key]: event.target.value })} />)}</div>
      <Button type="submit">Create tracked link</Button>
    </fieldset></form>
    <details><summary>Bulk CSV</summary><p>Requires a url column. Preset values are defaults; CSV values override them.</p><div className="cb-actions"><Button disabled={busy} onClick={() => void csv()}>Download template</Button><label className="cb-file-picker">Import CSV<input type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void csv(file); event.target.value = ''; }} /></label></div></details>
    {busy && <p role="status">Processing links…</p>}{error && <p role="alert">{error}</p>}
    {result && <div className="cb-result" role="status"><a href={result} target="_blank" rel="noreferrer">{result}</a><Button onClick={() => { void navigator.clipboard.writeText(result).catch(() => setError('Clipboard unavailable. Select and copy the address manually.')); }}>Copy link</Button></div>}
  </section>;
}
