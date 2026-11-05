/**
 * LumeSec Elements: device-pixel-ratio aware canvas sizing for the native React components, snapping to device pixels
 * and pointer positions in a component's own CSS pixels.
 * Importing this module touches nothing in the browser; the hook starts its work in an effect.
 */
import * as React from "react";

/** A canvas sized to its CSS box. `context` is pre-scaled, so draw in CSS pixels. */
export interface CanvasSurface {
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  /** CSS width in pixels. */
  width: number;
  /** CSS height in pixels. */
  height: number;
  /** Device pixel ratio used for the backing store (capped at 3, or at `maxDpr`). */
  dpr: number;
}

/** Options of sizeCanvas and useCanvas. */
export interface CanvasOptions {
  /**
   * Highest device pixel ratio for the backing store. Default 3. Large maps and globes pass 2, which keeps them sharp
   * while drawing up to 2.25 times fewer pixels on 3x screens.
   */
  maxDpr?: number;
}

/** Size a canvas's backing store to its CSS box at the device pixel ratio. Returns null when hidden. */
export function sizeCanvas(canvas: HTMLCanvasElement, options: CanvasOptions = {}): CanvasSurface | null {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, options.maxDpr ?? 3);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, context, width, height, dpr };
}

/**
 * Calls `onChange` whenever the device pixel ratio changes: browser zoom, or the window moving to a screen with
 * another density. A canvas whose CSS size stays the same gets no resize event then, so it would stay blurry.
 * Returns an unsubscribe function. Browser only.
 */
export function onPixelRatioChange(onChange: () => void): () => void {
  let query: MediaQueryList | null = null;
  const listen = () => {
    // the query matches the current ratio only, so it fires once on the next change and is then replaced
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    query.addEventListener("change", handleChange, { once: true });
  };
  const handleChange = () => {
    listen();
    onChange();
  };
  listen();
  return () => query?.removeEventListener("change", handleChange);
}

/**
 * Keeps a canvas sized to its box and to the device pixel ratio. Returns a ref to the current surface (null until
 * mounted and laid out). `onResize` runs after every resize, for layout that depends on the size.
 * `options.maxDpr` caps the pixel ratio.
 */
export function useCanvas(
  ref: React.RefObject<HTMLCanvasElement | null>,
  onResize?: (surface: CanvasSurface) => void,
  options: CanvasOptions = {},
) {
  const maxDpr = options.maxDpr ?? 3;
  const surface = React.useRef<CanvasSurface | null>(null);
  const resized = React.useRef(onResize);
  React.useEffect(() => {
    resized.current = onResize;
  });
  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const update = () => {
      surface.current = sizeCanvas(canvas, { maxDpr });
      if (surface.current) resized.current?.(surface.current);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    const stopWatchingRatio = onPixelRatioChange(update);
    return () => {
      observer.disconnect();
      stopWatchingRatio();
    };
  }, [ref, maxDpr]);
  return surface;
}

/** Round to the device pixel grid, so 1px marks stay sharp. */
export const snap = (value: number, dpr: number) => Math.round(value * dpr) / dpr;

/** A length rounded to whole device pixels, at least one, so a small square keeps its size wherever it lands. */
export const snapSize = (size: number, dpr: number) => Math.max(1, Math.round(size * dpr)) / dpr;

/**
 * The centre that puts the corner of a `size` square on the device pixel grid, for dot renderers that take centres
 * (such as `DotBatch` in `geo`). Pass a `size` that is already whole device pixels, or the far edges blur.
 */
export const snapCenter = (value: number, size: number, dpr: number) =>
  Math.round((value - size / 2) * dpr) / dpr + size / 2;

/** Fill a `size` CSS px square centred on (x, y), its size and corner snapped to device pixels so it stays crisp. */
export function fillSquare(context: CanvasRenderingContext2D, x: number, y: number, size: number, dpr: number) {
  const s = snapSize(size, dpr);
  context.fillRect(snap(x - s / 2, dpr), snap(y - s / 2, dpr), s, s);
}

/**
 * A pointer position in `element`'s own CSS px, from the top-left corner of its border box. CSS zoom or a scale
 * transform on an ancestor (a gallery card that shrinks its demo) scales client coordinates but not layout sizes, so
 * the client offset is divided by that scale. Browser only: call it from event handlers.
 */
export function localPoint(element: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const scaleX = rect.width ? element.offsetWidth / rect.width : 1;
  const scaleY = rect.height ? element.offsetHeight / rect.height : 1;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

/** Path a rounded rectangle (falls back to a plain rectangle where roundRect is missing). */
export function roundRectPath(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  context.beginPath();
  if (typeof context.roundRect === "function") context.roundRect(x, y, width, height, radius);
  else context.rect(x, y, width, height);
}
