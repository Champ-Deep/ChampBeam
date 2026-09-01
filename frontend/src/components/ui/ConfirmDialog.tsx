import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from './Button';

/**
 * App-wide replacement for `window.confirm`: a promise-returning, accessible
 * confirm dialog (focus-trapped, Escape/Enter, labelled) rendered once at the
 * root. Call sites stay one line: `if (!(await confirm({ message }))) return;`.
 */

export interface ConfirmOptions {
  message: string;
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style the confirm button as destructive (default true — most confirms delete something). */
  destructive?: boolean;
}

type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

interface Pending {
  options: Required<Omit<ConfirmOptions, 'title'>> & { title?: string };
  resolve: (ok: boolean) => void;
}

function normalize(options: ConfirmOptions | string): Pending['options'] {
  const o = typeof options === 'string' ? { message: options } : options;
  return {
    message: o.message,
    title: o.title,
    confirmLabel: o.confirmLabel ?? 'Confirm',
    cancelLabel: o.cancelLabel ?? 'Cancel',
    destructive: o.destructive ?? true,
  };
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      previouslyFocused.current = document.activeElement;
      setPending({ options: normalize(options), resolve });
    });
  }, []);

  const settle = useCallback(
    (ok: boolean) => {
      setPending((current) => {
        current?.resolve(ok);
        return null;
      });
      const el = previouslyFocused.current;
      if (el instanceof HTMLElement) el.focus();
    },
    [],
  );

  useEffect(() => {
    if (!pending) return;
    confirmButton.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/40 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) settle(false);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="cb-confirm-title"
            aria-describedby="cb-confirm-message"
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-5 shadow-xl"
          >
            <h2 id="cb-confirm-title" className="text-base font-semibold text-slate-900">
              {pending.options.title ?? 'Are you sure?'}
            </h2>
            <p id="cb-confirm-message" className="mt-2 whitespace-pre-line text-sm text-slate-600">
              {pending.options.message}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => settle(false)}>
                {pending.options.cancelLabel}
              </Button>
              <Button
                ref={confirmButton}
                size="sm"
                onClick={() => settle(true)}
                className={pending.options.destructive ? 'bg-red-600 text-white hover:bg-red-700' : undefined}
              >
                {pending.options.confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}

/** `const confirm = useConfirm(); if (!(await confirm('Delete this?'))) return;` */
export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used inside <ConfirmProvider>');
  }
  return ctx;
}
