"use client";

/**
 * LumeSec Elements: text that rolls over a horizontal axis when it changes, like a split-flap display.
 */
import * as React from "react";

import { prefersReducedMotion } from "@/components/ui/geo-traceroute-utils/motion";
import { cn } from "@/lib/utils";

/** Timing shared by every rolling label, with a small overshoot. */
export const ROLL_TIMING = { duration: 380, easing: "cubic-bezier(.3,1.3,.5,1)" } as const;

/** Masks the top and bottom 5px so the rotating text fades at the edges instead of clipping. */
const EDGE_MASK = "linear-gradient(to bottom, transparent 0, #000 5px, #000 calc(100% - 5px), transparent 100%)";

interface RollItem {
  key: number;
  text: string;
  direction: number;
}

/** Props of {@link RollText}: the text and its roll, plus any `<span>` attribute except children. */
export interface RollTextProps extends Omit<React.ComponentProps<"span">, "children"> {
  /** The text to show. Changing it rolls the old text out and the new text in. */
  text: string;
  /** 1 rolls upward (forward), -1 downward (back). */
  direction?: number;
  /** Set to false to swap the text without animating. */
  animate?: boolean;
  /**
   * Other texts this label can show. The slot reserves the width of the widest one, so a button whose
   * label changes never changes size.
   */
  reserve?: readonly string[];
}

/**
 * A label that rolls between values. Outgoing text is hidden from assistive technology, so screen readers
 * read only the current value. With reduced motion the text swaps instantly.
 */
export function RollText({ text, direction = 1, animate = true, reserve, className, style, ...props }: RollTextProps) {
  const [state, setState] = React.useState<{ text: string; items: RollItem[] }>(() => ({
    text,
    items: [{ key: 0, text, direction }],
  }));
  const nodes = React.useRef(new Map<number, HTMLSpanElement>());

  // Derive the item list during render, so the new text is in the first paint after the change.
  if (state.text !== text) {
    const key = (state.items[state.items.length - 1] as RollItem).key + 1;
    // keep at most two outgoing labels when the text changes faster than the animation
    setState({ text, items: [...state.items.slice(-2), { key, text, direction }] });
  }

  const current = (state.items[state.items.length - 1] as RollItem);
  const previous = state.items.length > 1 ? (state.items[state.items.length - 2] as RollItem) : null;

  React.useLayoutEffect(() => {
    if (!previous) return;
    const incoming = nodes.current.get(current.key);
    const outgoing = nodes.current.get(previous.key);
    const dropOutgoing = () =>
      setState((value) => ({ ...value, items: value.items.filter((item) => item.key !== previous.key) }));
    if (!animate || prefersReducedMotion() || !incoming || !outgoing || typeof incoming.animate !== "function") {
      setState((value) => ({ ...value, items: value.items.slice(-1) }));
      return;
    }
    const sign = current.direction < 0 ? -1 : 1;
    const exit = outgoing.animate(
      [
        { opacity: 1, transform: "rotateX(0deg)" },
        { opacity: 0.35, offset: 0.45 },
        { opacity: 0, transform: `rotateX(${sign * 88}deg)` },
      ],
      { ...ROLL_TIMING, fill: "forwards" },
    );
    exit.onfinish = dropOutgoing;
    incoming.animate(
      [
        { opacity: 0, transform: `rotateX(${-sign * 88}deg)` },
        { opacity: 1, offset: 0.55 },
        { opacity: 1, transform: "rotateX(0deg)" },
      ],
      ROLL_TIMING,
    );
    // the effect is keyed on the item pair; animations finish on their own
  }, [current.key, current.direction, previous, animate]);

  return (
    <span
      className={cn("-my-[5px] inline-grid justify-items-start py-[5px] [perspective:180px]", className)}
      style={{ maskImage: EDGE_MASK, WebkitMaskImage: EDGE_MASK, ...style }}
      {...props}
    >
      {reserve?.map((value, index) => (
        // a static list; the prefix keeps these keys apart from the numeric keys of the labels beside them
        <span
          key={`reserve-${index}`}
          aria-hidden="true"
          className="invisible col-start-1 row-start-1 whitespace-nowrap"
        >
          {value}
        </span>
      ))}
      {state.items.map((item) => (
        <span
          key={item.key}
          ref={(node) => {
            if (node) nodes.current.set(item.key, node);
            else nodes.current.delete(item.key);
          }}
          aria-hidden={item.key === current.key ? undefined : true}
          className="col-start-1 row-start-1 [transform-origin:50%_50%_-10px] whitespace-nowrap [backface-visibility:hidden]"
        >
          {item.text}
        </span>
      ))}
    </span>
  );
}
