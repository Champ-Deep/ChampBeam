import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authClient, useAuth } from '../lib/authClient';
import { ROLE_LABEL } from '../api/selfServe';
import { Button } from '../components/ui';

/** /accept-invitation/:id. Better Auth only shows an invitation to the invited address, so a refusal there means the wrong account. */
export function AcceptInvitationPage() {
  const { id = '' } = useParams();
  const [params] = useSearchParams();
  const invitedEmail = params.get('email') ?? '';
  const { isLoaded, isSignedIn, user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const back = `/accept-invitation/${encodeURIComponent(id)}`;
  const authQuery = new URLSearchParams({ next: back, ...(invitedEmail ? { email: invitedEmail } : {}) }).toString();
  const invitation = useQuery({
    queryKey: ['invitation', id, user?.id],
    enabled: !!isSignedIn && !!id,
    retry: false,
    queryFn: async () => {
      const { data, error: err } = await authClient.organization.getInvitation({ query: { id } });
      if (err) throw Object.assign(new Error(err.message || 'Invitation not available.'), { status: err.status });
      return data;
    },
  });

  async function accept() {
    setBusy(true); setError('');
    const { data, error: err } = await authClient.organization.acceptInvitation({ invitationId: id });
    if (err || !data) { setBusy(false); return setError(err?.message || 'The invitation could not be accepted.'); }
    await authClient.organization.setActive({ organizationId: data.invitation.organizationId });
    void navigate('/', { replace: true });
  }

  async function switchAccount() {
    await authClient.signOut();
    void navigate(`/sign-in?${authQuery}`);
  }

  let body: React.ReactNode;
  if (!isLoaded) body = <p role="status">Checking your session</p>;
  else if (!isSignedIn) body = <>
    <h1>You have an invitation</h1>
    <p>{invitedEmail ? <>It was sent to <span className="cb-mono">{invitedEmail}</span>. Sign in or create an account with that address to join.</> : 'Sign in or create an account with the address the invitation was sent to.'}</p>
    <div className="cb-form-actions cb-start"><Link className="cb-btn-primary" to={`/sign-up?${authQuery}`}>Create an account</Link><Link className="cb-btn-quiet" to={`/sign-in?${authQuery}`}>Sign in</Link></div>
  </>;
  else if (invitation.isLoading) body = <p role="status">Opening the invitation</p>;
  else if (invitation.isError) {
    const status = (invitation.error as { status?: number }).status;
    const wrongAccount = status === 403 || /recipient/i.test(invitation.error.message);
    body = wrongAccount ? <>
      <h1>This invitation is for someone else</h1>
      <p role="alert" className="cb-refusal">You are signed in as <span className="cb-mono">{user?.email}</span>{invitedEmail ? <>, but the invitation was sent to <span className="cb-mono">{invitedEmail}</span></> : ', which is not the address it was sent to'}. Switch to that account to accept it.</p>
      <div className="cb-form-actions cb-start"><Button onClick={() => void switchAccount()}>Switch account</Button><Link className="cb-btn-quiet" to="/">Stay signed in</Link></div>
    </> : <>
      <h1>This invitation is no longer open</h1>
      <p role="alert" className="cb-refusal">It may have expired, been cancelled or already been used. Ask the person who invited you for a new link.</p>
      <div className="cb-form-actions cb-start"><Link className="cb-btn-quiet" to="/">Go to your workspace</Link></div>
    </>;
  } else if (invitation.data) {
    const inv = invitation.data;
    body = <>
      <h1>Join {inv.organizationName}</h1>
      <p>{inv.inviterEmail ? <><span className="cb-mono">{inv.inviterEmail}</span> invited you</> : 'You were invited'} as {ROLE_LABEL[inv.role] ?? inv.role}. Accepting moves you into {inv.organizationName}. Your Personal workspace stays yours.</p>
      {error && <p role="alert" className="cb-refusal">{error}</p>}
      <div className="cb-form-actions cb-start"><Button onClick={() => void accept()} isLoading={busy}>Accept and join</Button><Link className="cb-btn-quiet" to="/">Not now</Link></div>
    </>;
  }

  return <div className="cb-workspace cb-narrow"><section className="cb-invite-card">{body}</section></div>;
}
