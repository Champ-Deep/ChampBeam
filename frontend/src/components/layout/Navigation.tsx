import { Link, useLocation } from 'react-router-dom';
import { Link2, BookmarkCheck, BarChart3, TrendingUp, FileSpreadsheet, FolderOpen, LogOut, LogIn, UserPlus } from 'lucide-react';
import { clsx } from 'clsx';
import { Button } from '../ui/Button';

interface NavigationProps {
  isAuthenticated: boolean;
  onLogout: () => void;
}

const navLinks = [
  { to: '/', label: 'Generator', icon: Link2 },
  { to: '/projects', label: 'Projects', icon: FolderOpen, requiresAuth: true },
  { to: '/presets', label: 'Presets', icon: BookmarkCheck, requiresAuth: true },
  { to: '/analytics', label: 'Analytics', icon: BarChart3, requiresAuth: true },
  { to: '/performance', label: 'Performance', icon: TrendingUp, requiresAuth: true },
  { to: '/bulk', label: 'Bulk', icon: FileSpreadsheet, requiresAuth: true },
];

export function Navigation({ isAuthenticated, onLogout }: NavigationProps) {
  const location = useLocation();

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
                const isActive = location.pathname === link.to;
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

          {/* Auth buttons */}
          <div className="flex items-center gap-2">
            {isAuthenticated ? (
              <Button variant="ghost" size="sm" onClick={onLogout}>
                <LogOut className="h-4 w-4 mr-1.5" />
                Sign Out
              </Button>
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
