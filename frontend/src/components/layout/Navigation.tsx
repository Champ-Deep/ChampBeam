import { useState, useRef, useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Link2, BookmarkCheck, BarChart3, FolderOpen, Megaphone, LogOut, LogIn, UserPlus, Bell, Settings, Briefcase } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '../ui/Button';
import { useClickNotifications } from '../../hooks/useClickNotifications';

interface NavigationProps {
  isAuthenticated: boolean;
  onLogout: () => void;
}

const navLinks = [
  { to: '/', label: 'Generator', icon: Link2 },
  { to: '/links', label: 'Links', icon: FolderOpen, requiresAuth: true },
  { to: '/projects', label: 'Projects', icon: Briefcase, requiresAuth: true },
  { to: '/presets', label: 'Presets', icon: BookmarkCheck, requiresAuth: true },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, requiresAuth: true },
  { to: '/campaigns', label: 'Campaign Analytics', icon: Megaphone, requiresAuth: true },
];

export function Navigation({ isAuthenticated, onLogout }: NavigationProps) {
  const location = useLocation();
  const { recentClicks } = useClickNotifications(isAuthenticated);
  const [showBell, setShowBell] = useState(false);
  const bellRef = useRef<HTMLDivElement>(null);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (bellRef.current && !bellRef.current.contains(e.target as Node)) {
        setShowBell(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <nav className="bg-white border-b border-slate-200 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <Link2 className="h-7 w-7 text-brand-purple" />
            <span className="text-xl font-bold text-slate-900">
              Champ<span className="text-brand-purple">UTM</span>
            </span>
          </Link>

          {/* Nav links */}
          <div className="hidden md:flex items-center gap-1">
            {navLinks
              .filter((link) => !link.requiresAuth || isAuthenticated)
              .map((link) => {
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

          {/* Auth buttons + notification bell */}
          <div className="flex items-center gap-2">
            {isAuthenticated && (
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
                      <div className="px-4 py-6 text-center text-sm text-slate-400">
                        No recent clicks
                      </div>
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
                              {' \u2022 '}
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
            )}

            {isAuthenticated ? (
              <>
                <Link to="/settings">
                  <Button variant="ghost" size="sm">
                    <Settings className="h-4 w-4 mr-1.5" />
                    Settings
                  </Button>
                </Link>
                <Button variant="ghost" size="sm" onClick={onLogout}>
                  <LogOut className="h-4 w-4 mr-1.5" />
                  Sign Out
                </Button>
              </>
            ) : (
              <>
                <Link to="/login">
                  <Button variant="ghost" size="sm">
                    <LogIn className="h-4 w-4 mr-1.5" />
                    Sign In
                  </Button>
                </Link>
                <Link to="/register">
                  <Button variant="primary" size="sm">
                    <UserPlus className="h-4 w-4 mr-1.5" />
                    Sign Up
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
