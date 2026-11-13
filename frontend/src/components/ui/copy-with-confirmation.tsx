import * as React from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Copy button that confirms in place, then reverts. Installed from 21st.dev "Copy With Confirmation"
 * (id 36536, ibrandify/copy-with-confirmation) and rebuilt on ChampBeam tokens. When the clipboard is
 * blocked it shows the text in a selected read-only field so it can still be copied by hand.
 */
export function CopyButton({ text, label = 'Copy', copiedLabel = 'Copied', className = '', compact = false }: {
  text: string; label?: string; copiedLabel?: string; className?: string; compact?: boolean;
}) {
  const [state, setState] = React.useState<'idle' | 'copied' | 'manual'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const manual = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => () => clearTimeout(timer.current), []);
  React.useEffect(() => { if (state === 'manual') manual.current?.select(); }, [state]);

  async function copy() {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      timer.current = setTimeout(() => setState('idle'), 1800);
    } catch {
      setState('manual');
    }
  }

  const copied = state === 'copied';
  return <span className={`cb-copy ${className}`}>
    <button type="button" onClick={() => void copy()} className="cb-copy-btn" data-copied={copied || undefined} aria-label={compact ? (copied ? copiedLabel : label) : undefined}>
      <span className="cb-copy-icon" aria-hidden="true">
        <Copy className="cb-copy-a h-4 w-4" />
        <Check className="cb-copy-b h-4 w-4" />
      </span>
      {!compact && <span>{copied ? copiedLabel : label}</span>}
    </button>
    <span role="status" className="sr-only">{copied ? copiedLabel : ''}</span>
    {state === 'manual' && <label className="cb-copy-manual">Copy is blocked in this browser. Select the text and copy it:
      <textarea ref={manual} readOnly value={text} rows={Math.min(6, text.split('\n').length + 1)} />
    </label>}
  </span>;
}

export default CopyButton;
