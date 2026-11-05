/**
 * LumeSec Elements: motion primitives for the native React components.
 * Every animated component pauses when it is off screen and honours `prefers-reduced-motion`.
 * Importing this module touches nothing in the browser; the hooks start their work in effects.
 */
import * as React from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

let reducedQuery: MediaQueryList | null = null;

/**
 * The reduced-motion query, created on first use in the browser and reused after that: animation loops ask on every
 * frame, and `matches` of a MediaQueryList follows the setting as it changes. Null on the server.
 */
function reducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  reducedQuery ??= window.matchMedia(REDUCED_QUERY);
  return reducedQuery;
}

/** Whether the user asked for reduced motion, read synchronously (event handlers, animation loops). */
export function prefersReducedMotion() {
  return reducedMotionQuery()?.matches ?? false;
}

function subscribeReducedMotion(callback: () => void) {
  const query = reducedMotionQuery();
  if (!query) return () => {};
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}

/** Whether the user asked for reduced motion, as React state. `false` on the server. */
export function useReducedMotion() {
  return React.useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion, () => false);
}

/** Whether the element is in (or near) the viewport. */
export function useInView(ref: React.RefObject<Element | null>, rootMargin = "0px") {
  const [inView, setInView] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries[entries.length - 1]?.isIntersecting ?? false),
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, rootMargin]);
  return inView;
}

/**
 * A frame step. Receives time and delta in seconds (delta clamped to 50 ms) and returns `true` to keep
 * animating. Returning nothing or `false` stops the loop until `kick()` is called again.
 */
export type FrameStep = (time: number, delta: number) => boolean | void;

/**
 * A requestAnimationFrame loop bound to an element. It runs only while the element is in view, stops
 * itself when `step` returns false, and restarts with `kick()` (call it whenever state changes). The browser
 * holds frames in hidden tabs; the first frame after that sees a delta clamped to 50 ms, so nothing jumps.
 */
export function useAnimationLoop(ref: React.RefObject<Element | null>, step: FrameStep) {
  const stepRef = React.useRef(step);
  const frame = React.useRef(0);
  const last = React.useRef(0);
  const visible = React.useRef(false);

  React.useEffect(() => {
    stepRef.current = step;
  });

  const tick = React.useCallback(function frameTick(now: number) {
    frame.current = 0;
    const delta = Math.min(0.05, Math.max(0, (now - last.current) / 1000));
    last.current = now;
    // the step may call kick() itself; never queue a second frame next to that one
    if (stepRef.current(now / 1000, delta) && visible.current && !frame.current) {
      frame.current = requestAnimationFrame(frameTick);
    }
  }, []);

  const kick = React.useCallback(() => {
    if (frame.current || !visible.current) return;
    last.current = performance.now();
    frame.current = requestAnimationFrame(tick);
  }, [tick]);

  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver((entries) => {
      visible.current = entries[entries.length - 1]?.isIntersecting ?? false;
      if (visible.current) kick();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      visible.current = false;
    };
  }, [ref, kick]);

  return React.useMemo(() => ({ kick }), [kick]);
}

/**
 * A setInterval that only runs while `active` (typically "in view"), for demo data that drifts.
 * The callback always sees the latest props.
 */
export function useInterval(callback: () => void, ms: number, active = true) {
  const saved = React.useRef(callback);
  React.useEffect(() => {
    saved.current = callback;
  });
  React.useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => saved.current(), ms);
    return () => window.clearInterval(id);
  }, [ms, active]);
}

/**
 * A ref whose value `init` creates the first time `.current` is read, once per component instance. Use it for engines,
 * runtimes and motion state that live as long as the component: `React.useRef(createEngine())` would build and drop
 * an engine on every render. Refs are read in effects and handlers only, so `init` never runs on the server and may
 * touch the DOM. `init` is the one from the first render, so it sees the first render's props.
 *
 * Name the result `somethingRef`: the React Compiler lint (`react-hooks/immutability`) treats the `.current` of a
 * `*Ref` as a ref, so effects and handlers may change it. List it in hook dependencies like any value a custom hook
 * returns; it never changes. The lint follows the ref through property reads but not through `for…of`: change the
 * items of a collection inside it in an indexed loop or in a plain function outside the component.
 *
 * @example
 * const motionRef = useLazyRef(() => createGlobeMotion({ autoRotate: 6 }));
 * useGlobeDrag(canvasRef, motionRef, { radius: () => radiusRef.current, onChange: loop.kick });
 */
export function useLazyRef<T>(init: () => T): React.RefObject<T> {
  // useState keeps one box for the component's lifetime; the box calls `init` on its first read
  const [ref] = React.useState(() => lazyRef(init));
  return ref;
}

/** A ref object that creates its value on the first read of `current`. Assigning `current` replaces the value. */
function lazyRef<T>(init: () => T): React.RefObject<T> {
  let value: T;
  let created = false;
  return {
    get current() {
      if (!created) {
        value = init();
        created = true;
      }
      return value;
    },
    set current(next: T) {
      value = next;
      created = true;
    },
  };
}

/** The state of a damped spring, changed in place by springStep, springEuler and settleSpring. */
export interface Spring {
  /** The current value. */
  position: number;
  /** The rate of change, in units per second. */
  velocity: number;
}

/**
 * One step of a damped spring toward `target`, integrated in two half steps for stability.
 * `stiffness` 520 and `damping` 0.72 give the slightly under-damped snap the components use.
 */
export function springStep(state: Spring, target: number, delta: number, stiffness = 520, damping = 0.72) {
  const c = 2 * Math.sqrt(stiffness) * damping;
  for (let i = 0; i < 2; i++) {
    const acceleration = stiffness * (target - state.position) - c * state.velocity;
    state.velocity += (acceleration * delta) / 2;
    state.position += (state.velocity * delta) / 2;
  }
  return state;
}

/**
 * One explicit Euler step of a damped spring toward `target`, the integrator the Pixel UI indicators use
 * (tab underlines, pagination blocks, nav and list highlights). `damping` is the ratio to critical damping.
 */
export function springEuler(state: Spring, target: number, delta: number, stiffness: number, damping: number) {
  const c = 2 * Math.sqrt(stiffness) * damping;
  state.velocity += (stiffness * (target - state.position) - c * state.velocity) * delta;
  state.position += state.velocity * delta;
  return state;
}

/** Options of {@link settleSpring}. */
export interface SettleSpringOptions {
  /** Spring stiffness. Default 520. */
  stiffness?: number;
  /** Damping as a ratio to critical damping. Default 0.72. */
  damping?: number;
  /** The spring settles once it is closer to the target than this. Default 0.001. */
  epsilon?: number;
  /** ...and slower than this, in units per second. Default `epsilon`. */
  velocityEpsilon?: number;
}

/**
 * One {@link springStep} toward `target` that lands exactly: once the spring is within `epsilon` of the target and
 * slower than `velocityEpsilon`, it snaps onto the target and reports that it stopped, so the frame loop can end
 * instead of chasing ever smaller steps. With `reduced` (reduced motion) it jumps to the target. Returns whether the
 * spring still moves: false once it has settled and after a jump, so the frame that changed the target draws the jump.
 * Pass the options as a constant, so a frame allocates nothing.
 *
 * @example
 * const HIGHLIGHT_SPRING = { stiffness: 420, damping: 0.8, epsilon: 0.002, velocityEpsilon: 0.01 };
 * if (settleSpring(highlight, selected ? 1 : 0, delta, reduced, HIGHLIGHT_SPRING)) moving = true;
 */
export function settleSpring(
  spring: Spring,
  target: number,
  delta: number,
  reduced: boolean,
  options: SettleSpringOptions = {},
): boolean {
  if (reduced) {
    spring.position = target;
    spring.velocity = 0;
    return false;
  }
  const { stiffness = 520, damping = 0.72, epsilon = 0.001, velocityEpsilon = epsilon } = options;
  springStep(spring, target, delta, stiffness, damping);
  if (Math.abs(target - spring.position) < epsilon && Math.abs(spring.velocity) < velocityEpsilon) {
    spring.position = target;
    spring.velocity = 0;
    return false;
  }
  return true;
}

/** A short horizontal shake, used to reject invalid input. No-op with reduced motion. */
export function shake(element: Element | null | undefined) {
  if (!element || prefersReducedMotion() || !("animate" in element)) return;
  element.animate(
    [
      { transform: "translateX(0)" },
      { transform: "translateX(-6px)" },
      { transform: "translateX(5px)" },
      { transform: "translateX(-3px)" },
      { transform: "translateX(2px)" },
      { transform: "translateX(0)" },
    ],
    { duration: 380, easing: "ease-out" },
  );
}
