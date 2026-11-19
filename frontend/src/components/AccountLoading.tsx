import { useEffect, useState } from 'react';
import { Logo } from './ui/Logo';
import './account-loading.css';

// Adapted from cnippet-dev Sidebar Dashboard Skeleton, 21st.dev 19009.
export function AccountLoading() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 12_000);
    return () => window.clearTimeout(timer);
  }, []);

  return <main className="beam-account-loading" data-testid="account-skeleton" aria-busy="true">
    <aside className="beam-loading-rail" aria-hidden="true">
      <Logo tone="dark" />
      <div className="beam-loading-nav">{[76, 58, 64, 46, 70, 52, 60].map((width) => <div key={width} className="beam-loading-line" style={{ width: `${width}%` }} />)}</div>
      <div className="beam-loading-avatar" />
    </aside>
    <div className="beam-loading-main">
      <header aria-hidden="true"><Logo tone="dark" size={30} /><span className="beam-loading-square" /></header>
      <div className="cb-workspace">
        <div className="beam-share-hero" aria-hidden="true">
          <p className="beam-eyebrow beam-loading-copy">Send something worth opening</p>
          <div className="beam-loading-title beam-loading-copy">Your next share starts here.</div>
          <p className="beam-share-lede beam-loading-copy">A file to keep. A page to explore. One link to see what happens next.</p>
          <div className="cb-panel cb-composer beam-loading-composer"><div className="beam-loading-line" /><div className="beam-loading-line" /></div>
        </div>
        <p role="status" aria-live="polite" className="sr-only">{slow ? 'Taking longer than expected.' : 'Loading account...'}</p>
        {slow && <div className="beam-loading-recovery">
          <p>Your session has not finished loading. Try reloading, or return to sign in.</p>
          <button type="button" onClick={() => window.location.reload()}>Reload page</button>
          <a href="/sign-in">Go to sign in</a>
        </div>}
        <div aria-hidden="true" className="beam-loading-rows">{[0, 1, 2].map((i) => <div key={i}><span className="beam-loading-square" /><span className="beam-loading-line" /><span className="beam-loading-line" /></div>)}</div>
      </div>
    </div>
  </main>;
}
