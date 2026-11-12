import { Link } from 'react-router-dom';
import { ArrowUpRight, FileText, Globe, Link2, RotateCw } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useAuth } from '../lib/authClient';
import { ShareComposer } from '../components/ShareComposer';
import { useShareLists } from '../hooks/useShareLists';
import { PageHeader } from '../components/ui/PageHeader';
import { Skeleton } from '../components/ui/skeleton';
import { formatRelative } from '../lib/format';

interface Row { id: string; title: string; sub: string; when: string | null | undefined }
interface Recent { name: string; path: string; icon: LucideIcon; count?: number; isLoading: boolean; error: unknown; refetch: () => unknown; rows?: Row[] }

export function HomePage() {
  const { isSignedIn } = useAuth();
  const { files, pages, links } = useShareLists(!!isSignedIn);
  const recent: Recent[] = [
    { name: 'Pages', path: '/pages', icon: Globe, count: pages.data?.length, isLoading: pages.isLoading, error: pages.error, refetch: pages.refetch,
      rows: pages.data?.slice(0, 3).map((p) => ({ id: p.page_id, title: p.title || p.slug || 'Untitled page', sub: p.public_url || p.url, when: p.updated_at })) },
    { name: 'Files', path: '/files', icon: FileText, count: files.data?.length, isLoading: files.isLoading, error: files.error, refetch: files.refetch,
      rows: files.data?.slice(0, 3).map((f) => ({ id: f.id, title: f.filename, sub: f.public_url || f.serve_url, when: f.created_at })) },
    { name: 'Links', path: '/links', icon: Link2, count: links.data?.length, isLoading: links.isLoading, error: links.error, refetch: links.refetch,
      rows: links.data?.slice(0, 3).map((l) => ({ id: l.link_id, title: hostOf(l.original_url), sub: l.original_url, when: l.created_at })) },
  ];
  return <div className="cb-workspace">
    <PageHeader title="Share" lede="Files to download. Pages to view. Links to track." />
    <ShareComposer />
    {isSignedIn && <section aria-labelledby="recent-heading" className="mt-10">
      <h2 id="recent-heading" className="!mb-1">Recent shares</h2>
      <p className="cb-help !mt-0 !mb-4">Links and their count use the same last-365-days view.</p>
      <div className="cb-recents">{recent.map((s) => {
        const Icon = s.icon;
        return <div key={s.name} className="cb-recent-card">
          <Link to={s.path} className="cb-recent-head">
            <span className="cb-recent-icon"><Icon aria-hidden className="size-4" /></span>
            <span className="flex-1 font-display text-[15px] font-semibold">{s.name}</span>
            {typeof s.count === 'number' && <span className="cb-count">{s.count}</span>}
            <ArrowUpRight aria-hidden className="size-4 text-cb-icon" />
          </Link>
          {s.isLoading ? <ul aria-label={`Loading ${s.name.toLowerCase()}`}>{[0, 1, 2].map((i) => <li key={i} className="cb-recent-row"><div className="w-full space-y-2"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-4/5" /></div></li>)}</ul>
            : s.error ? <div role="alert" className="cb-inline-alert">Could not load {s.name.toLowerCase()}.<button type="button" onClick={() => void s.refetch()}><RotateCw aria-hidden className="size-3.5" />Retry</button></div>
            : s.rows?.length ? <ul>{s.rows.map((row) => <li key={row.id}><Link to={s.path} className="cb-recent-row">
                <span className="min-w-0 flex-1"><span className="block truncate font-medium text-cb-ink" title={row.title}>{row.title}</span><span className="block truncate font-mono text-xs text-cb-muted" title={row.sub}>{row.sub}</span></span>
                {row.when && <span className="shrink-0 text-xs tabular-nums text-cb-muted">{formatRelative(row.when)}</span>}
              </Link></li>)}</ul>
            : <p className="cb-recent-empty">No {s.name.toLowerCase()} yet. Drop one in above.</p>}
        </div>;
      })}</div>
    </section>}
  </div>;
}

function hostOf(url: string) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
