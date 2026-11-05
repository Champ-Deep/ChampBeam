import { useState } from 'react';
import { useClerk, useUser, OrganizationSwitcher } from '@clerk/react';
import { Link } from 'react-router-dom';
import { useOrgContext } from '../hooks/useOrgContext';
import { apiErrorStatus } from '../api/_shared';

export function AccountFooter() {
  const { user, isLoaded } = useUser();
  const { openUserProfile, signOut } = useClerk();
  const { profile, inOrg, orgSlug, role, isLoading, error, refetch } = useOrgContext();
  const [loadedImage, setLoadedImage] = useState('');
  const [actionError, setActionError] = useState('');
  const name = profile?.full_name || user?.fullName || user?.primaryEmailAddress?.emailAddress || (isLoaded ? 'Account' : 'Loading account');
  const initials = name.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  const authorizationFailed = [401, 403].includes(apiErrorStatus(error) ?? 0);
  return <div className="cb-account">
    <details><summary><span className="cb-avatar" aria-hidden="true">{initials}{user?.imageUrl && <img key={user.imageUrl} src={user.imageUrl} alt="" width="36" height="36" style={{ opacity: loadedImage === user.imageUrl ? 1 : 0 }} onLoad={() => setLoadedImage(user.imageUrl)} onError={() => setLoadedImage('')} />}</span><span><strong>{name}</strong><span>{profile?.org?.name || orgSlug || (inOrg ? 'Organization workspace' : 'Personal workspace')}</span><span>Role: {role || (isLoading ? 'checking…' : error || inOrg ? 'unavailable' : 'personal account')}</span></span></summary>
      <div className="cb-account-menu"><button aria-label="Manage account" onClick={() => openUserProfile()}>Manage account</button><Link aria-label="Workspace settings" to="/settings">Workspace settings</Link><button aria-label="Sign out" onClick={() => { void signOut().catch(() => setActionError('Sign out failed. Try again.')); }}>Sign out</button></div>
    </details>
    {isLoading && <p role="status">Loading workspace profile…</p>}
    {error && <p role="alert">{authorizationFailed ? 'Workspace authorization failed.' : 'Workspace profile unavailable. Check your connection.'} <button onClick={() => void refetch()}>Retry access</button></p>}
    {actionError && <p role="alert">{actionError}</p>}
    <OrganizationSwitcher hidePersonal={false} afterSelectOrganizationUrl="/" afterSelectPersonalUrl="/" appearance={{ elements: { organizationSwitcherTrigger: 'text-white min-h-11', organizationPreviewMainIdentifier: 'text-white' } }} />
  </div>;
}
