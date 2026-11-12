import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { authClient, useAuth } from '../lib/authClient';
import { useOrgContext } from '../hooks/useOrgContext';
import { apiErrorStatus } from '../api/_shared';
import { OrgSwitcher } from './OrgSwitcher';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

const item = 'min-h-11 cursor-pointer rounded-lg px-3 text-[14px] text-[var(--cb-ink)] focus:bg-[var(--cb-bg)] focus:text-[var(--cb-ink)]';

export function AccountFooter() {
  const { user, isLoaded } = useAuth();
  const navigate = useNavigate();
  const { profile, inOrg, orgSlug, role, isLoading, error, refetch } = useOrgContext();
  const [loadedImage, setLoadedImage] = useState('');
  const [actionError, setActionError] = useState('');
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const name = profile?.full_name || user?.name || user?.email || (isLoaded ? 'Account' : 'Loading account');
  const initials = name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const image = user?.image ?? '';
  const authorizationFailed = [401, 403].includes(apiErrorStatus(error) ?? 0);
  async function signOut() {
    setActionError('');
    const result = await authClient.signOut().catch(() => ({ error: true }));
    if (result?.error) setActionError('Sign out failed. Try again.');
    else void navigate('/');
  }
  return <div className="cb-account" ref={(el) => setDialog(el?.closest('dialog') ?? null)}>
    <OrgSwitcher />
    <DropdownMenu>
      <DropdownMenuTrigger className="cb-account-trigger" aria-label={`Account menu for ${name}`}><span className="cb-avatar" aria-hidden="true">{initials}{image && <img key={image} src={image} alt="" width="36" height="36" style={{ opacity: loadedImage === image ? 1 : 0 }} onLoad={() => setLoadedImage(image)} onError={() => setLoadedImage('')} />}</span><span><strong>{name}</strong><span>{profile?.org?.name || orgSlug || (inOrg ? 'Organization workspace' : 'Personal workspace')}</span><span>Role: {role || (isLoading ? 'checking…' : error || inOrg ? 'unavailable' : 'personal account')}</span></span></DropdownMenuTrigger>
      <DropdownMenuContent container={dialog} align="start" side="top" className="w-64 rounded-xl border-[var(--cb-border)] bg-card p-1 text-[var(--cb-ink)] shadow-xl">
        <DropdownMenuLabel className="px-3 py-2"><span className="block truncate text-[14px] font-semibold">{name}</span>{user?.email && <span className="block truncate font-mono text-[12px] font-normal text-[var(--cb-muted)]">{user.email}</span>}</DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-[var(--cb-divider)]" />
        <DropdownMenuItem asChild className={item}><Link to="/settings">Workspace settings</Link></DropdownMenuItem>
        <DropdownMenuItem className={item} onSelect={() => void signOut()}>Sign out</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    {isLoading && <p role="status">Loading workspace profile…</p>}
    {error && <p role="alert">{authorizationFailed ? 'Workspace authorization failed.' : 'Workspace profile unavailable. Check your connection.'} <button onClick={() => void refetch()}>Retry access</button></p>}
    {actionError && <p role="alert">{actionError}</p>}
  </div>;
}
