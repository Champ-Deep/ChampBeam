import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  THEMES,
  PRIMARY_THEMES,
  THEME_META,
  applyTheme,
  useTheme,
  type ThemeName,
} from './useTheme';

// TEST IDs map to docs/TESTING.md § Themes.
describe('theme system', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-cb-theme');
  });

  // THM-1: the five App v2 workspace themes exist, Paper first.
  it('THM-1 exposes all five themes with Paper as the default/first', () => {
    expect(THEMES).toEqual(['paper', 'graphite', 'lagoon', 'merlot', 'slate']);
    expect(THEMES[0]).toBe('paper');
    THEMES.forEach((t) => {
      expect(THEME_META[t].label).toBeTruthy();
      expect(THEME_META[t].desc).toBeTruthy();
    });
  });

  // THM-2: the Appearance picker surfaces exactly Paper / Graphite / Lagoon.
  it('THM-2 surfaces Paper, Graphite, Lagoon in the primary picker', () => {
    expect(PRIMARY_THEMES).toEqual(['paper', 'graphite', 'lagoon']);
  });

  // THM-3: applyTheme stamps data-cb-theme on <html>, which flips the tokens.
  it('THM-3 applyTheme stamps data-cb-theme on <html>', () => {
    applyTheme('lagoon');
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('lagoon');
    applyTheme('graphite');
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('graphite');
  });

  // THM-4: with nothing stored, the hook resolves to Paper.
  it('THM-4 defaults to Paper when no theme is stored', () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('paper');
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('paper');
  });

  // THM-5: setTheme persists to localStorage AND updates the attribute.
  it('THM-5 setTheme persists the choice and applies it', () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme('graphite'));
    expect(result.current.theme).toBe('graphite');
    expect(localStorage.getItem('champbeam_theme')).toBe('graphite');
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('graphite');
  });

  // THM-6: a persisted theme is restored on the next mount (survives reload).
  it('THM-6 restores a persisted theme on remount', () => {
    localStorage.setItem('champbeam_theme', 'lagoon');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('lagoon');
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('lagoon');
  });

  // THM-7: a corrupt/unknown stored value falls back to Paper (no crash).
  it('THM-7 falls back to Paper for an unknown stored value', () => {
    localStorage.setItem('champbeam_theme', 'not-a-theme');
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe('paper');
  });

  // THM-8: every theme id is applyable and round-trips through the attribute.
  it('THM-8 every theme id round-trips through the attribute', () => {
    (THEMES as readonly ThemeName[]).forEach((t) => {
      applyTheme(t);
      expect(document.documentElement.getAttribute('data-cb-theme')).toBe(t);
    });
  });
});
