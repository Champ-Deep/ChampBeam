import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { Logo } from './ui/Logo';

// Adapted from cnippet-dev Inline Loading Status, 21st.dev demo 19001.
export function AccountLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <main className="grid min-h-screen place-items-center px-6 py-12" style={{ background: 'var(--cb-bg)', color: 'var(--cb-ink)' }}>
      <section className="w-full max-w-sm">
        <Logo tone="light" />
        <h1 className="mt-8 font-display text-3xl font-semibold tracking-tight">Opening your workspace</h1>
        <div role="status" aria-live="polite" className="mt-4 flex items-center gap-3 text-base" style={{ color: 'var(--cb-muted)' }}>
          <LoaderCircle aria-hidden="true" className="h-5 w-5 shrink-0 motion-safe:animate-spin" />
          <span>{slow ? 'Taking longer than expected.' : 'Loading account...'}</span>
        </div>
        <p className="mt-3 text-base leading-relaxed" style={{ color: 'var(--cb-muted)' }}>
          {slow ? 'Your session has not finished loading. Try reloading, or return to sign in.' : 'Checking your session for Files and Pages.'}
        </p>
        {slow && <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={() => window.location.reload()} className="min-h-11 rounded-md px-4 font-semibold focus-visible:outline-2 focus-visible:outline-offset-4" style={{ background: 'var(--cb-ink)', color: 'var(--cb-surface)' }}>Reload page</button>
          <a href="/sign-in" className="flex min-h-11 items-center rounded-md px-4 font-semibold underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4">Go to sign in</a>
        </div>}
      </section>
    </main>
  );
}
