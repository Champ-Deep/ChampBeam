import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Zap, Link2, FileText, Globe, Library, Users, BarChart3, Settings, Radio,
  Bell, Menu, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../lib/authClient';
import { AccountFooter } from '../AccountFooter';
import { AssistantLauncher } from '../AssistantDrawer';
import { useShareLists } from '../../hooks/useShareLists';
import { Logo } from '../ui/Logo';
import { useClickNotifications } from '../../hooks/useClickNotifications';
import { useOrgContext } from '../../hooks/useOrgContext';
import { champvaultApi } from '../../api/champvault';


interface NavItem {
  to: string;
  label: string;
  icon: typeof Link2;
  end?: boolean;
  requiresOrg?: 'member' | 'team';
  requiresVault?: boolean;
  count?: number;
}

// Icon-in-a-rail nav row, styled for the dark sidebar. Active state mirrors
// App v2: faint white fill + an accent-light inset bar on the leading edge.
function NavRow({ item, active, onClick }: { item: NavItem; active: boolean; onClick?: () => void }) {
  const Icon = item.icon;
  return (
    <Link
      to={item.to}
      onClick={onClick}
      className={clsx(
        'group relative flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium transition-colors',
        active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
      )}
      aria-current={active ? 'page' : undefined}
    >
      {active && <span aria-hidden className="absolute inset-y-2 left-0 w-[3px] rounded-full bg-sidebar-primary" />}
      <Icon className={clsx('h-[18px] w-[18px] flex-shrink-0', active ? 'text-sidebar-primary' : 'opacity-80 group-hover:opacity-100')} />
      <span className="flex-1">{item.label}</span>
      {typeof item.count === 'number' && item.count > 0 && (
        <span className={clsx('min-w-6 rounded-full px-2 py-0.5 text-center text-[11px] font-semibold tabular-nums', active ? 'bg-sidebar-primary text-sidebar-primary-foreground' : 'bg-sidebar-accent text-sidebar-foreground')}>
          {item.count}
        </span>
      )}
    </Link>
  );
}

export function Sidebar() {
  const location = useLocation();
  const { isSignedIn, userId } = useAuth();
  const { inOrg, canReport } = useOrgContext();
  const { recentClicks, clearAll } = useClickNotifications(!!isSignedIn, userId);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [showBell, setShowBell] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (mobileOpen) menuRef.current?.showModal(); }, [mobileOpen]);

  const { data: vaultConfig } = useQuery({
    queryKey: ['champvault-config'],
    queryFn: () => champvaultApi.config(),
    enabled: !!isSignedIn,
    staleTime: 5 * 60 * 1000,
  });
  const vaultEnabled = !!vaultConfig?.configured;

  // Counts share the pages' query keys, so these are cache hits once a page has
  // loaded and they refresh together.
  const { files, pages, links } = useShareLists(!!isSignedIn);

  useEffect(() => {
    function onAway(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) setShowBell(false);
    }
    document.addEventListener('mousedown', onAway);
    return () => document.removeEventListener('mousedown', onAway);
  }, []);

  // Close the mobile rail on navigation (adjust-state-during-render, no effect).
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setMobileOpen(false);
  }

  const items: NavItem[] = [
    { to: '/', label: 'Share', icon: Zap, end: true },
    { to: '/links', label: 'Links', icon: Link2, count: links.data?.length },
    { to: '/files', label: 'Files', icon: FileText, count: files.data?.length },
    { to: '/pages', label: 'Pages', icon: Globe, count: pages.data?.length },
    { to: '/vault', label: 'Vault', icon: Radio, requiresVault: true },
    { to: '/library', label: 'Library', icon: Library, requiresOrg: 'member' },
    { to: '/team', label: 'Reporting', icon: Users, requiresOrg: 'team' },
    { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  const visible = items.filter((it) => {
    if (it.requiresOrg === 'member' && !inOrg) return false;
    if (it.requiresOrg === 'team' && !(inOrg && canReport)) return false;
    if (it.requiresVault && !vaultEnabled) return false;
    return true;
  });

  const isActive = (it: NavItem) =>
    it.end ? location.pathname === it.to : location.pathname.startsWith(it.to);

  const railInner = (
    <div className="cb-sidebar flex h-full flex-col overflow-y-auto bg-sidebar text-sidebar-foreground" style={{ backgroundImage: 'linear-gradient(180deg, var(--cb-side2), var(--cb-side1) 40%)' }}>
      <div className="flex items-center justify-between px-5 pb-5 pt-6">
        <Link to="/" className="flex items-center">
          <Logo tone="dark" />
        </Link>
        <button
          onClick={() => setMobileOpen(false)}
          className="rounded-lg p-1 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground md:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <p className="px-6 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-foreground/60">Workspace</p>
      <nav className="flex flex-1 flex-col gap-0.5 px-3" aria-label="Workspace">
        {visible.map((it) => (
          <NavRow key={it.to} item={it} active={isActive(it)} onClick={() => setMobileOpen(false)} />
        ))}
      </nav>

      <div className="space-y-1 border-t border-sidebar-border p-3">
        <div ref={bellRef} className="relative">
          <button
            onClick={() => setShowBell((v) => !v)}
            className="flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm font-medium text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            title="Recent opens"
          >
            <span className="relative">
              <Bell className="h-[18px] w-[18px]" />
              {recentClicks.length > 0 && (
                <span
                  className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full border-2"
                  style={{ background: 'var(--cb-accent-light)', borderColor: 'var(--cb-side1)' }}
                />
              )}
            </span>
            <span className="flex-1 text-left">Recent opens</span>
          </button>
          {showBell && (
            <div
              className="absolute bottom-14 left-0 z-50 max-h-96 w-72 overflow-y-auto rounded-2xl bg-card p-1 shadow-2xl"
              style={{ border: '1px solid var(--cb-border-strong)' }}
            >
              <div className="flex items-center justify-between px-3 py-2.5" style={{ borderBottom: '1px solid var(--cb-divider)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--cb-ink)' }}>Recent opens</p>
                {recentClicks.length > 0 && <button type="button" onClick={() => void clearAll()}
                  className="text-xs font-medium text-cb-accent hover:underline">Clear all</button>}
              </div>
              {recentClicks.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--cb-muted)' }}>
                  No recent opens
                </div>
              ) : (
                recentClicks.slice(0, 10).map((click) => (
                  <div key={click.id} className="rounded-xl px-3 py-2.5 hover:bg-[var(--cb-bg)]">
                    <p className="truncate text-sm" style={{ color: 'var(--cb-ink)' }} title={click.filename || click.original_url || undefined}>
                      {(click.filename || click.original_url || 'Link open').slice(0, 34)}
                    </p>
                    <p className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                      <span className="rounded-full bg-cb-chip px-2 py-0.5 text-cb-text">{[click.country, click.region].filter(Boolean).join(', ') || 'Unknown location'}</span>
                      <span className="rounded-full bg-cb-chip px-2 py-0.5 text-cb-text">{click.device_type || 'Unknown device'}</span>
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="cb-assistant-sidebar"><AssistantLauncher isAuthenticated={!!isSignedIn} /></div>
        <AccountFooter />
      </div>
    </div>
  );

  return (
    <>
      <a href="#main-content" className="cb-skip">Skip to content</a>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-60 flex-shrink-0 md:block">
        {railInner}
      </aside>

      {/* Mobile top bar */}
      <div
        className="sticky top-0 z-40 flex items-center justify-between bg-sidebar px-4 py-2 text-sidebar-foreground md:hidden"
      >
        <Link to="/" className="flex items-center">
          <Logo tone="dark" size={30} />
        </Link>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            aria-label="Open menu"
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <dialog ref={menuRef} aria-label="Workspace navigation" onClose={() => setMobileOpen(false)} className="cb-mobile-menu md:hidden">{railInner}</dialog>
      )}
    </>
  );
}
