import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { authClient, googleSignInEnabled, useAuth } from '../lib/authClient';
import { Card } from '../components/ui/Card';
import { Input } from '../components/ui/Input';
import { Button } from '../components/ui/Button';
import { Logo } from '../components/ui/Logo';

type Field = 'name' | 'email' | 'password' | 'form';
type Errors = Partial<Record<Field, string>>;
type AuthError = { code?: string; status?: number; message?: string } | null;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Better Auth error codes mapped to the field they belong under.
function serverErrors(err: AuthError): Errors {
  if (!err) return {};
  if (err.status === 429) return { form: 'Too many attempts. Wait a minute, then try again.' };
  switch (err.code) {
    case 'INVALID_EMAIL_OR_PASSWORD': return { password: 'Email or password is incorrect.' };
    case 'INVALID_EMAIL': return { email: 'Enter a valid email address.' };
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL': return { email: 'An account with this email already exists. Sign in instead.' };
    case 'PASSWORD_TOO_SHORT': return { password: 'Use at least 8 characters.' };
    case 'PASSWORD_TOO_LONG': return { password: 'Use 128 characters or fewer.' };
    case 'INVALID_TOKEN': return { form: 'This link has expired or was already used. Request a new one.' };
    case 'RESET_PASSWORD_DISABLED': return { form: 'Password reset is not available right now. Try again later.' };
    default: return { form: 'Something went wrong. Check your connection and try again.' };
  }
}

function AuthShell({ title, lede, children, footer }: { title: string; lede: string; children: ReactNode; footer: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Navigate to="/" replace />;
  return (
    <main className="flex min-h-screen items-center justify-center p-4" style={{ background: 'var(--cb-bg)' }}>
      <Card padding="lg" className="w-full max-w-[400px]">
        <Logo tone="light" size={32} />
        <h1 className="mt-6 font-display text-[28px] font-bold leading-tight" style={{ color: 'var(--cb-ink)' }}>{title}</h1>
        <p className="mt-1 text-[14px]" style={{ color: 'var(--cb-muted)' }}>{lede}</p>
        <div className="mt-6">{children}</div>
        <p className="mt-6 text-[14px]" style={{ color: 'var(--cb-text)' }}>{footer}</p>
      </Card>
    </main>
  );
}

function GoogleButton({ onError }: { onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  if (!googleSignInEnabled) return null;
  async function go() {
    setBusy(true);
    const { error } = await authClient.signIn.social({ provider: 'google', callbackURL: '/', errorCallbackURL: '/sign-in?error=google' });
    if (error) { setBusy(false); onError('Google sign-in could not start. Try again.'); }
  }
  return <>
    <Button type="button" variant="outline" size="lg" className="w-full" isLoading={busy} onClick={() => void go()}>
      {busy ? 'Opening Google…' : 'Continue with Google'}
    </Button>
    <p className="my-4 text-center text-[13px]" style={{ color: 'var(--cb-muted)' }}>or use your email</p>
  </>;
}

function FormAlert({ text }: { text?: string }) {
  return text ? <p role="alert" className="mb-4 rounded-lg border px-3 py-2 text-[14px]" style={{ borderColor: 'var(--cb-border-strong)', color: 'var(--cb-ink)', background: 'var(--cb-bg)' }}>{text}</p> : null;
}

export function SignInPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>(params.get('error') ? { form: 'Google sign-in did not finish. Try again.' } : {});
  const [busy, setBusy] = useState(false);
  const [rejected, setRejected] = useState(false);
  const forgot = `/forgot-password${EMAIL.test(email.trim()) ? `?email=${encodeURIComponent(email.trim())}` : ''}`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    if (!EMAIL.test(email.trim())) next.email = 'Enter a valid email address.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const { error } = await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    setRejected(error?.code === 'INVALID_EMAIL_OR_PASSWORD');
    if (error) setErrors(serverErrors(error));
    else void navigate('/', { replace: true });
  }

  return <AuthShell title="Sign in" lede="Welcome back. Sign in to your workspace." footer={<>No account? <Link to="/sign-up" className="font-semibold underline" style={{ color: 'var(--cb-accent)' }}>Create one</Link></>}>
    <FormAlert text={errors.form ?? (params.get('reset') ? 'Password updated. Sign in with your new password.' : undefined)} />
    {/* Same line for every rejected sign-in, so it never reveals which emails have an account. */}
    {rejected && <p role="status" className="mb-4 rounded-lg border px-3 py-2 text-[14px]" style={{ borderColor: 'var(--cb-accent)', color: 'var(--cb-ink)', background: 'var(--cb-bg)' }}>Had an account before November 2026? <Link to={forgot} className="font-semibold underline" style={{ color: 'var(--cb-accent)' }}>Set a new password</Link> and your files will be right where you left them.</p>}
    <GoogleButton onError={(form) => setErrors({ form })} />
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4" aria-busy={busy}>
      <Input id="sign-in-email" label="Email" type="email" autoComplete="email" className="h-11 text-base!" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      <Input id="sign-in-password" label="Password" type="password" autoComplete="current-password" className="h-11 text-base!" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
      <Button type="submit" size="lg" className="w-full" isLoading={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
      <p className="text-center text-[14px]"><Link to={forgot} className="underline" style={{ color: 'var(--cb-accent)' }}>Forgot password?</Link></p>
    </form>
  </AuthShell>;
}

export function SignUpPage() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const next: Errors = {};
    if (!name.trim()) next.name = 'Enter your name.';
    if (!EMAIL.test(email.trim())) next.email = 'Enter a valid email address.';
    if (password.length < 8) next.password = 'Use at least 8 characters.';
    setErrors(next);
    if (Object.keys(next).length) return;
    setBusy(true);
    const { error } = await authClient.signUp.email({ name: name.trim(), email: email.trim(), password });
    setBusy(false);
    if (error) setErrors(serverErrors(error));
    else void navigate('/', { replace: true });
  }

  return <AuthShell title="Create your account" lede="Share files, pages and links, and see who opens them." footer={<>Already have an account? <Link to="/sign-in" className="font-semibold underline" style={{ color: 'var(--cb-accent)' }}>Sign in</Link></>}>
    <FormAlert text={errors.form} />
    <GoogleButton onError={(form) => setErrors({ form })} />
    <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4" aria-busy={busy}>
      <Input id="sign-up-name" label="Name" autoComplete="name" className="h-11 text-base!" value={name} onChange={(e) => setName(e.target.value)} error={errors.name} />
      <Input id="sign-up-email" label="Email" type="email" autoComplete="email" className="h-11 text-base!" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
      <Input id="sign-up-password" label="Password" type="password" autoComplete="new-password" className="h-11 text-base!" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} helperText="At least 8 characters." />
      <Button type="submit" size="lg" className="w-full" isLoading={busy}>{busy ? 'Creating account…' : 'Create account'}</Button>
    </form>
  </AuthShell>;
}

const backToSignIn = <><Link to="/sign-in" className="font-semibold underline" style={{ color: 'var(--cb-accent)' }}>Back to sign in</Link></>;

export function ForgotPasswordPage() {
  const [params] = useSearchParams();
  const [email, setEmail] = useState(params.get('email') ?? '');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!EMAIL.test(email.trim())) return setErrors({ email: 'Enter a valid email address.' });
    setErrors({});
    setBusy(true);
    const { error } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: `${window.location.origin}/reset-password` });
    setBusy(false);
    if (error) setErrors(serverErrors(error));
    else setSentTo(email.trim());
  }

  return <AuthShell title="Set a new password" lede="Enter the email you use for ChampBeam. We will send you a link." footer={backToSignIn}>
    <FormAlert text={errors.form} />
    {sentTo
      ? <p role="status" className="text-[15px]" style={{ color: 'var(--cb-ink)' }}>If <span className="font-mono">{sentTo}</span> has an account, a link is on its way. It works for one hour. Check your junk folder too.</p>
      : <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4" aria-busy={busy}>
          <Input id="forgot-email" label="Email" type="email" autoComplete="email" className="h-11 text-base!" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
          <Button type="submit" size="lg" className="w-full" isLoading={busy}>{busy ? 'Sending…' : 'Email me a link'}</Button>
        </form>}
  </AuthShell>;
}

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>(token && !params.get('error') ? {} : serverErrors({ code: 'INVALID_TOKEN' }));
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) return setErrors({ password: 'Use at least 8 characters.' });
    setBusy(true);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token ?? '' });
    setBusy(false);
    if (error) setErrors(serverErrors(error));
    else void navigate('/sign-in?reset=1', { replace: true });
  }

  return <AuthShell title="Choose a new password" lede="Your files, pages and links stay exactly as they were." footer={backToSignIn}>
    <FormAlert text={errors.form} />
    {token && !params.get('error')
      ? <form noValidate onSubmit={(e) => void submit(e)} className="space-y-4" aria-busy={busy}>
          <Input id="reset-password" label="New password" type="password" autoComplete="new-password" className="h-11 text-base!" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password} />
          <Button type="submit" size="lg" className="w-full" isLoading={busy}>{busy ? 'Saving…' : 'Save password'}</Button>
        </form>
      : <p className="text-[15px]"><Link to="/forgot-password" className="font-semibold underline" style={{ color: 'var(--cb-accent)' }}>Request a new link</Link></p>}
  </AuthShell>;
}
