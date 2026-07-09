import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearanceSettings } from './AppearanceSettings';

// sonner's toast writes to a portal; stub it so the component test stays focused
// on the picker behaviour (and doesn't need a mounted <Toaster/>).
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

// TEST IDs map to docs/TESTING.md § Themes.
describe('AppearanceSettings picker', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-cb-theme');
  });

  // THM-9: renders exactly the three primary theme cards.
  it('THM-9 renders Paper, Graphite and Lagoon cards', () => {
    render(<AppearanceSettings />);
    expect(screen.getByText('Paper')).toBeInTheDocument();
    expect(screen.getByText('Graphite')).toBeInTheDocument();
    expect(screen.getByText('Lagoon')).toBeInTheDocument();
    // Paper carries the "default" tag.
    expect(screen.getByText('default')).toBeInTheDocument();
  });

  // THM-10: clicking a card applies + persists that theme (the live switch).
  it('THM-10 clicking Graphite applies and persists it', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByText('Graphite'));
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('graphite');
    expect(localStorage.getItem('champbeam_theme')).toBe('graphite');

    fireEvent.click(screen.getByText('Lagoon'));
    expect(document.documentElement.getAttribute('data-cb-theme')).toBe('lagoon');
    expect(localStorage.getItem('champbeam_theme')).toBe('lagoon');
  });
});
