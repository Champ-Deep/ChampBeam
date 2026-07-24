import { clsx } from 'clsx';

interface LogoMarkProps {
  /** Pixel size of the SVG glyph. */
  size?: number;
  /** Stroke/fill colour for the beam. Defaults to white (for the dark sidebar). */
  color?: string;
  className?: string;
}

// The "Beam orbit" mark chosen in App v2: a solid core with two concentric
// arcs radiating out — the beam being seen from more places over time.
export function LogoMark({ size = 20, color = '#fff', className }: LogoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="2.8" fill={color} />
      <path d="M12 6.6a5.4 5.4 0 0 1 0 10.8" stroke={color} strokeWidth="2.1" strokeLinecap="round" />
      <path d="M12 20.4a8.4 8.4 0 0 1 0-16.8" stroke={color} strokeWidth="2.1" strokeLinecap="round" opacity=".5" />
    </svg>
  );
}

interface LogoProps {
  /** Render the wordmark next to the mark. */
  withWordmark?: boolean;
  /** 'dark' tints for a dark surface (sidebar); 'light' for a light surface. */
  tone?: 'dark' | 'light';
  size?: number;
  className?: string;
}

// Full lockup: terracotta rounded tile holding the orbit mark, plus the
// "Champbeam" wordmark in the display face.
export function Logo({ withWordmark = true, tone = 'dark', size = 36, className }: LogoProps) {
  const wordmarkColor = tone === 'dark' ? '#fff' : 'var(--cb-ink)';
  return (
    <div className={clsx('flex items-center gap-2.5', className)}>
      <div
        className="flex items-center justify-center rounded-[10px]"
        style={{
          width: size,
          height: size,
          background: 'var(--cb-accent)',
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,.1)',
        }}
      >
        <LogoMark size={Math.round(size * 0.56)} color="#fff" />
      </div>
      {withWordmark && (
        <span
          className="font-display font-bold text-[19px] tracking-tight"
          style={{ color: wordmarkColor }}
        >
          Champ<span style={{ color: 'var(--cb-accent-light)' }}>beam</span>
        </span>
      )}
    </div>
  );
}
