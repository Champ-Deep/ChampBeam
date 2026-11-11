import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, FileClock, Inbox, Menu, ScrollText, Send, ShieldCheck, X } from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { useQuery } from '@tanstack/react-query';
import { apiErrorStatus } from '../api/_shared';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { Button } from '../components/ui';
import { Input } from '../components/ui/Input';
import { Logo } from '../components/ui/Logo';
import { authClient, googleSignInEnabled, useAuth } from '../lib/authClient';
import { intranetApi } from './api';
import { AdminPage } from './pages/AdminPage';
import { DecisionLogPage } from './pages/DecisionLogPage';
import { InboxPage } from './pages/InboxPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { SubmitPage } from './pages/SubmitPage';
import { errorText, useBadges, useMe } from './shared';
import { installErrorReporting } from './errorReporting';

installErrorReporting();

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: 'var(--cb-bg)' }}>
      {children}
    </div>
  );
}

function AuthCard({ title, lede, children }: { title: string; lede: string; children: React.ReactNode }) {
  return (
    <Centered>
      <section className="cb-panel w-full" style={{ maxWidth: 420 }}>
        <Logo tone="light" size={32} />
        <h1 className="mt-6 text-2xl font-bold">{title}</h1>
        <p className="cb-help">{lede}</p>
        <div className="mt-4">{children}</div>
      </section>
    </Centered>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function SignInPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(params.get('error') ? 'Sign-in did not finish. If you were not invited, ask an Admin for an invitation.' : '');
  const [busy, setBusy] = useState(false);
  if (isLoaded && isSignedIn) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL.test(email.trim()) || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    const { error: err } = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(err.status === 429 ? 'Too many attempts. Wait a minute, then try again.' : 'Email or password is incorrect.');
    else void navigate('/', { replace: true });
  }

  return (
    <AuthCard title="Sign in" lede="Champions intranet file transfer. Access is by invitation only.">
      {error && <p role="alert">{error}</p>}
      {googleSignInEnabled && (
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => void authClient.signIn.social({ provider: 'google', callbackURL: '/', errorCallbackURL: '/sign-in?error=google' })}
        >
          Continue with Google
        </Button>
      )}
      <form noValidate onSubmit={(e) => void submit(e)} className="mt-4 space-y-4" aria-busy={busy}>
        <Input id="intranet-email" label="Work email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input id="intranet-password" label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" className="w-full" isLoading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      </form>
      <p className="cb-help mt-4">New here? Open the invite link an Admin sent you to create your account.</p>
    </AuthCard>
  );
}

function AcceptInvitePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const invite = useQuery({ queryKey: ['intranet-invite', token], queryFn: () => intranetApi.lookupInvite(token), enabled: !!token, retry: false });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (!token) {
    return (
      <AuthCard title="Invite link needed" lede="Open the full invite link an Admin sent you.">
        <Link to="/sign-in" className="underline">Sign in instead</Link>
      </AuthCard>
    );
  }
  if (invite.isLoading) return <p role="status">Checking your invitation…</p>;
  if (invite.error) {
    return (
      <AuthCard title="This invite cannot be used" lede={errorText(invite.error, 'The invite link is not valid.')}>
        <Link to="/sign-in" className="underline">Go to sign in</Link>
      </AuthCard>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError('Enter your name.');
      return;
    }
    if (password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await intranetApi.acceptInvite(token, name.trim(), password);
      window.location.assign('/inbox');
    } catch (err) {
      setError(errorText(err, 'Could not create your account.'));
      setBusy(false);
    }
  }

  return (
    <AuthCard title="Create your account" lede={`You were invited to ${invite.data?.organization ?? 'the intranet'} as ${invite.data?.email ?? ''}.`}>
      {error && <p role="alert">{error}</p>}
      <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4" aria-busy={busy}>
        <Input id="invite-email" label="Email" type="email" value={invite.data?.email ?? ''} readOnly disabled />
        <Input id="invite-name" label="Your name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input id="invite-password" label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} helperText="At least 8 characters." />
        <Button type="submit" className="w-full" isLoading={busy}>{busy ? 'Creating account…' : 'Create account'}</Button>
      </form>
    </AuthCard>
  );
}

function SignOutButton() {
  return (
    <Button variant="outline" onClick={() => void authClient.signOut().then(() => window.location.assign('/sign-in'))}>
      Sign out
    </Button>
  );
}

function NoAccess({ message }: { message: string }) {
  return (
    <Centered>
      <section className="cb-panel" style={{ maxWidth: 520 }}>
        <h1 className="text-2xl font-bold">Access needed</h1>
        <p>{message}</p>
        <p className="cb-help">This intranet is invite-only. Ask an admin for an invitation, then open the link they send you.</p>
        <SignOutButton />
      </section>
    </Centered>
  );
}

function OrgPicker() {
  const orgs = authClient.useListOrganizations();
  const [error, setError] = useState('');
  const list = orgs.data ?? [];
  const only = list.length === 1 ? list[0] : undefined;
  const tried = useRef(false);

  useEffect(() => {
    if (orgs.isPending || !only || tried.current) return;
    tried.current = true;
    void authClient.organization.setActive({ organizationId: only.id }).then(({ error: err }) => {
      if (err) setError('Could not open your organization.');
    });
  }, [orgs.isPending, only]);

  if (orgs.isPending || (only && !error)) return <p role="status">Opening your organization…</p>;
  if (!list.length) return <NoAccess message="Your account is not a member of any organization yet." />;
  return (
    <Centered>
      <section className="cb-panel" style={{ maxWidth: 520 }}>
        <h1 className="text-2xl font-bold">Choose an organization</h1>
        {error && <p role="alert">{error}</p>}
        <div className="cb-actions">
          {list.map((o) => (
            <Button key={o.id} onClick={() => void authClient.organization.setActive({ organizationId: o.id })}>{o.name}</Button>
          ))}
        </div>
      </section>
    </Centered>
  );
}

interface NavItem {
  to: string;
  label: string;
  icon: typeof Inbox;
  count?: number;
  urgent?: boolean;
}

function Rail({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const location = useLocation();
  const { user } = useAuth();
  const me = useMe();
  return (
    <div className="cb-sidebar flex h-full flex-col overflow-y-auto" style={{ background: 'var(--cb-side1)', color: '#ffffff' }}>
      <div className="px-5 pb-4 pt-5">
        <Link to="/inbox" className="flex items-center" onClick={onNavigate}><Logo tone="dark" /></Link>
        <p className="mt-2 text-xs" style={{ color: '#dac8bf' }}>Intranet file transfer</p>
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-3" aria-label="Intranet">
        {items.map((item) => {
          const Icon = item.icon;
          const active = location.pathname.startsWith(item.to);
          return (
            <Link
              key={item.to}
              to={item.to}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
                active ? 'text-white' : 'text-[#eee0d8] hover:bg-white/5 hover:text-white',
              )}
              style={active ? { background: 'var(--cb-side3)' } : undefined}
            >
              <Icon className="h-[18px] w-[18px] flex-shrink-0" />
              <span className="flex-1">{item.label}</span>
              {typeof item.count === 'number' && item.count > 0 && (
                <span
                  className={clsx('rounded-md px-1.5 py-0.5 text-[10.5px] font-bold text-white', item.urgent ? 'bg-red-700' : 'bg-white/10')}
                  aria-label={item.urgent ? `${item.count} waiting, some overdue` : `${item.count} new`}
                >
                  {item.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="cb-account border-t border-white/10 p-4">
        <p><strong>{me.data?.user.full_name || user?.name || me.data?.user.email}</strong></p>
        <p style={{ color: '#eee0d8' }}>
          {me.data?.organization.name}
          {me.data?.is_admin ? ' · Admin' : ''}
          {me.data?.is_reviewer ? ' · Reviewer' : ''}
        </p>
        <SignOutButton />
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const me = useMe();
  const badges = useBadges(Boolean(me.data));
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const overdue = badges.data?.review_overdue ?? 0;
  const isReviewer = Boolean(me.data?.is_reviewer);
  const lastOverdue = useRef<number | null>(null);
  useEffect(() => {
    if (!isReviewer || !badges.data) return;
    if (overdue > (lastOverdue.current ?? 0)) {
      toast.warning(`${overdue} submission${overdue === 1 ? ' is' : 's are'} waiting too long for review`);
    }
    lastOverdue.current = overdue;
  }, [overdue, isReviewer, badges.data]);

  const items: NavItem[] = [
    { to: '/inbox', label: 'Inbox', icon: Inbox, count: badges.data?.inbox_unopened },
    { to: '/submit', label: 'Submit a file', icon: Send },
    { to: '/submissions', label: 'My submissions', icon: FileClock },
  ];
  if (isReviewer) items.push({ to: '/review', label: 'Review queue', icon: ClipboardCheck, count: badges.data?.review_queue, urgent: overdue > 0 });
  if (me.data?.is_reviewer || me.data?.is_admin) items.push({ to: '/log', label: 'Decision log', icon: ScrollText });
  if (me.data?.is_admin) items.push({ to: '/admin', label: 'Administration', icon: ShieldCheck });

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <a href="#main-content" className="cb-skip">Skip to content</a>
      <aside className="sticky top-0 hidden h-screen w-60 flex-shrink-0 md:block"><Rail items={items} /></aside>
      <div className="sticky top-0 z-40 flex items-center justify-between px-4 py-3 md:hidden" style={{ background: 'var(--cb-side1)', color: '#fff' }}>
        <Logo tone="dark" size={30} />
        <button onClick={() => setOpen(true)} className="rounded-lg p-2 text-white/70 hover:bg-white/10" aria-label="Open menu"><Menu className="h-6 w-6" /></button>
      </div>
      {open && (
        <dialog ref={dialog} aria-label="Intranet navigation" onClose={() => setOpen(false)} className="cb-mobile-menu md:hidden">
          <button onClick={() => dialog.current?.close()} className="absolute right-3 top-3 z-10 rounded-lg p-1 text-white/60" aria-label="Close menu"><X className="h-5 w-5" /></button>
          <Rail items={items} onNavigate={() => dialog.current?.close()} />
        </dialog>
      )}
      <main id="main-content" className="min-w-0 flex-1">{children}</main>
    </div>
  );
}

function Gate({ need, children }: { need: 'reviewer' | 'auditor' | 'admin'; children: React.ReactNode }) {
  const me = useMe();
  if (!me.data) return null;
  const allowed =
    need === 'reviewer' ? me.data.is_reviewer : need === 'admin' ? me.data.is_admin : me.data.is_reviewer || me.data.is_admin;
  if (!allowed) return <div className="cb-workspace"><p role="alert">You do not have access to this page.</p></div>;
  return <>{children}</>;
}

function Workspace() {
  const { orgId } = useAuth();
  const me = useMe();
  if (!orgId) return <OrgPicker />;
  if (me.isLoading) return <p role="status">Checking your access…</p>;
  if (me.error) {
    const status = apiErrorStatus(me.error);
    if (status === 403) return <NoAccess message={errorText(me.error, 'You do not have access.')} />;
    return <Centered><p role="alert">{errorText(me.error, 'The intranet is unavailable. Try again shortly.')}</p></Centered>;
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/inbox" replace />} />
        <Route path="/inbox" element={<InboxPage />} />
        <Route path="/submit" element={<SubmitPage />} />
        <Route path="/submissions" element={<SubmissionsPage />} />
        <Route path="/review" element={<Gate need="reviewer"><ReviewQueuePage /></Gate>} />
        <Route path="/log" element={<Gate need="auditor"><DecisionLogPage /></Gate>} />
        <Route path="/admin" element={<Gate need="admin"><AdminPage /></Gate>} />
        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Routes>
    </Shell>
  );
}

function SignedIn({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return <p role="status">Loading account…</p>;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  return <>{children}</>;
}

export default function IntranetApp() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--cb-bg)' }}>
      <AnnouncementBanner />
      <Routes>
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/sign-up/*" element={<Navigate to="/sign-in" replace />} />
        <Route path="*" element={<SignedIn><Workspace /></SignedIn>} />
      </Routes>
    </div>
  );
}
