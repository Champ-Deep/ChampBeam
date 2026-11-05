/**
 * LumeSec Elements: theme-aware colours for canvas drawing.
 *
 * Canvas code cannot use CSS variables directly, so components resolve the theme tokens they need into
 * RGB and re-read them when the theme changes. Resolution goes through a 1x1 canvas, so any CSS colour
 * works: hex, `rgb()`, `oklch()` (shadcn's default), `color-mix()` and `var()` chains.
 * Importing this module touches nothing in the browser; work starts on the first call.
 */
import * as React from "react";

import { luminance, type RGB } from "@/components/ui/geo-traceroute-utils/math";

let probe: CanvasRenderingContext2D | null = null;
const cache = new Map<string, RGB>();

/** RGB for a CSS colour string. Unparseable values resolve to mid grey. Returns a fresh array on every call. */
export function parseColor(value: string): RGB {
  const key = value.trim();
  const hit = cache.get(key);
  // a copy, so a caller that changes the array cannot change the cached colour
  if (hit) return [hit[0], hit[1], hit[2]];
  if (typeof document === "undefined") return [128, 128, 128];
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!probe) return [128, 128, 128];
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "#808080";
  // the canvas ignores a colour it cannot parse, so the grey stays
  probe.fillStyle = key;
  probe.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0] = probe.getImageData(0, 0, 1, 1).data;
  if (cache.size > 256) cache.clear();
  cache.set(key, [r, g, b]);
  return [r, g, b];
}

/**
 * Resolve a colour for an element. `token` is a custom property (`"--lumesec"`) or any CSS colour;
 * `fallback` is used when the property is not set.
 */
export function readColor(element: Element, token: string, fallback = "#808080"): RGB {
  if (!token.startsWith("--")) return parseColor(token);
  const value = getComputedStyle(element).getPropertyValue(token).trim();
  return parseColor(value || fallback);
}

/** A theme token with the fallback used when the page does not define it. */
export type ColorToken = readonly [token: string, fallback: string];

/**
 * The colours most canvas components need. Each entry is a CSS variable from the shadcn theme or the
 * LumeSec accent tokens, with a light-theme fallback.
 */
export const THEME_TOKENS = {
  foreground: ["--foreground", "#09090b"],
  muted: ["--muted-foreground", "#71717b"],
  background: ["--background", "#ffffff"],
  card: ["--card", "#ffffff"],
  track: ["--muted", "#f4f4f5"],
  border: ["--border", "#e4e4e7"],
  destructive: ["--destructive", "#e5484d"],
  accent: ["--lumesec", "#6219f3"],
  accentForeground: ["--lumesec-foreground", "#fafafa"],
  accentSoft: ["--lumesec-soft", "#a685ff"],
  glint: ["--lumesec-glint", "#c9bdff"],
  shine: ["--lumesec-shine", "#3f12b0"],
  success: ["--lumesec-success", "#00a14b"],
  warning: ["--lumesec-warning", "#d97706"],
  info: ["--lumesec-info", "#1e40af"],
} as const satisfies Record<string, ColorToken>;

/** A colour name of {@link THEME_TOKENS}. */
export type ThemeColorName = keyof typeof THEME_TOKENS;

const KNOWN_FALLBACKS = new Map<string, string>(
  Object.values(THEME_TOKENS).map(([token, fallback]) => [token, fallback]),
);

/**
 * Resolve a theme variable (`"--lumesec"`) or a CSS colour on an element, using the documented fallback
 * when the variable is one of the theme tokens and the page does not define it.
 */
export const resolveColor = (element: Element, tokenOrColor: string): RGB =>
  readColor(element, tokenOrColor, KNOWN_FALLBACKS.get(tokenOrColor));

/** Resolved theme colours plus whether the surface is dark. */
export type Palette<K extends string = ThemeColorName> = Record<K, RGB> & { dark: boolean };

/** Resolve a set of tokens on an element. */
export function readPalette<K extends string>(element: Element, tokens: Record<K, ColorToken>): Palette<K> {
  const palette = {} as Record<K, RGB>;
  for (const key of Object.keys(tokens) as K[]) {
    const [token, fallback] = tokens[key];
    palette[key] = readColor(element, token, fallback);
  }
  const foreground = readColor(element, "--foreground", "#09090b");
  return Object.assign(palette, { dark: luminance(foreground) > 0.5 });
}

/* theme changes */

const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;

/** Observes the page for theme switches while anything is subscribed. */
function watchTheme(): () => void {
  const notify = () => listeners.forEach((listener) => listener());
  // shadcn toggles `.dark`; other setups use data-theme or inline style variables
  const observer = new MutationObserver(notify);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme", "data-cb-theme", "style"] });
  const scheme = window.matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", notify);
  return () => {
    observer.disconnect();
    scheme.removeEventListener("change", notify);
  };
}

/**
 * Subscribe to theme changes (`.dark` or `data-theme` on `<html>`, inline theme variables, the OS colour
 * scheme). Returns an unsubscribe function; the page observer stops with the last subscriber.
 */
export function onThemeChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.add(listener);
  stopWatching ??= watchTheme();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };
}

/**
 * Theme colours for the element behind `ref`, resolved after mount and again on every theme change.
 * Returns a ref so animation loops read the current palette without re-rendering. `tokens` defaults to
 * {@link THEME_TOKENS}; `onChange` runs after every read (typically the animation loop's `kick`).
 */
export function usePalette(
  ref: React.RefObject<Element | null>,
  tokens?: undefined,
  onChange?: () => void,
): React.RefObject<Palette | null>;
export function usePalette<K extends string>(
  ref: React.RefObject<Element | null>,
  tokens: Record<K, ColorToken>,
  onChange?: () => void,
): React.RefObject<Palette<K> | null>;
export function usePalette(
  ref: React.RefObject<Element | null>,
  tokens: Record<string, ColorToken> = THEME_TOKENS,
  onChange?: () => void,
): React.RefObject<unknown> {
  const palette = React.useRef<Palette<string> | null>(null);
  const latestTokens = React.useRef(tokens);
  const changed = React.useRef(onChange);
  React.useEffect(() => {
    latestTokens.current = tokens;
    changed.current = onChange;
  });
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      palette.current = readPalette(element, latestTokens.current);
      changed.current?.();
    };
    read();
    return onThemeChange(read);
  }, [ref]);
  return palette;
}
