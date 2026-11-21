import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { authClient } from '../../lib/authClient';
import { selfServeApi, slugify } from '../../api/selfServe';
import { apiErrorDetail, apiErrorStatus } from '../../api/_shared';
import { Modal } from '../ui/sheet';
import { Button } from '../ui';

/**
 * Create an organization. Structure from 21st.dev "CreateWorkspaceModal" (id 7118, efferd/create-workspace-modal):
 * name, slug with a host prefix, one action. `withFirstAdmin` is the super-admin form: the org is made through
 * /api/v1/admin/orgs with someone else as its first admin. Otherwise the caller creates it and switches into it.
 */
export function CreateOrgDialog({ open, onOpenChange, platformHost, withFirstAdmin = false, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; platformHost: string; withFirstAdmin?: boolean; onCreated?: (id: string) => void;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const effectiveSlug = slugEdited ? slug : slugify(name);

  function reset() { setName(''); setSlug(''); setSlugEdited(false); setEmail(''); setError(''); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError('Give the organization a name.');
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(effectiveSlug)) return setError('The slug uses lowercase letters, numbers and hyphens, up to 40 characters.');
    if (withFirstAdmin && !/^\S+@\S+\.\S+$/.test(email.trim())) return setError('Enter the first admin\'s email address.');
    setBusy(true); setError('');
    try {
      if (withFirstAdmin) {
        const org = await selfServeApi.adminCreateOrg({ name: name.trim(), slug: effectiveSlug, email: email.trim().toLowerCase() });
        await client.invalidateQueries({ queryKey: ['admin-orgs'] });
        onCreated?.(org.id);
      } else {
        const { data, error: err } = await authClient.organization.create({ name: name.trim(), slug: effectiveSlug });
        if (err || !data) throw new Error(err?.message || 'The organization could not be created.');
        const switched = await authClient.organization.setActive({ organizationId: data.id });
        if (switched.error) throw new Error('Created, but switching into it failed. Pick it from the workspace menu.');
        void navigate('/settings');
      }
      reset(); onOpenChange(false);
    } catch (err) {
      const status = apiErrorStatus(err);
      setError(status === 404 ? 'No ChampBeam account uses that email. Ask them to sign up first, then create the organization.'
        : status === 409 ? 'That slug is already taken. Try another.'
        : apiErrorDetail(err) ?? 'The organization could not be created.');
    } finally { setBusy(false); }
  }

  return <Modal open={open} onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }} title="Create an organization"
    description={withFirstAdmin ? 'You stay outside it. The first admin you name runs it from day one.' : 'You become its admin, and the app switches into it.'}>
    <form className="cb-form" noValidate onSubmit={(e) => void submit(e)}>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." autoFocus maxLength={100} /></label>
      <label>Slug
        <span className="cb-prefixed"><span className="cb-mono">{platformHost} /</span><input className="cb-mono" value={effectiveSlug} onChange={(e) => { setSlugEdited(true); setSlug(e.target.value.toLowerCase()); }} placeholder="acme" maxLength={40} aria-describedby="slug-help" /></span>
      </label>
      <p id="slug-help" className="cb-hint">Lowercase letters, numbers and hyphens. It names the workspace and cannot be reused.</p>
      {withFirstAdmin && <label>First admin's email<input type="email" className="cb-mono" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" autoComplete="off" /></label>}
      {error && <p role="alert" className="cb-refusal">{error}</p>}
      <div className="cb-form-actions"><Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" isLoading={busy}>Create organization</Button></div>
    </form>
  </Modal>;
}
