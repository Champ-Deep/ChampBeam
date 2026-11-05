import { useState } from 'react';
import { X } from 'lucide-react';
import { Button } from './ui/Button';

export function AnnouncementBanner() {
  const text = (import.meta.env.VITE_ANNOUNCEMENT as string | undefined)?.trim() ?? '';
  // FNV-1a identifies the copy, not a security-sensitive value.
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  const storageKey = `cb-announcement:${(hash >>> 0).toString(16)}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(storageKey) === text;
    } catch {
      return false;
    }
  });

  if (!text || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    try {
      localStorage.setItem(storageKey, text);
    } catch {
      // Dismiss for this visit even when storage is blocked or full.
    }
  }

  return (
    <section aria-label="Announcement" style={{ background: 'var(--cb-accent)' }}>
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2 sm:px-6 lg:px-8">
        <p className="min-w-0 flex-1 break-words text-sm leading-6" style={{ color: 'var(--cb-bg)' }}>
          {text}
        </p>
        <Button
          type="button"
          aria-label="Dismiss announcement"
          onClick={dismiss}
          className="shrink-0 focus:ring-cb-bg focus:ring-offset-0"
          style={{ color: 'var(--cb-bg)', minHeight: 44, minWidth: 44, padding: 0 }}
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>
    </section>
  );
}
