// Adapted from ncdai Copy Button, 21st.dev demo 28469. Audio and haptics intentionally removed.
import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'done' | 'error';
export type UseCopyToClipboardOptions = {
  onCopySuccess?: (text: string) => void;
  onCopyError?: (error: Error) => void;
  resetDelay?: number;
};

export function useCopyToClipboard({ onCopySuccess, onCopyError, resetDelay = 2000 }: UseCopyToClipboardOptions = {}) {
  const [state, setState] = useState<CopyState>('idle');
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);
  const copy = useCallback(async (text: string | (() => string)) => {
    if (timeout.current) clearTimeout(timeout.current);
    try {
      const value = typeof text === 'function' ? text() : text;
      await navigator.clipboard.writeText(value);
      setState('done');
      onCopySuccess?.(value);
    } catch (error) {
      setState('error');
      onCopyError?.(error instanceof Error ? error : new Error('Copy failed'));
    } finally {
      timeout.current = setTimeout(() => setState('idle'), resetDelay);
    }
  }, [onCopySuccess, onCopyError, resetDelay]);
  return { state, copy } as const;
}
