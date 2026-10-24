import { lazy, Suspense, useCallback, useEffect, useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Button, QrButton } from './ui';
import { filesApi } from '../api/files';
import { pagesApi } from '../api/pages';
import { useOrgContext } from '../hooks/useOrgContext';
import { apiErrorDetail } from '../api/_shared';
import { invalidateAssets } from '../lib/assetCache';
import { PAGE_CAP_MB, UPLOAD_CAPS_MB, UPLOAD_HINT } from '../config/uploadLimits';
import { formatBytes } from '../lib/format';

const ComposerInput = lazy(() => import('./ComposerControls').then((module) => ({ default: module.ComposerInput })));
const IntentControl = lazy(() => import('./ComposerControls').then((module) => ({ default: module.IntentControl })));
const KINDS: Record<string, keyof typeof UPLOAD_CAPS_MB> = { 'text/html': 'html', 'application/pdf': 'pdf', 'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image', 'video/mp4': 'video', 'video/webm': 'video' };

export function ShareComposer() {
  const { profile, canShare, isSignedIn, isLoading, error: profileError } = useOrgContext();
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState('');
  const [intent, setIntent] = useState<'download' | 'host'>('download');
  const [chosenDomain, setChosenDomain] = useState<string | null>(null);
  const [editedSlug, setEditedSlug] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ url: string; kind: string; id: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const headingId = useId();

  const domain = chosenDomain ?? profile?.share_host.default_domain_id ?? '';
  const html = !file && /^\s*(<!doctype\s+html|<html[\s>])/i.test(text);
  const canHost = html || !!file && !!KINDS[file.type];
  const filename = file?.name ?? 'page.html';
  const suggestion = useQuery({
    queryKey: ['slug-suggestion', profile?.org?.id, profile?.user_id, filename, domain],
    queryFn: () => pagesApi.suggestSlug(filename, domain || undefined),
    enabled: intent === 'host' && canHost && canShare,
    retry: false,
  });
  const slug = editedSlug ?? suggestion.data?.slug ?? '';
  const host = domain ? profile?.available_hosts.find((h) => h.id === domain)?.hostname : profile?.share_host.default;
  const validHost = !!host && !/[\s/:?#]/.test(host);
  const size = file?.size ?? new Blob([text]).size;
  const htmlHostTooLarge = intent === 'host' && (html || file?.type === 'text/html') && size > PAGE_CAP_MB * 1024 * 1024;
  let externalUrl = '';
  try { const url = new URL(text.trim()); if (['http:', 'https:'].includes(url.protocol)) externalUrl = url.href; } catch { /* A paste may be HTML instead. */ }

  const reset = useCallback(() => {
    setIntent('download'); setEditedSlug(null); setEditing(false); setError(''); setResult(null); setCopied(false);
  }, []);
  const selectFiles = useCallback((files: FileList | File[]) => {
    if (files.length !== 1) { setError('Choose one file at a time. Your current input has not changed.'); return; }
    const next = files[0];
    if (!next) return;
    const cap = UPLOAD_CAPS_MB[KINDS[next.type] ?? 'other'];
    if (!next.size || next.size > cap * 1024 * 1024) { setError(!next.size ? 'This file is empty. Choose a file with content.' : `This file exceeds the ${cap} MB limit. Choose a smaller file.`); return; }
    reset(); setFile(next); setText('');
  }, [reset]);
  const changeText = useCallback((value: string) => { reset(); setText(value); setFile(null); }, [reset]);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (busy || !canShare || event.defaultPrevented || !event.clipboardData) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, [contenteditable=true]')) return;
      if (event.clipboardData.files.length) { event.preventDefault(); selectFiles(event.clipboardData.files); }
      else if (event.clipboardData.getData('text/plain')) { event.preventDefault(); changeText(event.clipboardData.getData('text/plain')); }
    };
    document.addEventListener('paste', paste);
    return () => document.removeEventListener('paste', paste);
  }, [busy, canShare, selectFiles, changeText]);

  async function publish() {
    if (!canShare || busy || !validHost || htmlHostTooLarge || (!file && !html)) return;
    setBusy(true); setError(''); setResult(null); setCopied(false); setProgress(0);
    try {
      if (intent === 'host' && (html || file?.type === 'text/html')) {
        const created = await pagesApi.create({ html: file ? await file.text() : text, title: filename.replace(/\.[^.]+$/, ''), slug, domain_id: domain || undefined });
        setResult({ url: created.public_url ?? created.url, kind: 'page', id: created.page_id });
      } else {
        const source = file ?? new File([text], 'page.html', { type: 'text/html' });
        const upload = await filesApi.initUpload({ filename: source.name, content_type: source.type || 'application/octet-stream', size_bytes: source.size, intent, slug: intent === 'host' ? slug : undefined, domain_id: domain || undefined });
        await filesApi.uploadBytes(upload.presigned_put_url, source, upload.headers, upload.upload_via_backend, setProgress);
        const asset = await filesApi.finalize(upload.file_id, upload.owner_token);
        setResult({ url: asset.public_url ?? asset.serve_url, kind: asset.output_kind ?? 'file', id: asset.id });
      }
      await invalidateAssets(client);
    } catch (err) { setError((apiErrorDetail(err) ?? 'Could not publish. Your input is still here. Try again.').replace(/[\u2013\u2014]/g, '-')); }
    finally { setBusy(false); }
  }

  if (!isSignedIn) return <section className="cb-panel"><h2>Share with ChampBeam</h2><p>Sign in to host a page, send a file or track a link.</p><Link to="/sign-in">Sign in</Link></section>;
  if (isLoading) return <p role="status">Loading workspace permissions…</p>;
  if (profileError) return <p role="alert">Workspace access could not be verified. Reload or sign in again. No content was uploaded.</p>;
  if (!canShare) return <section className="cb-panel"><h2>Read-only workspace</h2><p>Your current permissions allow reporting, not creating shares.</p><Link to="/team">Open reporting</Link></section>;

  return <section className="cb-panel cb-composer" aria-labelledby={headingId}>
    <h2 id={headingId}>Drop a file or paste a link</h2>
    <p>Send a download or host a page. Nothing publishes until you confirm.</p>
    <fieldset disabled={busy}>
      <Suspense fallback={<p role="status">Loading composer…</p>}>
        <ComposerInput text={text} onText={changeText} onFiles={selectFiles} busy={busy}
          received={file && <div className="cb-received"><p role="status"><strong>{file.name}</strong><span>{file.type || 'File'} · {formatBytes(file.size)}</span></p><button type="button" onClick={() => { reset(); setFile(null); setText(''); }}>Remove file</button></div>} />
      </Suspense>
      <p className="cb-help">{UPLOAD_HINT}</p>
      {externalUrl ? <div className="cb-actions"><Link className="cb-action" to={`/links?tab=utm&url=${encodeURIComponent(externalUrl)}`}>Track external URL</Link><p>Creates a redirect, not a hosted copy.</p></div> : (file || html) ? <>
        <Suspense fallback={<p role="status">Loading recipient options…</p>}><IntentControl value={intent} canHost={canHost} onChange={(next) => { setIntent(next); setError(''); setResult(null); }} /></Suspense>
        {intent === 'host' && <div className="cb-host-preview"><p className="cb-address">{validHost ? `https://${host}/${slug}` : 'No active share domain available.'}</p><button type="button" aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? 'Close address editor' : 'Edit address'}</button></div>}
        <div className="cb-form-grid">
          <label>Share domain<select aria-label="Share domain" aria-invalid={!validHost} aria-describedby={!validHost ? `${headingId}-domain-error` : undefined} value={domain} onChange={(event) => { setChosenDomain(event.target.value); setEditedSlug(null); setResult(null); setCopied(false); setError(''); }}>
            {domain && !host && <option value={domain} disabled>Unavailable domain</option>}
            {!profile?.share_host.default_domain_id && <option value="">{profile?.share_host.default ?? 'Domain unavailable'}</option>}
            {profile?.available_hosts.map((item) => <option value={item.id} key={item.id}>{item.hostname}</option>)}
          </select>{profile?.available_hosts.find((item) => item.id === domain)?.org_default && <span className="cb-help">Workspace default</span>}</label>
          {intent === 'host' && editing && <label>Page address<input aria-label="Page address" aria-describedby={`${headingId}-slug-help`} value={slug} onChange={(event) => setEditedSlug(event.target.value)} required />
            <span id={`${headingId}-slug-help`} className="cb-help">Use 3 to 60 letters a to z, numbers or hyphens. Unicode filenames are converted by the server. Availability is confirmed when publishing.</span>
          </label>}
        </div>
        {!validHost && <p id={`${headingId}-domain-error`} role="alert">The selected share domain is unavailable or invalid. Choose an active domain or ask your workspace admin to configure one.</p>}
        {intent === 'host' && <>
          {suggestion.isFetching && <p role="status">Checking suggested address…</p>}
          {suggestion.data?.collided && <p role="status">The filename address is taken. Suggested: {suggestion.data.slug}. <button type="button" onClick={() => setEditedSlug(suggestion.data.slug)}>Use suggested address</button></p>}
          {suggestion.error && <p role="alert">Could not check this domain or address. Choose an active domain. <button type="button" onClick={() => void suggestion.refetch()}>Retry address check</button></p>}
          {htmlHostTooLarge && <p role="alert">Hosted HTML is limited to {PAGE_CAP_MB} MB. Reduce the document or send it as a file.</p>}
        </>}
        {!result && <Button onClick={() => void publish()} disabled={busy || !validHost || htmlHostTooLarge || (intent === 'host' && (!slug.trim() || suggestion.isFetching || !!suggestion.error))}>{intent === 'host' ? 'Publish page' : 'Create download link'}</Button>}
      </> : text && <p role="status">Paste an http(s) URL or a complete HTML document, or choose a file.</p>}
    </fieldset>
    {busy && <p role="status">Uploading and publishing{progress ? `: ${progress}%` : '…'}</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div className="cb-result" role="status"><h3>{result.kind === 'page' ? 'Page published' : 'Download ready'}</h3><a href={result.url} target="_blank" rel="noreferrer">{result.url}</a><div className="cb-actions"><Button onClick={() => { void (async () => { try { await navigator.clipboard.writeText(result.url); setCopied(true); setError(''); } catch { setError('Clipboard unavailable. Select the address above and copy it manually.'); } })(); }}>{copied ? 'Address copied' : 'Copy address'}</Button><QrButton value={result.url} withLabel /><Link to={result.kind === 'page' ? '/pages' : '/files'}>Open {result.kind === 'page' ? 'Pages' : 'Files'}</Link><Link to={`/${result.kind === 'page' ? 'pages' : 'files'}/${result.id}/analytics`}>View analytics</Link></div></div>}
  </section>;
}
