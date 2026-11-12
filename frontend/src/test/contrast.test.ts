import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Brief 7.2: every palette keeps text, control and status pairs at WCAG AA.
const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');

function block(selector: RegExp): Record<string, string> {
  const m = css.match(selector);
  if (!m) throw new Error(`block not found: ${selector}`);
  return Object.fromEntries([...m[1].matchAll(/--cb-([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((x) => [x[1], x[2]]));
}

const shared = block(/\/\* Shared by all five palettes[^*]*\*\/\s*:root \{([^}]*)\}/);
const paper = block(/:root,\s*:root\[data-cb-theme="paper"\] \{([^}]*)\}/);
const palettes: Record<string, Record<string, string>> = { paper: { ...shared, ...paper } };
for (const name of ['graphite', 'lagoon', 'merlot', 'slate']) {
  palettes[name] = { ...shared, ...block(new RegExp(`:root\\[data-cb-theme="${name}"\\] \\{([^}]*)\\}`)) };
}

function lum(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string) {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const TEXT: [string, string][] = [
  ['ink', 'bg'], ['text', 'bg'], ['text-mid', 'bg'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'chip'],
  ['surface', 'accent'], ['accent', 'accent-soft'], ['side-text', 'side1'], ['side-text', 'side3'],
  ['success', 'success-soft'], ['success', 'surface'], ['warning', 'warning-soft'], ['warning', 'surface'],
  ['danger', 'danger-soft'], ['danger', 'surface'],
];
const CONTROL: [string, string][] = [['icon', 'bg'], ['icon', 'input'], ['icon', 'surface']];

describe('theme contrast', () => {
  for (const [name, t] of Object.entries(palettes)) {
    it(`${name}: text pairs reach 4.5 and control edges reach 3`, () => {
      for (const [fg, bg] of TEXT) expect(ratio(t[fg], t[bg]), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
      for (const [fg, bg] of CONTROL) expect(ratio(t[fg], t[bg]), `${name} ${fg} on ${bg}`).toBeGreaterThanOrEqual(3);
    });
  }
  it('fails the old Paper accent-soft and passes the new one', () => {
    expect(ratio('#B3502F', '#F8ECE5')).toBeLessThan(4.5);
    expect(ratio(palettes.paper.accent, palettes.paper['accent-soft'])).toBeGreaterThanOrEqual(4.5);
  });
});
