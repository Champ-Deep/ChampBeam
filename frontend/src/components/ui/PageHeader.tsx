import type { ReactNode } from 'react';

// One header for every workspace page. Layout follows 21st.dev
// olewandowski1 "Search Toolbar Page Header" (13442 / 26793): title and lede at
// left, the page's one primary action at right, an optional toolbar row below.
export function PageHeader({ title, lede, actions, children }: { title: string; lede?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <header className="cb-page-header">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1>{title}</h1>
          {lede && <p className="cb-lede">{lede}</p>}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-5 flex flex-wrap items-center gap-3">{children}</div>}
    </header>
  );
}
