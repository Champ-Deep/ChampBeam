import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { Link2, BarChart3, FolderOpen, Bell, Menu, X, Settings, FileText, Globe, Library, Users, Radio } from 'lucide-react';

import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { Show, SignInButton, SignUpButton, UserButton, OrganizationSwitcher, useAuth } from '@clerk/react';
import { Button } from '../ui/Button';
import { LogoMark } from '../ui/Logo';
import { useClickNotifications } from '../../hooks/useClickNotifications';
import { useOrgContext } from '../../hooks/useOrgContext';
import { champvaultApi } from '../../api/champvault';

interface NavLink {
  to: string;
  label: string;
  icon: typeof Link2;
  requiresAuth?: boolean;
  publicOnly?: boolean;
  // 'member' shows for anyone with an active org; 'admin' only for org admins;
  // 'team' for the team-analytics tier (admins + leaders).
  requiresOrg?: 'member' | 'admin' | 'team';
  // Only shown when the ChampVault hub is configured on this deployment.
  requiresVault?: boolean;
}

const navLinks: NavLink[] = [
  { to: '/', label: 'Generator', icon: Link2 },
  { to: '/links', label: 'Links', icon: FolderOpen, requiresAuth: true },
  { to: '/files', label: 'Files', icon: FileText, requiresAuth: true },
  { to: '/pages', label: 'Pages', icon: Globe, requiresAuth: true },
  { to: '/vault', label: 'Vault', icon: Radio, requiresAuth: true, requiresVault: true },
  { to: '/library', label: 'Library', icon: Library, requiresAuth: true, requiresOrg: 'member' },
  { to: '/team', label: 'Team', icon: Users, requiresAuth: true, requiresOrg: 'team' },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, requiresAuth: true },
  { to: '/settings', label: 'Settings', icon: Settings, requiresAuth: true },
];

export function Navigation() {
  const location = useLocation();
  const { isSignedIn } = useAuth();
  const { inOrg, isAdmin, canManageTeam } = useOrgContext();
  const { recentClicks } = useClickNotifications(!!isSignedIn);
  const { data: vaultConfig } = useQuery({
    queryKey: ['champvault-config'],
    queryFn: () => champvaultApi.config(),
    enabled: !!isSignedIn,
    staleTime: 5 * 60 * 1000,
  });
  const vaultEnabled = !!vaultConfig?.configured;
  const [showBell, setShowBell] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setShowBell(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close the mobile menu on navigation (adjust-state-during-render, no effect).
  const [lastPath, setLastPath] = useState(location.pathname);
  if (lastPath !== location.pathname) {
    setLastPath(location.pathname);
    setMobileMenuOpen(false);
  }

  const visibleLinks = navLinks.filter((link) => {
    if (link.publicOnly) return !isSignedIn;
    if (link.requiresAuth && !isSignedIn) return false;
    if (link.requiresOrg === 'member' && !inOrg) return false;
    if (link.requiresOrg === 'admin' && !(inOrg && isAdmin)) return false;
    if (link.requiresOrg === 'team' && !(inOrg && canManageTeam)) return false;
    if (link.requiresVault && !vaultEnabled) return false;
    return true;
  });

  return (
    <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link to="/" className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-[9px]"
              style={{ background: 'var(--cb-accent)' }}
            >
              <LogoMark size={18} color="#fff" />
            </span>
            <span className="font-display text-xl font-bold" style={{ color: 'var(--cb-ink)' }}>
              Champ<span style={{ color: 'var(--cb-accent)' }}>beam</span>
            </span>
          </Link>

          <div className="hidden md:flex items-center gap-1">
            {visibleLinks.map((link) => {
              const Icon = link.icon;
              const isActive = link.to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(link.to);
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  className={clsx(
                    'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-purple/10 text-brand-purple'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {link.label}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <Show when="signed-in">
              <div className="relative" ref={bellRef}>
                <button
                  onClick={() => setShowBell(!showBell)}
                  className="relative p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 transition-colors"
                  title="Recent clicks"
                >
                  <Bell className="h-5 w-5" />
                  {recentClicks.length > 0 && (
                    <span className="absolute top-1 right-1 w-2 h-2 bg-brand-purple rounded-full" />
                  )}
                </button>
                {showBell && (
                  <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-lg border border-slate-200 z-50 max-h-96 overflow-y-auto">
                    <div className="px-4 py-3 border-b border-slate-100">
                      <p className="text-sm font-semibold text-slate-900">Recent Clicks</p>
                    </div>
                    {recentClicks.length === 0 ? (
                      <div className="px-4 py-6 text-center text-sm text-slate-400">No recent clicks</div>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {recentClicks.slice(0, 10).map((click) => (
                          <div key={click.id} className="px-4 py-3 hover:bg-slate-50">
                            <p className="text-sm text-slate-900 truncate" title={click.original_url}>
                              {click.original_url.length > 35
                                ? click.original_url.slice(0, 35) + '...'
                                : click.original_url}
                            </p>
                            <p className="text-xs text-slate-500 mt-0.5">
                              {[click.country, click.region].filter(Boolean).join(', ') || 'Unknown location'}
                              {' • '}
                              {click.device_type || 'Unknown device'}
                            </p>
                            {click.clicked_at && (
                              <p className="text-xs text-slate-400 mt-0.5">
                                {new Date(click.clicked_at).toLocaleString('en-US', {
                                  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                                })}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="hidden sm:block">
                <OrganizationSwitcher
                  hidePersonal={false}
                  afterSelectOrganizationUrl="/library"
                  afterSelectPersonalUrl="/"
                  appearance={{ elements: { rootBox: 'flex items-center' } }}
                />
              </div>
              <UserButton />
            </Show>

            <Show when="signed-out">
              <div className="hidden md:flex items-center gap-2">
                <SignInButton>
                  <Button variant="ghost" size="sm">Sign In</Button>
                </SignInButton>
                <SignUpButton>
                  <Button variant="primary" size="sm">Sign Up</Button>
                </SignUpButton>
              </div>
            </Show>

            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition-colors"
              aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileMenuOpen}
            >
              {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
            </button>
          </div>
        </div>
      </div>

      {mobileMenuOpen && (
        <div className="md:hidden border-t border-slate-200 bg-white">
          <div className="px-4 py-3 space-y-1">
            {visibleLinks.map((link) => {
              const Icon = link.icon;
              const isActive = link.to === '/'
                ? location.pathname === '/'
                : location.pathname.startsWith(link.to);
              return (
                <Link
                  key={link.to}
                  to={link.to}
                  className={clsx(
                    'flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-purple/10 text-brand-purple'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {link.label}
                </Link>
              );
            })}
          </div>
          <Show when="signed-out">
            <div className="px-4 py-3 border-t border-slate-100 flex items-center gap-2">
              <SignInButton>
                <Button variant="ghost" size="sm" className="flex-1 justify-center">Sign In</Button>
              </SignInButton>
              <SignUpButton>
                <Button variant="primary" size="sm" className="flex-1 justify-center">Sign Up</Button>
              </SignUpButton>
            </div>
          </Show>
        </div>
      )}
    </nav>
  );
}
