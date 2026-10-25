import { Link } from 'react-router-dom';
import { useAuth } from '@clerk/react';
import { ShareComposer } from '../components/ShareComposer';
import { useShareLists } from '../hooks/useShareLists';

export function HomePage() {
  const { isSignedIn } = useAuth();
  const { files, pages, links } = useShareLists(!!isSignedIn);
  const recent = [
    { name: 'Pages', path: '/pages', query: pages, rows: pages.data?.slice(0, 3).map((p) => ({ id: p.page_id, title: p.title })) },
    { name: 'Files', path: '/files', query: files, rows: files.data?.slice(0, 3).map((f) => ({ id: f.id, title: f.filename })) },
    { name: 'Links', path: '/links', query: links, rows: links.data?.slice(0, 3).map((l) => ({ id: l.link_id, title: l.original_url })) },
  ];
  return <div className="cb-workspace">
    <header><h1>Share</h1><p>Files to download. Pages to view. Links to track.</p></header>
    <ShareComposer />
    {isSignedIn && <section aria-labelledby="recent-heading"><h2 id="recent-heading">Your recent shares</h2><p className="cb-help">Links and their count use the same last-365-days view.</p>
      <div className="cb-recents">{recent.map((section) => <div key={section.name}><h3><Link to={section.path}>{section.name}{section.query.data && ` (${section.query.data.length})`}</Link></h3>
        {section.query.isLoading ? <p role="status">Loading {section.name.toLowerCase()}…</p> : section.query.error ? <p role="alert">Could not load {section.name.toLowerCase()}. <button onClick={() => void section.query.refetch()}>Retry</button></p> : section.rows?.length ? <ul>{section.rows.map((row) => <li key={row.id}><Link to={section.path}>{row.title}</Link></li>)}</ul> : <p>No {section.name.toLowerCase()} in this view.</p>}
      </div>)}</div>
    </section>}
  </div>;
}
