import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { assistantApi, type GeneratePageDraft } from '../api/assistant';
import { apiErrorDetail } from '../api/_shared';
import './composer.css';
import Prompt from './kokonutui/ai-prompt';
import { Button, Card, Input, QrButton, useConfirm } from './ui';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './ui/dropdown-menu';

const brands = [{ id: 'champions-group', name: 'Champions Group' }] as const;

export function DraftPagePanel({ onCopy, onPublished }: { onCopy: (url: string) => void; onPublished: () => void }) {
  const confirm = useConfirm();
  const [company, setCompany] = useState('');
  const [brief, setBrief] = useState('');
  const [cta, setCta] = useState('');
  const [slug, setSlug] = useState('');
  const [brand, setBrand] = useState<(typeof brands)[number]>(brands[0]);
  const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
  const [draft, setDraft] = useState<GeneratePageDraft | null>(null);
  const [published, setPublished] = useState('');
  const [error, setError] = useState('');
  const [phone, setPhone] = useState(false);
  const badUrl = !!cta && !(cta.startsWith('https://') && URL.canParse(cta));
  const valid = company.trim() && brief.trim().length >= 20 && !badUrl;
  const input = { company: company.trim(), brief: brief.trim(), brand: brand.id, cta_url: cta || undefined, slug: slug.trim() || undefined };

  function resetOutput() { setDraft(null); setError(''); setPublished(''); }
  async function preview() {
    if (!valid || busy) return;
    resetOutput(); setBusy('preview');
    try {
      const result = await assistantApi.generatePage({ ...input, dry_run: true });
      if (!('html' in result)) throw new Error('Draft preview unavailable.');
      setDraft(result);
    } catch (err) { setError(apiErrorDetail(err) ?? 'Could not preview the draft.'); }
    finally { setBusy(null); }
  }
  async function publish() {
    if (!draft || busy || !await confirm({ title: 'Publish one-pager', message: `Publish a public page for ${input.company}? Anyone with the link can open it.`, confirmLabel: 'Publish', destructive: false })) return;
    setBusy('publish'); setError('');
    try {
      const result = await assistantApi.generatePage({ ...input, dry_run: false });
      if (!('url' in result)) throw new Error('No published link was returned.');
      setPublished(result.url); setDraft(null); onPublished();
    } catch (err) { setError(apiErrorDetail(err) ?? 'Could not publish the draft.'); }
    finally { setBusy(null); }
  }
  return <section aria-label="Draft a one-pager" className="space-y-4 mb-6 [&_button]:min-h-11 [&_input]:min-h-11 [&_input]:text-base">
    <Card>
      <h2 className="text-xl font-semibold">One-pager brief</h2>
      <p className="mb-5 text-cb-text">Start with the conversation. Preview the page before you publish it.</p>
      <fieldset disabled={!!busy} className="min-w-0 space-y-4" onChange={resetOutput}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Company" id="draft-company" required maxLength={120} value={company} onChange={e => setCompany(e.target.value)} />
          <div><span className="block mb-1.5 text-sm font-medium">Brand</span><DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" aria-label={`Brand: ${brand.name}`}>{brand.name}<ChevronDown size={16} /></Button></DropdownMenuTrigger>
            <DropdownMenuContent>{brands.map(b => <DropdownMenuItem key={b.id} onSelect={() => { if (b !== brand) resetOutput(); setBrand(b); }}>{b.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
        </div>
        <Prompt noModelControls headerText="" inputLabel="Brief" commands={[]} placeholder="Their pain, what they asked for, what we offer." value={brief} onChange={v => setBrief(v.slice(0, 2000))} className="cb-composer-prompt max-w-none rounded-lg border border-cb-icon bg-surface px-3 py-2 focus-within:ring-2" />
        <div className="flex justify-between text-sm text-cb-text"><span>At least 20 characters</span><span>{brief.length} / 2000</span></div>
        {error && <p role="alert">{error}</p>}
        <Input label="CTA URL (optional)" id="draft-url" type="url" maxLength={500} value={cta} error={badUrl ? 'Must start with https:// and include a hostname.' : undefined} onChange={e => setCta(e.target.value)} />
        <details><summary className="cursor-pointer py-3">Advanced</summary><Input label="Slug (optional)" id="draft-slug" value={slug} onChange={e => setSlug(e.target.value)} /></details>
        <Button disabled={!valid || !!busy} onClick={preview} isLoading={busy === 'preview'}>{busy === 'preview' ? 'Previewing…' : 'Preview'}</Button>
      </fieldset>
    </Card>
    {draft && <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold">Draft preview</h3><p className="text-sm text-cb-text">{draft.model} · {draft.checks.bytes} bytes</p></div>
        <div className="flex gap-2">{['Desktop', 'Phone'].map((label, i) => <Button key={label} variant={phone === !!i ? 'primary' : 'outline'} aria-pressed={phone === !!i} onClick={() => setPhone(!!i)}>{label}</Button>)}</div></div>
      <iframe title="One-pager preview" sandbox="" srcDoc={draft.html} className="mx-auto block max-w-full border" style={{ width: phone ? 375 : '100%', height: 720 }} />
      <div><Button onClick={publish} isLoading={busy === 'publish'}>{busy === 'publish' ? 'Publishing…' : 'Publish'}</Button><p className="mt-2 text-sm text-cb-text">Publishing writes a fresh draft from the same brief.</p></div>
    </Card>}
    {published && <Card><h3 role="status" className="text-lg font-semibold">One-pager published</h3><a href={published} className="inline-flex min-h-11 items-center break-all underline">{published}</a><div className="mt-3 flex items-center gap-2"><Button variant="outline" onClick={() => onCopy(published)}>Copy link</Button><QrButton value={published} filename="one-pager.svg" /></div></Card>}
  </section>;
}
