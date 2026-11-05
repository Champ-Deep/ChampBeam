/* eslint-disable react-refresh/only-export-components -- Registry canvas helpers intentionally share this module. */
"use client";

/**
 * LumeSec Elements: square pixel sparks.
 *
 * `Sparks` draws particles inside a component's own canvas. `useBurst` and `BurstLayer` draw a one-off
 * burst on a throwaway canvas that reaches 40px past the component while the burst flies, so sparks can fly
 * over its edges.
 */
import * as React from "react";

import { resolveColor } from "@/components/ui/geo-traceroute-utils/color";
import { prefersReducedMotion } from "@/components/ui/geo-traceroute-utils/motion";
import { rand, rgba, TAU, type RGB } from "@/components/ui/geo-traceroute-utils/math";

/** How sparks are emitted. Ranges are `[min, max]`. */
export interface SparkOptions {
  /** Initial speed in px/s. */
  speed?: readonly [number, number];
  /** Lifetime in seconds. */
  life?: readonly [number, number];
  /** Centre direction in radians (0 is right, positive is down). */
  angle?: number;
  /** Cone width in radians around `angle`. `TAU` emits in every direction. */
  spread?: number;
  /** Square size in px: 70% of sparks use the first value, 30% the second. */
  size?: readonly [number, number];
  /** Downward acceleration in px/s². */
  gravity?: number;
  /** Exponential velocity damping per second. */
  drag?: number;
  /** Random offset of the emission point in px. */
  jitter?: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  size: number;
  /** The CSS colour, built once when the spark is emitted rather than on every frame. */
  fill: string;
  gravity: number;
  drag: number;
}

/** A particle list drawn into an existing canvas. Emitting is a no-op with reduced motion. */
export class Sparks {
  private list: Spark[] = [];

  /** Whether any spark is still alive. */
  get active() {
    return this.list.length > 0;
  }

  /** Emit `count` sparks at `(x, y)`, cycling through `colors`. */
  add(x: number, y: number, count: number, colors: readonly RGB[], options: SparkOptions = {}) {
    if (prefersReducedMotion() || colors.length === 0) return;
    const {
      speed = [40, 170],
      life = [0.3, 0.75],
      angle = 0,
      spread = TAU,
      size = [1.5, 2.5],
      gravity = 0,
      drag = 4,
      jitter = 2,
    } = options;
    const fills = colors.map((color) => rgba(color));
    for (let i = 0; i < count; i++) {
      const direction = angle + (Math.random() - 0.5) * spread;
      const velocity = rand(speed[0], speed[1]);
      this.list.push({
        x: x + rand(-jitter, jitter),
        y: y + rand(-jitter, jitter),
        vx: Math.cos(direction) * velocity,
        vy: Math.sin(direction) * velocity,
        age: 0,
        life: rand(life[0], life[1]),
        size: Math.random() < 0.3 ? size[1] : size[0],
        fill: (fills[i % fills.length] as string),
        gravity,
        drag,
      });
    }
  }

  /** Advance by `delta` seconds and draw. Returns whether sparks remain (keep animating). */
  step(context: CanvasRenderingContext2D, delta: number) {
    const list = this.list;
    if (list.length === 0) return false;
    // live sparks move to the front of the list in place, so a frame allocates nothing
    let alive = 0;
    let fill = "";
    for (let i = 0; i < list.length; i++) {
      const spark = (list[i] as Spark);
      spark.age += delta;
      const damping = Math.exp(-delta * spark.drag);
      spark.vx *= damping;
      spark.vy = spark.vy * damping + spark.gravity * delta;
      spark.x += spark.vx * delta;
      spark.y += spark.vy * delta;
      if (spark.age < spark.life) {
        context.globalAlpha = Math.pow(1 - spark.age / spark.life, 1.3);
        // the canvas parses the string on every assignment; single-colour bursts set it once per frame
        if (spark.fill !== fill) {
          fill = spark.fill;
          context.fillStyle = fill;
        }
        context.fillRect(spark.x, spark.y, spark.size, spark.size);
        list[alive++] = spark;
      }
    }
    list.length = alive;
    context.globalAlpha = 1;
    return alive > 0;
  }

  /** Remove every spark. */
  clear() {
    this.list = [];
  }
}

/** Options for a one-off burst. */
export interface BurstOptions extends SparkOptions {
  /** Number of sparks. Default 20. */
  count?: number;
  /** Theme variables or CSS colours to cycle through. Default the accent and its glint. */
  colors?: readonly string[];
}

/**
 * Where a burst starts: the centre of an element, or a point in CSS px from the top-left corner of the burst area
 * (for a `BurstLayer`, 40px above and left of its parent's corner).
 */
export type BurstOrigin = Element | { x: number; y: number };

/** How far a BurstLayer lets sparks fly past its parent, in CSS px. */
const BURST_REACH = 40;

/**
 * Fire a burst of sparks on a throwaway canvas inside `layer` (see `BurstLayer`). The canvas covers the layer plus
 * the reach in its `data-burst-reach` attribute (40px for a BurstLayer, none otherwise), cut off where the viewport
 * ends: sparks there would not show, and a canvas past the edge of the page would let a phone scroll it sideways. The
 * canvas removes itself when the last spark fades. No-op with reduced motion or while the layer is not laid out.
 */
export function burst(layer: HTMLElement, origin: BurstOrigin, options: BurstOptions = {}) {
  if (prefersReducedMotion() || !layer.isConnected) return;
  const box = layer.getBoundingClientRect();
  if (!box.width) return;
  // client px per CSS px: below 1 when an ancestor is zoomed out (a gallery card) or scaled down
  const scale = layer.offsetWidth ? box.width / layer.offsetWidth : 1;
  const reach = (Number(layer.dataset.burstReach) || 0) * scale;
  // the canvas, in client px
  const viewport = document.documentElement;
  const left = Math.max(box.left - reach, 0);
  const top = Math.max(box.top - reach, 0);
  const width = Math.min(box.right + reach, viewport.clientWidth) - left;
  const height = Math.min(box.bottom + reach, viewport.clientHeight) - top;
  if (width <= 0 || height <= 0) return;
  let x: number;
  let y: number;
  if (origin instanceof Element) {
    const rect = origin.getBoundingClientRect();
    x = rect.left + rect.width / 2 - left;
    y = rect.top + rect.height / 2 - top;
  } else {
    x = box.left - reach + origin.x * scale - left;
    y = box.top - reach + origin.y * scale - top;
  }
  const {
    count = 20,
    colors = ["--lumesec", "--lumesec-glint"],
    speed = [50, 200],
    life = [0.35, 0.8],
    jitter = 4,
    ...rest
  } = options;

  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  // placed in the layer's own CSS px, from its padding box
  const offsetLeft = (left - box.left) / scale - layer.clientLeft;
  const offsetTop = (top - box.top) / scale - layer.clientTop;
  canvas.style.cssText =
    `position:absolute;left:${offsetLeft}px;top:${offsetTop}px;width:${width / scale}px;height:${height / scale}px;` +
    "pointer-events:none";
  layer.appendChild(canvas);
  const context = canvas.getContext("2d");
  if (!context) {
    canvas.remove();
    return;
  }
  context.scale(dpr, dpr);

  const sparks = new Sparks();
  sparks.add(
    x,
    y,
    count,
    colors.map((color) => resolveColor(layer, color)),
    { speed, life, jitter, ...rest },
  );
  let last = performance.now();
  const step = (now: number) => {
    const delta = Math.min(0.05, (now - last) / 1000);
    last = now;
    context.clearRect(0, 0, width, height);
    if (sparks.step(context, delta)) requestAnimationFrame(step);
    else canvas.remove();
  };
  requestAnimationFrame(step);
}

/**
 * The overlay a burst draws into. Place it inside a `relative` parent: it covers the parent and never takes pointer
 * events, and each burst's canvas reaches 40px past the parent on every side while its sparks fly. Between bursts
 * nothing reaches past the parent, so the layer never makes the page wider.
 */
export function BurstLayer({ ref }: { ref: React.Ref<HTMLSpanElement> }) {
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-burst-reach={BURST_REACH}
      className="pointer-events-none absolute inset-0 z-[5]"
    />
  );
}

/**
 * A burst layer plus a stable function that fires into it.
 *
 * @example
 * const { ref: sparksRef, fire: fireSparks } = useBurst();
 * return (
 *   <button className="relative" onClick={(event) => fireSparks(event.currentTarget)}>
 *     Copy
 *     <BurstLayer ref={sparksRef} />
 *   </button>
 * );
 */
export function useBurst() {
  const ref = React.useRef<HTMLSpanElement>(null);
  const fire = React.useCallback((origin: BurstOrigin, options?: BurstOptions) => {
    if (ref.current) burst(ref.current, origin, options);
  }, []);
  return React.useMemo(() => ({ ref, fire }), [fire]);
}
