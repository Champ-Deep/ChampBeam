import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Show, SignIn, useAuth, useClerk, useOrganizationList, useUser } from '@clerk/react';
import { ClipboardCheck, FileClock, Inbox, Menu, ScrollText, Send, ShieldCheck, X } from 'lucide-react';
import { clsx } from 'clsx';
import { apiErrorStatus } from '../api/_shared';
import { AnnouncementBanner } from '../components/AnnouncementBanner';
import { Button } from '../components/ui';
import { Logo } from '../components/ui/Logo';
import { AdminPage } from './pages/AdminPage';
import { DecisionLogPage } from './pages/DecisionLogPage';
import { InboxPage } from './pages/InboxPage';
import { ReviewQueuePage } from './pages/ReviewQueuePage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { SubmitPage } from './pages/SubmitPage';
import { errorText, useBadges, useMe } from './shared';

const HIDE_SIGN_UP = { elements: { footerAction: { display: 'none' } } };

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-4" style={{ background: 'var(--cb-bg)' }}>
      {children}
    </div>
  );
}

function SignInPage() {
  return (
    <Centered>
      <SignIn routing="path" path="/sign-in" fallbackRedirectUrl="/" appearance={HIDE_SIGN_UP} />
    </Centered>
  );
}

function SignOutButton() {
  const { signOut } = useClerk();
  return <Button variant="outline" onClick={() => void signOut()}>Sign out</Button>;
}

function NoAccess({ message }: { message: string }) {
  return (
    <Centered>
      <section className="cb-panel" style={{ maxWidth: 520 }}>
        <h1 className="text-2xl font-bold">Access needed</h1>
        <p>{message}</p>
        <p className="cb-help">This intranet is invite-only. Ask an admin to send you an invitation, then sign in with the invited email.</p>
        <SignOutButton />
      </section>
    </Centered>
  );
}

function OrgPicker() {
  const { isLoaded, setActive, userMemberships } = useOrganizationList({ userMemberships: true });
  const [error, setError] = useState('');
  const memberships = userMemberships.data ?? [];
  const only = memberships.length === 1 ? memberships[0] : undefined;
  const tried = useRef(false);

  useEffect(() => {
    if (!isLoaded || !only || tried.current) return;
    tried.current = true;
    void setActive({ organization: only.organization.id }).catch(() => setError('Could not open your organization.'));
  }, [isLoaded, only, setActive]);

  if (!isLoaded || userMemberships.isLoading || (only && !error)) return <p role="status">Opening your organization…</p>;
  if (!memberships.length) return <NoAccess message="Your account is not a member of any organization yet." />;
  return (
    <Centered>
      <section className="cb-panel" style={{ maxWidth: 520 }}>
        <h1 className="text-2xl font-bold">Choose an organization</h1>
        {error && <p role="alert">{error}</p>}
        <div className="cb-actions">
          {memberships.map((m) => (
            <Button key={m.id} onClick={() => void setActive({ organization: m.organization.id })}>{m.organization.name}</Button>
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
}

function Rail({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  const location = useLocation();
  const { user } = useUser();
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
                <span className="rounded-md bg-white/10 px-1.5 py-0.5 text-[10.5px] font-bold text-white" aria-label={`${item.count} new`}>
                  {item.count}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="cb-account border-t border-white/10 p-4">
        <p><strong>{me.data?.user.full_name || user?.fullName || me.data?.user.email}</strong></p>
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

  const items: NavItem[] = [
    { to: '/inbox', label: 'Inbox', icon: Inbox, count: badges.data?.inbox_unopened },
    { to: '/submit', label: 'Submit a file', icon: Send },
    { to: '/submissions', label: 'My submissions', icon: FileClock },
  ];
  if (me.data?.is_reviewer) items.push({ to: '/review', label: 'Review queue', icon: ClipboardCheck, count: badges.data?.review_queue });
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

export default function IntranetApp() {
  return (
    <div className="min-h-screen" style={{ background: 'var(--cb-bg)' }}>
      <AnnouncementBanner />
      <Routes>
        <Route path="/sign-in/*" element={<SignInPage />} />
        <Route path="/sign-up/*" element={<Navigate to="/sign-in" replace />} />
        <Route
          path="*"
          element={
            <>
              <Show when="signed-in"><Workspace /></Show>
              <Show when="signed-out"><Navigate to="/sign-in" replace /></Show>
            </>
          }
        />
      </Routes>
    </div>
  );
}
