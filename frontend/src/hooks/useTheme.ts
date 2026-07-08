import { useCallback, useEffect, useState } from 'react';

// Workspace themes shipped in App v2. Paper is the Champbeam default; the rest
// are opt-in from Settings → Appearance. The value is stamped on <html> as
// data-cb-theme, which flips the --cb-* token set defined in index.css.
export const THEMES = ['paper', 'graphite', 'lagoon', 'merlot', 'slate'] as const;
export type ThemeName = (typeof THEMES)[number];

export const THEME_META: Record<ThemeName, { label: string; desc: string }> = {
  paper: { label: 'Paper', desc: 'Warm paper & terracotta' },
  graphite: { label: 'Graphite', desc: 'Neutral ink, one quiet signal' },
  lagoon: { label: 'Lagoon', desc: 'Deep teal on cool grey' },
  merlot: { label: 'Merlot', desc: 'Wine red on warm neutral' },
  slate: { label: 'Slate', desc: 'Cool blue-grey ink' },
};

// The three themes surfaced in the Appearance picker (the others stay available
// via saved value / URL but aren't front-and-centre, matching the design).
export const PRIMARY_THEMES: ThemeName[] = ['paper', 'graphite', 'lagoon'];

const STORAGE_KEY = 'champbeam_theme';
const DEFAULT_THEME: ThemeName = 'paper';

function isTheme(v: unknown): v is ThemeName {
  return typeof v === 'string' && (THEMES as readonly string[]).includes(v);
}

function readStored(): ThemeName {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (isTheme(v)) return v;
  } catch {
    /* localStorage unavailable (private mode / SSR) — fall back to default */
  }
  return DEFAULT_THEME;
}

export function applyTheme(theme: ThemeName) {
  document.documentElement.setAttribute('data-cb-theme', theme);
}

// Applied once at module load so the very first paint is themed (no flash of
// the wrong palette while React mounts).
if (typeof document !== 'undefined') {
  applyTheme(readStored());
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeName>(() => readStored());

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore persistence failures */
    }
  }, []);

  return { theme, setTheme };
}
