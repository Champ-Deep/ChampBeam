import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Zap, Link2, FileText, Globe, Library, Users, BarChart3, Settings, Radio,
  Bell, Menu, X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { OrganizationSwitcher, UserButton, useAuth } from '@clerk/react';
import { Logo } from '../ui/Logo';
import { useClickNotifications } from '../../hooks/useClickNotifications';
import { useOrgContext } from '../../hooks/useOrgContext';
import { champvaultApi } from '../../api/champvault';
import { utmApi } from '../../api/utm';
import { filesApi } from '../../api/files';
import { pagesApi } from '../../api/pages';

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
        'group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
        active ? 'text-white' : 'text-white/60 hover:text-white hover:bg-white/5'
      )}
      style={active ? { background: 'rgba(255,255,255,.08)', boxShadow: 'inset 2.5px 0 0 var(--cb-accent-light)' } : undefined}
    >
      <Icon className="h-[18px] w-[18px] flex-shrink-0" />
      <span className="flex-1">{item.label}</span>
      {typeof item.count === 'number' && item.count > 0 && (
        <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10.5px] font-bold text-white/80">
          {item.count}
        </span>
      )}
    </Link>
  );
}

export function Sidebar() {
  const location = useLocation();
  const { isSignedIn } = useAuth();
  const { inOrg, canManageTeam } = useOrgContext();
  const { recentClicks } = useClickNotifications(!!isSignedIn);

  const [mobileOpen, setMobileOpen] = useState(false);
  const [showBell, setShowBell] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  const { data: vaultConfig } = useQuery({
    queryKey: ['champvault-config'],
    queryFn: () => champvaultApi.config(),
    enabled: !!isSignedIn,
    staleTime: 5 * 60 * 1000,
  });
  const vaultEnabled = !!vaultConfig?.configured;

  // Counts share the pages' query keys, so these are cache hits once a page has
  // loaded and they refresh together.
  const { data: links } = useQuery({
    queryKey: ['utm', 'links', 365],
    queryFn: () => utmApi.getLinkPerformance({ days: 365 }),
    enabled: !!isSignedIn,
    staleTime: 60 * 1000,
  });
  const { data: files } = useQuery({
    queryKey: ['files'],
    queryFn: () => filesApi.list(),
    enabled: !!isSignedIn,
    staleTime: 60 * 1000,
  });
  const { data: pages } = useQuery({
    queryKey: ['pages'],
    queryFn: () => pagesApi.list(),
    enabled: !!isSignedIn,
    staleTime: 60 * 1000,
  });

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
    { to: '/', label: 'Generator', icon: Zap, end: true },
    { to: '/links', label: 'Links', icon: Link2, count: links?.length },
    { to: '/files', label: 'Files', icon: FileText, count: files?.length },
    { to: '/pages', label: 'Pages', icon: Globe, count: pages?.length },
    { to: '/vault', label: 'Vault', icon: Radio, requiresVault: true },
    { to: '/library', label: 'Library', icon: Library, requiresOrg: 'member' },
    { to: '/team', label: 'Team', icon: Users, requiresOrg: 'team' },
    { to: '/analytics', label: 'Analytics', icon: BarChart3 },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];

  const visible = items.filter((it) => {
    if (it.requiresOrg === 'member' && !inOrg) return false;
    if (it.requiresOrg === 'team' && !(inOrg && canManageTeam)) return false;
    if (it.requiresVault && !vaultEnabled) return false;
    return true;
  });

  const isActive = (it: NavItem) =>
    it.end ? location.pathname === it.to : location.pathname.startsWith(it.to);

  const railInner = (
    <div className="flex h-full flex-col" style={{ background: 'var(--cb-side1)' }}>
      <div className="flex items-center justify-between px-5 pb-4 pt-5">
        <Link to="/" className="flex items-center">
          <Logo tone="dark" />
        </Link>
        <button
          onClick={() => setMobileOpen(false)}
          className="rounded-lg p-1 text-white/60 hover:bg-white/10 hover:text-white md:hidden"
          aria-label="Close menu"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex flex-1 flex-col gap-1 px-3">
        {visible.map((it) => (
          <NavRow key={it.to} item={it} active={isActive(it)} onClick={() => setMobileOpen(false)} />
        ))}
      </nav>

      <div className="space-y-3 border-t border-white/10 p-3">
        <div ref={bellRef} className="relative">
          <button
            onClick={() => setShowBell((v) => !v)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-white/60 transition-colors hover:bg-white/5 hover:text-white"
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
              className="absolute bottom-14 left-0 z-50 max-h-96 w-72 overflow-y-auto rounded-2xl bg-white p-1 shadow-2xl"
              style={{ border: '1px solid var(--cb-border-strong)' }}
            >
              <div className="px-3 py-2.5" style={{ borderBottom: '1px solid var(--cb-divider)' }}>
                <p className="text-sm font-semibold" style={{ color: 'var(--cb-ink)' }}>Recent opens</p>
              </div>
              {recentClicks.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm" style={{ color: 'var(--cb-muted)' }}>
                  No recent opens
                </div>
              ) : (
                recentClicks.slice(0, 10).map((click) => (
                  <div key={click.id} className="rounded-xl px-3 py-2.5 hover:bg-[var(--cb-bg)]">
                    <p className="truncate text-sm" style={{ color: 'var(--cb-ink)' }} title={click.original_url}>
                      {click.original_url.length > 34 ? click.original_url.slice(0, 34) + '…' : click.original_url}
                    </p>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--cb-muted)' }}>
                      {[click.country, click.region].filter(Boolean).join(', ') || 'Unknown location'}
                      {' · '}
                      {click.device_type || 'Unknown device'}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div
          className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
          style={{ background: 'rgba(255,255,255,.06)', borderColor: 'rgba(255,255,255,.1)' }}
        >
          <UserButton appearance={{ elements: { userButtonAvatarBox: 'h-8 w-8' } }} />
          <div className="min-w-0 flex-1">
            <OrganizationSwitcher
              hidePersonal={false}
              afterSelectOrganizationUrl="/library"
              afterSelectPersonalUrl="/"
              appearance={{
                elements: {
                  rootBox: 'w-full',
                  organizationSwitcherTrigger: 'text-white/80 hover:bg-white/10 w-full justify-start px-0 py-0',
                  organizationPreviewMainIdentifier: 'text-white text-sm',
                },
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-60 flex-shrink-0 md:block">
        {railInner}
      </aside>

      {/* Mobile top bar */}
      <div
        className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 md:hidden"
        style={{ background: 'var(--cb-side1)' }}
      >
        <Link to="/" className="flex items-center">
          <Logo tone="dark" size={30} />
        </Link>
        <div className="flex items-center gap-2">
          <UserButton />
          <button
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white"
            aria-label="Open menu"
          >
            <Menu className="h-6 w-6" />
          </button>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-64">{railInner}</div>
        </div>
      )}
    </>
  );
}
