import { Check } from 'lucide-react';
import { toast } from 'sonner';
import { PRIMARY_THEMES, THEME_META, useTheme, type ThemeName } from '../hooks/useTheme';

// Representative colours for each theme's mini-preview, so a card shows its own
// palette regardless of which theme is currently active.
const SWATCH: Record<ThemeName, { side: string; bg: string; accent: string; line: string }> = {
  paper: { side: '#241A10', bg: '#FBF8F2', accent: '#B3502F', line: '#DFD6C6' },
  graphite: { side: '#131515', bg: '#FAFAF9', accent: '#2F3437', line: '#DCDCDA' },
  lagoon: { side: '#0A1E21', bg: '#F9FAFA', accent: '#0E5B63', line: '#D9E2E2' },
  merlot: { side: '#1E1013', bg: '#FAF9F9', accent: '#7C3644', line: '#E0D8DA' },
  slate: { side: '#10151C', bg: '#F9FAFB', accent: '#3D4E63', line: '#DBE0E6' },
};

function ThemeCard({
  name,
  active,
  onSelect,
}: {
  name: ThemeName;
  active: boolean;
  onSelect: () => void;
}) {
  const sw = SWATCH[name];
  const meta = THEME_META[name];
  return (
    <button
      type="button"
      onClick={onSelect}
      className="rounded-2xl p-2.5 text-left transition-shadow"
      style={{
        border: active ? '1.5px solid var(--cb-accent)' : '1.5px solid var(--cb-border)',
        boxShadow: active ? '0 0 0 3px rgba(var(--cb-accent-rgb),.12)' : 'none',
      }}
    >
      {/* Mini app preview: dark rail + content with an accent bar and lines. */}
      <div
        className="flex h-24 overflow-hidden rounded-xl"
        style={{ border: '1px solid var(--cb-border)' }}
      >
        <div style={{ width: '22%', background: sw.side }} />
        <div className="flex flex-1 flex-col gap-1.5 p-2.5" style={{ background: sw.bg }}>
          <span style={{ width: 34, height: 9, borderRadius: 4, background: sw.accent }} />
          <span style={{ width: 52, height: 6, borderRadius: 3, background: sw.line }} />
          <span style={{ width: 44, height: 6, borderRadius: 3, background: sw.line }} />
          <span style={{ width: 30, height: 6, borderRadius: 3, background: sw.line }} />
        </div>
      </div>

      <div className="mt-2.5 flex items-center justify-between px-1">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-display text-sm font-bold" style={{ color: 'var(--cb-ink)' }}>
              {meta.label}
            </span>
            {name === 'paper' && (
              <span
                className="rounded px-1.5 py-0.5 text-[10px] font-bold"
                style={{ color: 'var(--cb-accent)', background: 'var(--cb-accent-soft)' }}
              >
                default
              </span>
            )}
          </div>
          <div className="text-[12px]" style={{ color: 'var(--cb-muted)' }}>
            {meta.desc}
          </div>
        </div>
        <span
          className="flex h-[18px] w-[18px] flex-shrink-0 items-center justify-center rounded-full"
          style={{
            background: active ? 'var(--cb-accent)' : '#fff',
            border: active ? 'none' : '1.5px solid var(--cb-border-strong)',
          }}
        >
          {active && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
        </span>
      </div>
    </button>
  );
}

export function AppearanceSettings() {
  const { theme, setTheme } = useTheme();

  const choose = (t: ThemeName) => {
    setTheme(t);
    toast.success(`${THEME_META[t].label} theme applied`);
  };

  return (
    <div
      className="rounded-2xl bg-white p-6"
      style={{ border: '1px solid var(--cb-border)' }}
    >
      <h3 className="font-display text-base font-semibold" style={{ color: 'var(--cb-ink)' }}>
        Workspace theme
      </h3>
      <p className="mt-1 mb-5 text-sm" style={{ color: 'var(--cb-muted)' }}>
        Paper is the Champbeam default. Pick the look that fits your workspace — it applies across
        the whole app and is remembered on this device.
      </p>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PRIMARY_THEMES.map((name) => (
          <ThemeCard
            key={name}
            name={name}
            active={theme === name}
            onSelect={() => choose(name)}
          />
        ))}
      </div>
    </div>
  );
}
