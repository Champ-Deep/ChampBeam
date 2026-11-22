/**
 * LumeSec Elements: small math and colour helpers shared by the native React components. Pure; safe on the server.
 */

/** An sRGB colour as `[red, green, blue]`, each 0 to 255. */
export type RGB = [number, number, number];

/** A full turn in radians. */
export const TAU = Math.PI * 2;

/** `value` limited to `[min, max]`. */
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** Linear interpolation from `from` to `to`; `t` is not clamped. */
export const lerp = (from: number, to: number, t: number) => from + (to - from) * t;

/** Random number in `[min, max)`. */
export const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Hermite smoothstep of `x` between `edge0` and `edge1`. */
export function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Cubic ease-out on `[0, 1]`. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/** Deterministic pseudo-random value in `[0, 1)` for a number, for stable flicker and jitter. */
export function hash(n: number) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** FNV-1a hash of a string, for stable per-name variation (avatars, identicons). */
export function stringHash(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Linear mix of two RGB colours. */
export const mixRgb = (a: RGB, b: RGB, t: number): RGB => [
  lerp(a[0], b[0], t),
  lerp(a[1], b[1], t),
  lerp(a[2], b[2], t),
];

/** CSS colour string for an RGB colour, with optional alpha. */
export function rgba(color: RGB, alpha?: number) {
  const [r, g, b] = color.map((v) => Math.round(clamp(v, 0, 255)));
  return alpha === undefined ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${alpha})`;
}

/** HSL (hue in degrees, saturation and lightness 0 to 1) to RGB. */
export function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const h = (((hue % 360) + 360) % 360) / 360;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n: number) => {
    const k = (n + h * 12) % 12;
    return (lightness - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [channel(0), channel(8), channel(4)];
}

/** `#rrggbb` for an RGB colour. */
export const rgbToHex = (color: RGB) =>
  `#${color
    .map((v) =>
      Math.round(clamp(v, 0, 255))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/**
 * A fraction as a CSS percentage with three decimals (`0.25` gives `"25.000%"`). Positions computed during render go
 * into the markup through it, so the server and the browser print the same string and hydration matches.
 */
export const percent = (fraction: number) => `${(fraction * 100).toFixed(3)}%`;

/** Perceived lightness of a colour, 0 (black) to 1 (white). */
export const luminance = (color: RGB) => (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255;
