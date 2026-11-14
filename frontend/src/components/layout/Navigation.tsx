import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { BarChart3, FolderOpen, Menu, X, Settings, FileText, Globe, Library, Users, Radio } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { clsx } from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../lib/authClient';
import { Button } from '../ui/Button';
import { LogoMark } from '../ui/Logo';
import { useOrgContext } from '../../hooks/useOrgContext';
import { champvaultApi } from '../../api/champvault';

interface NavLink {
  to: string;
  label: string;
  icon: LucideIcon;
  requiresAuth?: boolean;
  publicOnly?: boolean;
  // 'member' shows for anyone with an active org; 'admin' only for org admins;
  // 'team' for the team-analytics tier (admins + leaders).
  requiresOrg?: 'member' | 'admin' | 'team';
  // Only shown when the ChampVault hub is configured on this deployment.
  requiresVault?: boolean;
}

// Signed-out only. The public generator is gone, so '/' is the landing and
// this bar is the logo plus sign in / sign up. Work-screen links stay behind auth.
const navLinks: NavLink[] = [
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
  const navigate = useNavigate();
  // App.tsx renders this bar only for signed-out visitors; signed-in users get the Sidebar.
  const { isSignedIn, isLoaded } = useAuth();
  const { inOrg, isAdmin, canManageTeam } = useOrgContext();
  const { data: vaultConfig } = useQuery({
    queryKey: ['champvault-config'],
    queryFn: () => champvaultApi.config(),
    enabled: !!isSignedIn,
    staleTime: 5 * 60 * 1000,
  });
  const vaultEnabled = !!vaultConfig?.configured;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const signedOut = isLoaded && !isSignedIn;

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
            {signedOut && (
              <div className="hidden md:flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => navigate('/sign-in')}>Sign In</Button>
                <Button variant="primary" size="sm" onClick={() => navigate('/sign-up')}>Sign Up</Button>
              </div>
            )}

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
          {signedOut && (
            <div className="px-4 py-3 border-t border-slate-100 flex items-center gap-2">
              <Button variant="ghost" size="sm" className="flex-1 justify-center" onClick={() => navigate('/sign-in')}>Sign In</Button>
              <Button variant="primary" size="sm" className="flex-1 justify-center" onClick={() => navigate('/sign-up')}>Sign Up</Button>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
