"use client";

import * as React from "react";

import {
  snapCenter,
  useCanvas,
  type CanvasSurface,
} from "@/components/ui/geo-traceroute-utils/canvas";
import { usePalette } from "@/components/ui/geo-traceroute-utils/color";
import {
  boundsOf,
  createDotBatch,
  createProjection,
  createScreenPoint,
  cubicBezier,
  distanceKm,
  flatCurve,
  flatPaths,
  forEachDot,
  GEO_TOKENS,
  geoInk,
  isValidLatLon,
  MAP_LAT_RANGE,
  mapLattice,
  pointAtDistance,
  quadPoint,
  ringFront,
  unwrapLongitude,
  wrapLongitude,
  type ArcLengthTable,
  type DotBatch,
  type DotLattice,
  type GeoInk,
  type GeoPalette,
  type LatLon,
  type MapProjection,
} from "@/components/ui/geo-traceroute-utils/geo";
import {
  formatLatLon,
  formatMs,
  formatNumber,
  ipScope,
  median,
  parseIpAddress,
} from "@/components/ui/geo-traceroute-utils/geo-data";
import {
  clamp,
  easeOutCubic,
  hash,
  lerp,
  percent,
  smoothstep,
  TAU,
} from "@/components/ui/geo-traceroute-utils/math";
import {
  prefersReducedMotion,
  settleSpring,
  useAnimationLoop,
  useLazyRef,
  useReducedMotion,
  type Spring,
} from "@/components/ui/geo-traceroute-utils/motion";
import { RollText } from "@/components/ui/geo-traceroute-utils/roll-text";
import { Sparks } from "@/components/ui/geo-traceroute-utils/sparks";
import { useControllableState } from "@/components/ui/geo-traceroute-utils/use-controllable-state";
import { cn } from "@/lib/utils";

/** One hop of a traceroute: the router that answered (or did not), where it is, and the round-trip time of each probe. */
export interface TraceHop {
  /** The address that answered, as traceroute prints it ('203.0.113.14', '2001:db8::1'). Use '*' for a hop that did not answer. */
  readonly address: string;
  /** Reverse DNS name of the address. */
  readonly name?: string;
  /** Place name shown in the table, for example 'Frankfurt'. Located hops without it show their coordinates. */
  readonly location?: string;
  /** Latitude in degrees. Hops with `lat` and `lon` are drawn on the map. */
  readonly lat?: number;
  /** Longitude in degrees. */
  readonly lon?: number;
  /**
   * Round-trip time of each probe in ms. A non-finite entry is a probe that timed out; an empty array is a hop that
   * did not answer at all.
   */
  readonly rtt: readonly number[];
  readonly display?: string;
}

/** Props of GeoTraceroute. The remaining `div` props go to the root. */
export interface GeoTracerouteProps extends Omit<
  React.ComponentProps<"div">,
  "defaultValue" | "onChange"
> {
  /**
   * The hops in order, from the first router to the destination. Without it the component shows an 11-hop demo trace;
   * an empty array shows an empty table and map.
   */
  // ChampBeam reuses the playback engine with visitor-facing labels and real elapsed time.
  title?: string;
  metricLabel?: string;
  formatMetric?: (ms: number) => string;
  showProbes?: boolean;
  hops?: readonly TraceHop[];
  /**
   * The destination shown in the header. Default: the name or address of the last hop that answered
   * ('app.example.com' in the demo).
   */
  target?: string;
  /** Index of the selected hop in `hops` (controlled), or null for none. Use with `onValueChange`. */
  value?: number | null;
  /** The hop selected at first when uncontrolled. */
  defaultValue?: number | null;
  /** Called with the hop index when a row or a map marker is selected, and with null when the selection is cleared. */
  onValueChange?: (value: number | null) => void;
  /** Whether the playback runs (controlled). Use with `onPlayingChange`. */
  playing?: boolean;
  /**
   * Whether the playback starts by itself when uncontrolled. It begins once the map is first on screen. With false the
   * path is drawn complete.
   */
  defaultPlaying?: boolean;
  /** Called by Pause, Play and Replay, and with false when the playback reaches the end or `hops` changes. */
  onPlayingChange?: (playing: boolean) => void;
  /** Playback speed. At 1, each millisecond of round-trip time is 10 ms of animation. */
  speed?: number;
  /** Added latency in ms above which a segment is drawn as a dashed long-haul jump with its added time beside it. */
  jumpMs?: number;
  /** Probes sent per hop: the number of marks in each row. Rows with more `rtt` entries show one mark per entry. */
  probes?: number;
  /** Called when the playback reaches the end of the trace. */
  onComplete?: () => void;
}

/**
 * A traceroute as a hop table and a dotted map. The path draws hop by hop: a packet travels each segment, then waits
 * at the next hop for that hop's share of the round-trip time while the dots around the hop fill clockwise like a
 * progress ring, so slow hops are slow to watch. Its row lights up and its round-trip time counts up from the hop
 * before. Segments that add more than `jumpMs` are dashed long-haul jumps with the added time on them; hops without a
 * location, with a private address or without a reply stay in the table only. Selecting a row highlights its segment.
 *
 * @example
 * <GeoTraceroute
 *   target="app.example.com"
 *   hops={[
 *     { address: "192.168.1.1", name: "router.home.arpa", rtt: [0.6, 0.5, 0.7] },
 *     { address: "203.0.113.14", location: "Frankfurt", lat: 50.11, lon: 8.68, rtt: [8.4, 8.1, 9.0] },
 *     { address: "203.0.113.200", location: "Singapore", lat: 1.35, lon: 103.82, rtt: [162.4, 161.9, 163.0] },
 *   ]}
 *   onComplete={() => setTraced(true)}
 * />
 */
export function GeoTraceroute({
  hops,
  title = "Traceroute",
  metricLabel = "Round trip",
  formatMetric,
  showProbes = true,
  target,
  value,
  defaultValue = null,
  onValueChange,
  playing: playingProp,
  defaultPlaying = true,
  onPlayingChange,
  speed = 1,
  jumpMs = 40,
  probes = 3,
  onComplete,
  className,
  onKeyDown,
  ...props
}: GeoTracerouteProps) {
  const demo = hops === undefined;
  const hopList = hops ?? DEMO_HOPS;
  const model = React.useMemo(
    () => resolveModel(hopList, jumpMs, probes),
    [hopList, jumpMs, probes],
  );
  const layout = React.useMemo(() => markerLayout(model), [model]);
  const rowCount = model.rows.length;
  const lastLocated =
    model.located.length > 0 ? (model.located[model.located.length - 1] as number) : -1;
  const targetText = target ?? (demo ? DEMO_TARGET : defaultTarget(model));

  const [selection, setSelection] = useControllableState<number | null>({
    value,
    defaultValue,
    onChange: onValueChange,
  });
  const selectedIndex =
    selection !== null &&
    Number.isInteger(selection) &&
    selection >= 0 &&
    selection < rowCount
      ? selection
      : -1;
  const [playing, setPlaying] = useControllableState<boolean>({
    value: playingProp,
    defaultValue: defaultPlaying,
    onChange: onPlayingChange,
  });
  const reducedMotion = useReducedMotion();

  /**
   * What the playback has reached, as reported by the animation loop: the active row (-1 before the start, rowCount
   * when complete) and the last located row the packet arrived at. A new trace starts complete.
   */
  const [trace, setTrace] = React.useState(() => ({
    key: model.key,
    cursor: playing ? -1 : rowCount,
    arrived: playing ? -1 : lastLocated,
  }));
  if (trace.key !== model.key)
    setTrace({ key: model.key, cursor: rowCount, arrived: lastLocated });
  const cursor = Math.min(trace.cursor, rowCount);
  const complete = cursor >= rowCount;

  /** The row that holds the roving tab stop; -1 follows the selection. */
  const [focusIndex, setFocusIndex] = React.useState(-1);
  /** Width of the map box in CSS px; labels wait for the first measurement. */
  const [boxWidth, setBoxWidth] = React.useState<number | null>(null);
  const [announcement, setAnnouncement] = React.useState("");

  const cardRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const baseRef = React.useRef<HTMLCanvasElement>(null);
  const traceRef = React.useRef<HTMLCanvasElement>(null);
  const fxRef = React.useRef<HTMLCanvasElement>(null);
  const totalRef = React.useRef<HTMLSpanElement>(null);
  const liveRef = React.useRef<HTMLSpanElement | null>(null);
  const rowButtons = React.useRef<(HTMLButtonElement | null)[]>([]);
  /**
   * The playback engine, created on first use (effects, handlers and the loop), never during a render. It starts from
   * the first render's trace and playback state.
   */
  const engineRef = useLazyRef(() => createEngine(model, playing));

  /** The active row's round-trip time cell, which the animation loop writes to. */
  const attachLive = React.useCallback((node: HTMLSpanElement | null) => {
    liveRef.current = node;
  }, []);

  const loop = useAnimationLoop(cardRef, step);
  const palette = usePalette(cardRef, GEO_TOKENS, () => {
    engineRef.current.inkStale = true;
    loop.kick();
  });
  const base = useCanvas(baseRef, () => loop.kick(), CANVAS_OPTIONS);
  const traceLayer = useCanvas(traceRef, () => loop.kick(), CANVAS_OPTIONS);
  const fx = useCanvas(fxRef, () => loop.kick(), CANVAS_OPTIONS);

  // New data: a different trace stops the playback and shows the whole path; a new threshold only redraws.
  React.useEffect(() => {
    const engine = engineRef.current;
    const changed = engine.model.key !== model.key;
    engine.model = model;
    engine.dirty = true;
    if (changed) {
      engine.clock = model.timing.total + TAIL;
      engine.finished = true;
      engine.restart = false;
      engine.playing = false;
      engine.cursor = model.rows.length;
      engine.arrived =
        model.located.length > 0 ? (model.located[model.located.length - 1] as number) : -1;
      engine.sparks.clear();
      setPlaying(false);
    }
    loop.kick();
  }, [model, engineRef, loop, setPlaying]);

  // Play resumes where Pause left the clock; playing again after the end starts over.
  React.useEffect(() => {
    const engine = engineRef.current;
    engine.playing = playing;
    if (playing && engine.finished) engine.restart = true;
    loop.kick();
  }, [playing, engineRef, loop]);

  React.useEffect(() => {
    const engine = engineRef.current;
    engine.selected = selectedIndex;
    engine.dirty = true;
    loop.kick();
  }, [selectedIndex, engineRef, loop]);

  React.useEffect(() => {
    engineRef.current.speed =
      Number.isFinite(speed) && speed > 0 ? clamp(speed, 0.05, 20) : 1;
  }, [speed, engineRef]);

  // Reduced motion finishes the playback and every transition; restart the loop so it redraws once.
  React.useEffect(() => {
    engineRef.current.dirty = true;
    loop.kick();
  }, [reducedMotion, engineRef, loop]);

  React.useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver((entries) => {
      const width = (entries[entries.length - 1] as ResizeObserverEntry)?.contentRect.width ?? 0;
      if (width > 0) setBoxWidth(Math.round(width));
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  function step(_time: number, delta: number) {
    const engine = engineRef.current;
    const baseSurface = base.current;
    const traceSurface = traceLayer.current;
    const fxSurface = fx.current;
    const colors = palette.current;
    if (!baseSurface || !traceSurface || !fxSurface || !colors) return false;
    const reduced = prefersReducedMotion();
    const current = engine.model;
    const total = current.timing.total;
    const end = total + TAIL;

    if (engine.inkStale || !engine.ink) refreshInk(engine, colors);
    if (
      engine.layoutKey !== current.key ||
      engine.width !== traceSurface.width ||
      engine.height !== traceSurface.height
    ) {
      layoutEngine(engine, traceSurface.width, traceSurface.height);
    } else if (engine.layoutModel !== current) {
      // the same hops in a new array, or a new threshold: the geometry stands, the drawing follows the new model
      engine.layoutModel = current;
      engine.dirty = true;
    }
    const { batches, geometry } = engine;
    if (!batches || !geometry) return false;

    // on first view the land grows out from the first located hop; afterwards it is baked once per size and theme
    let revealing = false;
    if (engine.reveal < REVEAL_SECONDS) {
      engine.reveal = reduced
        ? REVEAL_SECONDS
        : Math.min(REVEAL_SECONDS, engine.reveal + delta);
      drawBase(
        baseSurface,
        geometry,
        batches.land,
        engine.reveal / REVEAL_SECONDS,
      );
      engine.baked = engine.reveal >= REVEAL_SECONDS;
      revealing = !engine.baked;
    } else if (!engine.baked) {
      drawBase(baseSurface, geometry, batches.land, 1);
      engine.baked = true;
    }

    if (engine.restart) {
      engine.restart = false;
      engine.clock = 0;
      engine.finished = false;
      engine.sparks.clear();
    }
    let advancing = false;
    if (engine.playing && !engine.finished) {
      engine.clock = reduced
        ? end
        : Math.min(total, engine.clock + delta * engine.speed);
      advancing = true;
      if (engine.clock >= total) finish(engine, fxSurface, reduced);
    } else if (engine.finished && engine.clock < end) {
      // the ping and the last ring play out after the end, also while Pause would hold the clock
      engine.clock = reduced ? end : Math.min(end, engine.clock + delta);
      advancing = true;
    }

    report(engine);
    writeLiveCount(engine);
    const moving = stepEmphasis(engine, delta, reduced);
    if (advancing || moving || engine.dirty) {
      drawTrace(engine, traceSurface, batches.path, reduced);
      engine.dirty = false;
    }
    const sparking = drawSparks(engine, fxSurface, delta);
    return advancing || moving || sparking || revealing;
  }

  /** The clock reached the end: stop, fire the arrival at the destination and tell the parent. */
  function finish(
    engine: TraceEngine,
    fxSurface: CanvasSurface,
    reduced: boolean,
  ) {
    engine.finished = true;
    engine.playing = false;
    const current = engine.model;
    if (current.rows.length === 0) {
      // nothing to play: stop quietly
      setPlaying(false);
      return;
    }
    const geometry = engine.geometry;
    const box = boxRef.current;
    if (
      !reduced &&
      current.reached &&
      current.pingRow >= 0 &&
      geometry &&
      box
    ) {
      const hop = ((geometry.hops[current.located.indexOf(current.pingRow)] as HopGeometry));
      const offset = box.getBoundingClientRect();
      const layer = fxSurface.canvas.getBoundingClientRect();
      if (hop) {
        const colors = engine.ink
          ? [engine.ink.accent, engine.ink.shine, engine.ink.glint]
          : [];
        engine.sparks.add(
          hop.x + offset.left - layer.left,
          hop.y + offset.top - layer.top,
          26,
          colors,
          SPARK_OPTIONS,
        );
      }
      const total = totalRef.current;
      if (total && typeof total.animate === "function")
        total.animate(TOTAL_POP, {
          duration: 560,
          easing: "cubic-bezier(.2,.8,.2,1)",
        });
    }
    setPlaying(false);
    onComplete?.();
    const rtt = current.reached
      ? `, ${(formatMetric ?? formatRtt)(current.total)}${formatMetric ? "" : " ms"}`
      : ", no reply from the last hop";
    setAnnouncement(
      `${title} to ${targetText} complete: ${current.rows.length} hops${rtt}.`,
    );
  }

  /** Tells React which row is active and where the packet is, when either changes. */
  function report(engine: TraceEngine) {
    const current = engine.model;
    const nextCursor = rowAt(current, engine.clock);
    const nextArrived = arrivedAt(current, engine.clock);
    if (nextCursor === engine.cursor && nextArrived === engine.arrived) return;
    engine.cursor = nextCursor;
    engine.arrived = nextArrived;
    setTrace((previous) =>
      previous.key === current.key
        ? { key: previous.key, cursor: nextCursor, arrived: nextArrived }
        : previous,
    );
  }

  /** The active row's round-trip time counts up mechanically; written straight to its cell, not through React. */
  function writeLiveCount(engine: TraceEngine) {
    const node = liveRef.current;
    const current = engine.model;
    const index = engine.cursor;
    if (!node || index < 0 || index >= current.rows.length) return;
    const row = (current.rows[index] as HopRow);
    if (row.kind === "timeout") return;
    const timing = (current.timing.rows[index] as RowTiming);
    const share = clamp(
      (engine.clock - timing.countStart) /
        Math.max(1e-6, timing.countEnd - timing.countStart),
      0,
      1,
    );
    const text = formatRtt(lerp(row.previous, row.median, share));
    if (node.textContent !== text) node.textContent = text;
  }

  function moveFocus(index: number) {
    setFocusIndex(index);
    (rowButtons.current[index] as HTMLButtonElement)?.focus();
  }

  function toggleRow(index: number) {
    setFocusIndex(index);
    setSelection(selection === index ? null : index);
  }

  function handleRowKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    let next: number;
    if (event.key === "ArrowDown") next = index + 1;
    else if (event.key === "ArrowUp") next = index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rowCount - 1;
    else return;
    event.preventDefault();
    next = clamp(next, 0, rowCount - 1);
    if (next !== index) moveFocus(next);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape" || selection === null)
      return;
    event.preventDefault();
    setSelection(null);
  }

  function handleMapClick(event: React.MouseEvent<HTMLDivElement>) {
    const marker =
      event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-hop]")
        : null;
    const index = marker ? Number(marker.dataset.hop) : Number.NaN;
    if (Number.isInteger(index)) toggleRow(index);
  }

  function replay() {
    const engine = engineRef.current;
    engine.restart = true;
    // the loop reports the first row again even when it is the row it last reported
    engine.cursor = -1;
    engine.arrived = -1;
    setTrace((previous) => ({ ...previous, cursor: -1, arrived: -1 }));
    setPlaying(true);
    loop.kick();
  }

  function togglePlayback() {
    if (playing) setPlaying(false);
    else if (complete) replay();
    else setPlaying(true);
  }

  const tabStop =
    focusIndex >= 0 && focusIndex < rowCount
      ? focusIndex
      : Math.max(0, selectedIndex);
  const selectedRow = selectedIndex >= 0 ? (model.rows[selectedIndex] as HopRow) : null;
  const mapDimmed = selectedRow !== null && selectedRow.kind !== "located";
  // the hop the packet is at or heading from, while the playback is under way (also while paused)
  const packetRow = cursor >= 0 && !complete ? trace.arrived : -1;
  const width = boxWidth ?? NOMINAL_BOX_WIDTH;
  const labels = React.useMemo(
    () => placeMapLabels(model, layout, width, selectedIndex, packetRow),
    [model, layout, width, selectedIndex, packetRow],
  );
  const totalText =
    complete && model.reached ? (formatMetric ?? formatRtt)(model.total) : MISSING;
  const totalReserve = React.useMemo(
    () => [...new Set([(formatMetric ?? formatRtt)(model.total), MISSING])],
    [model.total, formatMetric],
  );

  return (
    <div
      data-slot="geo-traceroute"
      className={cn(
        "@container grid w-full max-w-[660px] gap-3 text-[13px] leading-5 text-foreground",
        className,
      )}
      onKeyDown={handleKeyDown}
      {...props}
    >
      <div className="flex min-h-9 items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="m-0 text-[12px] leading-4 text-muted-foreground">
            {title}
            <span aria-hidden="true"> · </span>
            <span className="tabular-nums">
              {rowCount === 1 ? "1 hop" : `${rowCount} hops`}
            </span>
          </p>
          <p
            className="m-0 truncate font-mono text-[13.5px] leading-5 font-medium"
            title={targetText}
          >
            {targetText}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="m-0 text-[12px] leading-4 text-muted-foreground">
            {metricLabel}
          </p>
          <p className="m-0 flex items-baseline justify-end gap-1 font-mono text-[13.5px] leading-5 font-medium tabular-nums">
            <span ref={totalRef} className="inline-block origin-right">
              <RollText
                text={totalText}
                direction={complete ? 1 : -1}
                animate={!reducedMotion}
                reserve={totalReserve}
                className="justify-items-end"
              />
            </span>
            <span
              className={cn(
                "font-sans text-[12px] font-normal text-muted-foreground transition-opacity duration-300",
                totalText === MISSING && "opacity-0",
              )}
            >
              {formatMetric ? null : "ms"}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <ToolbarButton
            label="Replay"
            onClick={replay}
            disabled={rowCount === 0}
          >
            <svg
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.5}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="size-3.5 shrink-0"
            >
              <path d="M3.2 8.6A4.9 4.9 0 1 0 4.6 4.4" />
              <path d="M4.4 1.9v2.7h2.7" />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            label={playing ? "Pause" : "Play"}
            reserve={PLAY_LABELS}
            onClick={togglePlayback}
            disabled={rowCount === 0}
          >
            {playing ? (
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                className="size-3.5 shrink-0"
              >
                <rect x="4" y="3.25" width="2.6" height="9.5" rx="0.7" />
                <rect x="9.4" y="3.25" width="2.6" height="9.5" rx="0.7" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 16 16"
                fill="currentColor"
                aria-hidden="true"
                className="size-3.5 shrink-0"
              >
                <path d="M5 3.6c0-.6.6-.9 1.1-.6l6.3 4.4c.4.3.4.9 0 1.2l-6.3 4.4c-.5.3-1.1 0-1.1-.6z" />
              </svg>
            )}
          </ToolbarButton>
        </div>
      </div>

      <div
        ref={cardRef}
        className="relative rounded-xl border border-border bg-card [-webkit-tap-highlight-color:transparent]"
      >
        <div
          ref={boxRef}
          data-dimmed={mapDimmed ? "" : undefined}
          onClick={handleMapClick}
          className="group/map relative overflow-hidden rounded-[11px]"
          style={{ aspectRatio: MAP_ASPECT }}
        >
          <canvas
            ref={baseRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 block size-full"
          />
          <div
            role="img"
            aria-label={formatMetric ? `Visitor journey: ${model.located.length} map locations. ${hopList.map((hop) => [hop.address, hop.location, hop.display].filter(Boolean).join(", ")).join("; ")}` : mapLabel(model)}
            className="absolute inset-0"
          />
          {model.located.map((row, li) => {
            const point = ((layout.points[li] as { x: number; y: number; }) as { x: number; y: number; });
            const reached = complete || row <= trace.arrived;
            const here = row === packetRow;
            const destination = complete && row === model.pingRow;
            const state =
              row === selectedIndex
                ? "selected"
                : here || destination
                  ? "current"
                  : reached
                    ? "reached"
                    : "pending";
            return (
              <span
                key={(model.rows[row] as HopRow).key}
                aria-hidden="true"
                data-hop={row}
                data-state={state}
                className="group/hop absolute z-[1] -mt-2.5 -ml-2.5 grid size-5 cursor-pointer place-items-center"
                style={{ left: percent(point.x), top: percent(point.y) }}
              >
                <span className="block size-[7px] rounded-full border-[1.5px] border-muted-foreground/70 bg-card shadow-[0_0_0_2px_var(--card)] transition-[background-color,border-color,opacity,scale] duration-300 group-hover/hop:scale-[1.3] group-data-[dimmed]/map:opacity-35 group-data-[state=current]/hop:border-lumesec group-data-[state=current]/hop:bg-lumesec group-data-[state=reached]/hop:border-foreground group-data-[state=reached]/hop:bg-foreground group-data-[state=selected]/hop:scale-[1.15] group-data-[state=selected]/hop:border-lumesec group-data-[state=selected]/hop:bg-lumesec group-data-[state=selected]/hop:shadow-[0_0_0_2px_var(--card),0_0_0_3.5px_var(--lumesec)] motion-reduce:transition-none" />
              </span>
            );
          })}
          <canvas
            ref={traceRef}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-[2] block size-full"
          />
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-0 z-[3] transition-opacity duration-300",
              boxWidth === null && "opacity-0",
            )}
          >
            {model.segments.map((segment, k) => {
              const placement = ((labels.chips[k] as { x: number; y: number; width: number; }) as { x: number; y: number; width: number; });
              if (!segment.jump || !placement) return null;
              const drawn = complete || trace.arrived >= segment.to;
              const selected = segment.to === selectedIndex;
              return (
                <span
                  key={`${(model.rows[segment.from] as HopRow).key}>${(model.rows[segment.to] as HopRow).key}`}
                  data-state={drawn ? "drawn" : "pending"}
                  className={cn(
                    "absolute rounded-full border bg-card px-1.5 text-center font-mono text-[10px] leading-[14px] whitespace-nowrap tabular-nums transition-[opacity,scale,border-color,color] duration-300 data-[state=pending]:scale-75 data-[state=pending]:opacity-0 motion-reduce:transition-none",
                    selected
                      ? "border-lumesec text-foreground"
                      : "border-border text-muted-foreground",
                    mapDimmed || (selectedIndex >= 0 && !selected)
                      ? "opacity-45"
                      : "",
                  )}
                  style={{
                    left: placement.x,
                    top: placement.y,
                    width: placement.width,
                  }}
                >
                  {jumpText(segment.delta)}
                </span>
              );
            })}
            {model.located.map((row, li) => {
              const placement = ((labels.hops[li] as { visible: boolean; x: number; y: number; named: boolean; }) as { visible: boolean; x: number; y: number; named: boolean; });
              if (!placement?.visible) return null;
              const hop = (model.rows[row] as HopRow);
              const strong = row === selectedIndex || row === packetRow;
              return (
                <span
                  key={hop.key}
                  className={cn(
                    "absolute font-mono text-[10.5px] leading-[14px] whitespace-nowrap transition-[opacity,color,left,top] duration-300 ease-[cubic-bezier(.2,.8,.2,1)] [text-shadow:0_0_2px_var(--card),0_0_4px_var(--card),0_0_6px_var(--card)] motion-reduce:transition-none",
                    strong ? "text-foreground" : "text-muted-foreground",
                    mapDimmed && "opacity-40",
                  )}
                  style={{ left: placement.x, top: placement.y }}
                >
                  <span
                    className={cn(
                      strong ? "text-lumesec" : "text-muted-foreground",
                    )}
                  >
                    {hop.number}
                  </span>
                  {placement.named ? ` ${hop.place}` : null}
                </span>
              );
            })}
          </div>
          {model.located.length < 2 ? (
            <p className="absolute top-2.5 left-3 z-[3] m-0 rounded-md bg-card/85 px-1.5 text-[12px] leading-5 text-muted-foreground">
              No path to draw
            </p>
          ) : null}
        </div>
        <canvas
          ref={fxRef}
          aria-hidden="true"
          className="pointer-events-none absolute -inset-x-4 -inset-y-10 z-[4] block h-[calc(100%+80px)] w-[calc(100%+32px)]"
        />
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <table className="w-full table-fixed border-collapse text-left text-[12px] leading-4">
          <caption className="sr-only">{formatMetric ? "Touches for" : "Hops to"} {targetText}</caption>
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th
                scope="col"
                className="h-8 w-10 pl-3 font-normal @max-[480px]:w-8"
              >
                #
              </th>
              <th
                scope="col"
                className="h-8 w-[28%] px-2 font-normal @max-[480px]:w-auto"
              >
                {title === "Traceroute" ? "Address" : "Item"}
              </th>
              <th
                scope="col"
                className="h-8 px-2 font-normal @max-[480px]:hidden"
              >
                Name
              </th>
              <th
                scope="col"
                className="h-8 w-[20%] px-2 font-normal @max-[480px]:w-[23%]"
              >
                Location
              </th>
              <th
                scope="col"
                className="h-8 w-[76px] px-2 text-right font-normal @max-[480px]:w-[60px]"
              >
                {formatMetric ? metricLabel : <>RTT<span className="hidden @max-[480px]:inline"> ms</span></>}
              </th>
              {showProbes && <th
                scope="col"
                className="h-8 w-[52px] pr-3 text-right font-normal @max-[480px]:w-[34px]"
              >
                <span className="@max-[480px]:sr-only">Probes</span>
              </th>}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row, i) => {
              const state =
                complete || i < cursor
                  ? "done"
                  : i === cursor
                    ? "active"
                    : "pending";
              const selected = i === selectedIndex;
              return (
                <tr
                  key={row.key}
                  data-state={state}
                  data-selected={selected ? "" : undefined}
                  onClick={() => toggleRow(i)}
                  className="group/row cursor-pointer border-b border-border/70 transition-colors duration-200 last:border-b-0 hover:bg-muted/50 data-[selected]:bg-lumesec/[0.07] data-[state=active]:bg-muted motion-reduce:transition-none"
                >
                  <td className="relative p-0">
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-0.5 bg-lumesec opacity-0 transition-opacity duration-200 group-data-[selected]/row:opacity-100 group-data-[state=active]/row:opacity-100"
                    />
                    <button
                      ref={(node) => {
                        rowButtons.current[i] = node;
                      }}
                      type="button"
                      tabIndex={i === tabStop ? 0 : -1}
                      aria-pressed={selected}
                      aria-label={row.hop.display ? [row.number, row.address, row.hop.name, row.hop.location, row.hop.display].filter(Boolean).join(", ") : rowLabel(row)}
                      onFocus={() => setFocusIndex(i)}
                      onKeyDown={(event) => handleRowKeyDown(event, i)}
                      className="block h-[30px] w-full cursor-pointer border-0 bg-transparent p-0 pl-3 text-left font-mono text-[12px] text-muted-foreground tabular-nums outline-none group-data-[selected]/row:text-lumesec focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-lumesec focus-visible:outline-solid @max-[480px]:pl-2.5"
                    >
                      {row.number}
                    </button>
                  </td>
                  <td
                    className={cn(
                      "truncate px-2 font-mono",
                      row.kind === "timeout" && "text-muted-foreground",
                    )}
                    title={row.address}
                  >
                    {row.address}
                  </td>
                  <td
                    className="truncate px-2 text-muted-foreground @max-[480px]:hidden"
                    title={row.hop.name}
                  >
                    {row.hop.name ||
                      (row.kind === "timeout" ? "No reply" : MISSING)}
                  </td>
                  <td className="truncate px-2">
                    <LocationCell row={row} selected={selected} />
                  </td>
                  <td className="px-2 text-right font-mono whitespace-nowrap tabular-nums">
                    {row.hop.display ?? <RttCell row={row} state={state} attachLive={attachLive} />}
                  </td>
                  {showProbes && <td className="pr-3">
                    <ProbeMarks marks={row.marks} state={state} />
                  </td>}
                </tr>
              );
            })}
            {rowCount === 0 ? (
              <tr>
                <td
                  colSpan={showProbes ? 6 : 5}
                  className="h-16 text-center text-muted-foreground"
                >
                  No hops
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

/* Header, table cells --------------------------------------------------------------------------------- */

/** A header button: icon plus a label that rolls when it changes; the label hides on narrow containers. */
function ToolbarButton({
  label,
  reserve,
  onClick,
  disabled,
  children,
}: {
  label: string;
  reserve?: readonly string[];
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-card px-[11px] font-[inherit] text-[12.5px] font-medium text-foreground transition-[border-color] duration-200 outline-none hover:border-[color-mix(in_srgb,var(--lumesec)_50%,var(--border))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lumesec focus-visible:outline-solid disabled:cursor-default disabled:opacity-50 @max-[480px]:px-2"
    >
      {children}
      <span aria-hidden="true" className="@max-[480px]:hidden">
        {reserve ? <RollText text={label} reserve={reserve} /> : label}
      </span>
    </button>
  );
}

function LocationCell({ row, selected }: { row: HopRow; selected: boolean }) {
  if (row.hop.location) return <span title={row.hop.location}>{row.hop.location}</span>;
  if (row.kind === "located") return <span title={row.place}>{row.place}</span>;
  if (row.kind === "private") {
    return (
      <span className="inline-flex h-[18px] items-center rounded-[5px] border border-border px-1.5 text-[11px] leading-none text-muted-foreground">
        Private
      </span>
    );
  }
  if (selected && row.kind === "unlocated")
    return <span className="text-muted-foreground">No location</span>;
  return <span className="text-muted-foreground">{MISSING}</span>;
}

/**
 * The round-trip time: a dash until the playback reaches the row, a count written by the animation loop while it is
 * active, the median after. The live span has no React children, so the loop can own its text.
 */
function RttCell({
  row,
  state,
  attachLive,
}: {
  row: HopRow;
  state: RowState;
  attachLive: (node: HTMLSpanElement | null) => void;
}) {
  if (row.kind === "timeout") {
    return (
      <span className="text-muted-foreground">
        {state === "pending" ? MISSING : "*"}
      </span>
    );
  }
  const unit = (
    <span
      className={cn(
        "font-sans text-muted-foreground @max-[480px]:hidden",
        state === "pending" && "invisible",
      )}
    >
      {" "}
      ms
    </span>
  );
  if (state === "pending") {
    return (
      <>
        <span className="text-muted-foreground">{MISSING}</span>
        {unit}
      </>
    );
  }
  if (state === "active") {
    return (
      <>
        <span
          key="live"
          ref={(node) => {
            attachLive(node);
            if (node && !node.textContent)
              node.textContent = formatRtt(row.previous);
          }}
          className="text-foreground"
        />
        {unit}
      </>
    );
  }
  return (
    <>
      <span key="done">{formatRtt(row.median)}</span>
      {unit}
    </>
  );
}

/** One mark per probe: filled when it answered, hollow when it timed out. They fill in turn when the row's turn comes. */
function ProbeMarks({
  marks,
  state,
}: {
  marks: readonly boolean[];
  state: RowState;
}) {
  return (
    <span
      className="flex items-center justify-end gap-[3px]"
      aria-label={probeLabel(marks)}
      role="img"
    >
      {marks.map((answered, j) => (
        <span
          key={j}
          data-answered={answered && state !== "pending" ? "" : undefined}
          className={cn(
            "block size-[5px] rounded-[1.5px] border border-foreground/30 transition-[background-color,border-color,scale] duration-200 data-[answered]:border-foreground/55 data-[answered]:bg-foreground/55 motion-reduce:transition-none",
            state === "pending" && "border-foreground/15",
            state === "active" &&
              answered &&
              "data-[answered]:border-lumesec data-[answered]:bg-lumesec",
          )}
          style={{
            transitionDelay: state === "active" ? `${j * 90}ms` : "0ms",
          }}
        />
      ))}
    </span>
  );
}

/* Constants ------------------------------------------------------------------------------------------ */

/** Width / height of the map box. The map is a window onto a zoomed world, so any aspect works. */
const MAP_ASPECT = 2.1;
/** The width the server markup and the projection for marker positions assume. */
const NOMINAL_WIDTH = 1000;
/** The map box width label placement assumes before the first measurement (660 px minus the borders). */
const NOMINAL_BOX_WIDTH = 658;
/** Below this map width the lattice gets finer. */
const NARROW_WIDTH = 480;
const CANVAS_OPTIONS = { maxDpr: 2 };

/** The path: bend of each segment, dot spacing and size, its alpha, and the alpha of segments a selection dims. */
const BEND = 0.12;
const DOT_SPACING = 3.5;
const DOT_SIZE = 2;
/** Path alpha on light and on dark cards: the accent loses contrast against a dark lattice, so it gets more. */
const PATH_ALPHA = { light: 0.72, dark: 0.86 };
const DIM = 0.25;
/** Path dots stop this far from each hop centre, so they never run into the marker. */
const TRIM = 6;
/** Dwell: the packet's orbit radius and the ring of lattice dots that fills around the hop. */
const ORBIT = 7;
const RING_INNER = 8.5;
const RING_OUTER = 16;
/** Seconds of clock time for a dwell ring to fade after the packet leaves. */
const RING_FADE = 0.6;
/** Edge fade of the land lattice in px. */
const EDGE_FADE = 22;
/** Seconds for the land to grow out from the first located hop on first view. */
const REVEAL_SECONDS = 0.9;
/** Width of the reveal front, as a share of the reach from the first hop to the farthest corner. */
const REVEAL_SOFTNESS = 0.07;

/** Playback timing in seconds at speed 1: one ms of round-trip time is 10 ms of animation. */
const SECONDS_PER_MS = 0.01;
const MIN_STEP = 0.14;
const TIMEOUT_STEP = 0.36;
const MIN_DWELL = 0.18;
const TRAVEL_BASE = 0.35;
const TRAVEL_PER_10K_KM = 0.25;
/** Seconds of effects after the end: the two-ring ping at the destination and the last ring's fade. */
const TAIL = 1.5;
const PING_RADIUS = 60;
const PING_SECONDS = 1.05;
const PING_DELAY = 0.22;

/** Arc draws ease in and out, so the packet leaves and lands softly. */
const TRAVEL_EASE = cubicBezier(0.45, 0, 0.25, 1);

/** Selection springs: a snap with a little overshoot. */
const EMPHASIS_SPRING = { stiffness: 260, damping: 0.8 };
/** Seconds for a selected hop's ring to fill, and to fade when it is deselected. */
const SELECT_FILL = 0.45;
const SELECT_FADE = 0.3;

/** Sparks at the destination, on the layer that reaches past the map. */
const SPARK_OPTIONS = {
  speed: [40, 175],
  life: [0.35, 0.85],
  size: [1.5, 2.5],
  drag: 3.2,
  jitter: 2,
} as const;

const MISSING = "-";
const PLAY_LABELS = ["Pause", "Play"] as const;
const DEMO_TARGET = "app.example.com";

/** Geist Mono advances 0.6 em per character; map labels are 10.5 px on a 14 px line, chips 10 px. */
const LABEL_CHAR_WIDTH = 6.3;
const LABEL_HEIGHT = 14;
const CHIP_CHAR_WIDTH = 6;
const CHIP_HEIGHT = 16;
const LABEL_GAP = 8;
/** Space a chip keeps from every marker centre. */
const CHIP_CLEARANCE = 7;
/** Space hop labels keep around the chips. */
const CHIP_MARGIN = 2;
/** Space hop labels keep from marker centres, curve points and rings when they can. */
const POINT_MARGIN = 5;
/** Half the box of a marker (7 px dot, 1.5 px border, 2 px card ring) that no label may cover. */
const MARKER_RADIUS = 5;
const LABEL_SIDES = ["right", "left", "top", "bottom"] as const;
/** Points per segment curve that labels avoid. */
const CURVE_SAMPLES = 12;
/** The label of a hop with a ring moves out past the ring. */
const RING_LABEL_GAP = RING_OUTER + 3;

const TOTAL_POP: Keyframe[] = [
  { transform: "scale(1)", filter: "brightness(1)" },
  { transform: "scale(1.14)", filter: "brightness(1.4)", offset: 0.4 },
  { transform: "scale(1)", filter: "brightness(1)" },
];

/**
 * An invented trace from a home router through Frankfurt, Lyon and Marseille, under the sea to Cairo and Mumbai, and on
 * to Singapore. Addresses come from the private and documentation ranges and names use example.net.
 */
const DEMO_HOPS: readonly TraceHop[] = [
  { address: "192.168.1.1", name: "router.home.arpa", rtt: [0.6, 0.5, 0.7] },
  { address: "100.64.0.1", rtt: [4.2, 3.8, 4.0] },
  {
    address: "203.0.113.14",
    name: "ae2.br1.fra.example.net",
    location: "Frankfurt",
    lat: 50.1109,
    lon: 8.6821,
    rtt: [8.4, 8.1, 9.0],
  },
  {
    address: "203.0.113.62",
    name: "et-3.cr1.lys.example.net",
    location: "Lyon",
    lat: 45.764,
    lon: 4.8357,
    rtt: [14.6, 14.2, 15.1],
  },
  { address: "*", rtt: [] },
  {
    address: "198.51.100.21",
    name: "ae5.cr2.mrs.example.net",
    location: "Marseille",
    lat: 43.2965,
    lon: 5.3698,
    rtt: [19.2, 18.9, 19.6],
  },
  {
    address: "198.51.100.86",
    name: "be-7.sub1.cai.example.net",
    location: "Cairo",
    lat: 30.0444,
    lon: 31.2357,
    rtt: [61.3, 60.8, 62.0],
  },
  {
    address: "192.0.2.33",
    name: "et-1.cr1.bom.example.net",
    location: "Mumbai",
    lat: 19.076,
    lon: 72.8777,
    rtt: [110.4, 109.8, 111.2],
  },
  { address: "192.0.2.70", rtt: [118.9, Number.NaN, 119.5] },
  {
    address: "192.0.2.118",
    name: "ae-4.cr1.maa.example.net",
    location: "Chennai",
    lat: 13.0827,
    lon: 80.2707,
    rtt: [126.0, 125.4, 126.8],
  },
  {
    address: "203.0.113.200",
    name: "app.example.com",
    location: "Singapore",
    lat: 1.3521,
    lon: 103.8198,
    rtt: [162.4, 161.9, 163.0],
  },
];

/* Data model ----------------------------------------------------------------------------------------- */

/** How a hop takes part: on the map, in the table only (private address, no location), or no reply. */
type HopKind = "located" | "private" | "unlocated" | "timeout";
type RowState = "pending" | "active" | "done";

interface HopRow {
  hop: TraceHop;
  key: string;
  /** 1-based hop number. */
  number: number;
  /** Normalised address text, or '*' for a hop without one. */
  address: string;
  kind: HopKind;
  /** Median of the answered probes in ms; NaN for a timeout. */
  median: number;
  /** Median of the closest answered hop above, where the count-up starts (0 for the first). */
  previous: number;
  point: LatLon | null;
  /** Location text for located hops. */
  place: string;
  /** One entry per probe mark: whether that probe answered. */
  marks: readonly boolean[];
}

/** A drawn segment between two consecutive located hops, by row index. */
interface TraceSegment {
  from: number;
  to: number;
  /** Round-trip time the segment adds, in ms (never negative). */
  delta: number;
  jump: boolean;
  km: number;
}

interface Span {
  start: number;
  end: number;
}

interface RowTiming extends Span {
  /** When the round-trip time counts up: the dwell for located hops, the whole turn for the others. */
  countStart: number;
  countEnd: number;
}

/** The playback schedule in seconds at speed 1. */
interface TraceTiming {
  rows: RowTiming[];
  /** Travel of each segment. */
  travel: Span[];
  /** Dwell at each located hop, by located index. */
  dwell: Span[];
  total: number;
}

/** Where the map looks: the central meridian, and the zoom about a focus that frames every located hop. */
interface MapView {
  lon0: number;
  zoom: number;
  focus: LatLon | undefined;
}

interface TraceModel {
  /** Identifies the trace data; a new key stops the playback. */
  key: string;
  rows: HopRow[];
  /** Row indices of the located hops, in order. */
  located: number[];
  segments: TraceSegment[];
  timing: TraceTiming;
  view: MapView;
  /** Median of the last hop in ms (NaN when it timed out). */
  total: number;
  /** Whether the last hop answered. */
  reached: boolean;
  /** The row that pings at the end: the last hop when it is located and answered, else -1. */
  pingRow: number;
}

const HIDDEN_SCOPES = new Set(["private", "shared", "loopback", "link-local"]);

function resolveModel(
  hops: readonly TraceHop[],
  jumpMs: number,
  probes: number,
): TraceModel {
  const markCount = clamp(
    Math.round(Number.isFinite(probes) ? probes : 3),
    1,
    8,
  );
  const threshold = Number.isFinite(jumpMs) ? jumpMs : 40;
  const rows: HopRow[] = [];
  const located: number[] = [];
  const seen = new Map<string, number>();
  let previous = 0;
  hops.forEach((hop, index) => {
    const rtt = Array.isArray(hop.rtt) ? hop.rtt : [];
    const answered = rtt.filter((value) => Number.isFinite(value));
    const raw = typeof hop.address === "string" ? hop.address.trim() : "";
    const parsed = parseIpAddress(raw);
    const scope = parsed ? ipScope(parsed) : null;
    const hasPoint = isValidLatLon(hop);
    const kind: HopKind =
      answered.length === 0
        ? "timeout"
        : scope && HIDDEN_SCOPES.has(scope)
          ? "private"
          : hasPoint
            ? "located"
            : "unlocated";
    const point =
      kind === "located"
        ? { lat: hop.lat ?? 0, lon: wrapLongitude(hop.lon ?? 0) }
        : null;
    const value = answered.length ? median(answered) : Number.NaN;
    const address = parsed?.text ?? (raw || "*");
    const base = `${index + 1}:${address}`;
    const repeat = seen.get(base) ?? 0;
    seen.set(base, repeat + 1);
    rows.push({
      hop,
      key: repeat ? `${base}#${repeat}` : base,
      number: index + 1,
      address,
      kind,
      median: value,
      previous,
      point,
      place: point
        ? hop.location?.trim() || formatLatLon(point, "decimal", 1)
        : "",
      marks: Array.from(
        { length: Math.min(8, Math.max(markCount, rtt.length)) },
        (_, j) => Number.isFinite(rtt[j]),
      ),
    });
    if (kind === "located") located.push(index);
    if (Number.isFinite(value)) previous = value;
  });

  const segments: TraceSegment[] = [];
  for (let k = 1; k < located.length; k++) {
    const a = (rows[(located[k - 1] as number)] as HopRow);
    const b = (rows[(located[k] as number)] as HopRow);
    const delta = Math.max(0, b.median - a.median);
    segments.push({
      from: (located[k - 1] as number),
      to: (located[k] as number),
      delta,
      jump: delta > threshold,
      km: a.point && b.point ? distanceKm(a.point, b.point) : 0,
    });
  }
  const last = (rows[rows.length - 1] as HopRow);
  const reached = last !== undefined && last.kind !== "timeout";
  return {
    key: traceKey(hops),
    rows,
    located,
    segments,
    timing: scheduleTrace(rows, located, segments),
    view: mapView(located.map((row) => (rows[row] as HopRow).point ?? { lat: 0, lon: 0 })),
    total: reached ? last.median : Number.NaN,
    reached,
    pingRow: reached && last.kind === "located" ? rows.length - 1 : -1,
  };
}

/** A string that changes when the trace data changes, so inline arrays with the same hops do not restart anything. */
function traceKey(hops: readonly TraceHop[]) {
  return hops
    .map(
      (hop) =>
        `${hop.address}|${hop.lat}|${hop.lon}|${Array.isArray(hop.rtt) ? hop.rtt.join(" ") : ""}`,
    )
    .join("\n");
}

/**
 * The playback schedule. Rows before the first located hop (and after the last) take turns in the table only. The
 * packet appears at the first located hop, then for each segment it travels (0.35 s plus 0.25 s per 10,000 km) and
 * waits at the next hop for the segment's added time. Rows between two located hops take turns during the travel.
 */
function scheduleTrace(
  rows: readonly HopRow[],
  located: readonly number[],
  segments: readonly TraceSegment[],
): TraceTiming {
  const timing: RowTiming[] = rows.map(() => ({
    start: 0,
    end: 0,
    countStart: 0,
    countEnd: 0,
  }));
  const travel: Span[] = [];
  const dwell: Span[] = [];
  let t = 0;
  const turn = (index: number) => {
    const row = (rows[index] as HopRow);
    const duration =
      row.kind === "timeout"
        ? TIMEOUT_STEP
        : Math.max(
            MIN_STEP,
            Math.max(0, row.median - row.previous) * SECONDS_PER_MS,
          );
    timing[index] = {
      start: t,
      end: t + duration,
      countStart: t,
      countEnd: t + duration,
    };
    t += duration;
  };
  if (located.length === 0) {
    rows.forEach((_, index) => turn(index));
    return { rows: timing, travel, dwell, total: t };
  }
  const first = (located[0] as number);
  for (let i = 0; i < first; i++) turn(i);
  const opening = Math.max(
    MIN_DWELL,
    Math.max(0, (rows[first] as HopRow).median - (rows[first] as HopRow).previous) * SECONDS_PER_MS,
  );
  timing[first] = {
    start: t,
    end: t + opening,
    countStart: t,
    countEnd: t + opening,
  };
  dwell.push({ start: t, end: t + opening });
  t += opening;
  for (const segment of segments) {
    const duration = TRAVEL_BASE + (TRAVEL_PER_10K_KM * segment.km) / 10_000;
    const between = segment.to - segment.from - 1;
    const slice = duration / (between + 1);
    for (let j = 1; j <= between; j++) {
      const start = t + (j - 1) * slice;
      timing[segment.from + j] = {
        start,
        end: start + slice,
        countStart: start,
        countEnd: start + slice,
      };
    }
    const arrival = t + duration;
    const wait = Math.max(MIN_DWELL, segment.delta * SECONDS_PER_MS);
    timing[segment.to] = {
      start: t + between * slice,
      end: arrival + wait,
      countStart: arrival,
      countEnd: arrival + wait,
    };
    travel.push({ start: t, end: arrival });
    dwell.push({ start: arrival, end: arrival + wait });
    t = arrival + wait;
  }
  for (let i = (located[located.length - 1] as number) + 1; i < rows.length; i++) turn(i);
  return { rows: timing, travel, dwell, total: t };
}

/** The active row at a clock time: the row whose turn holds it, or rows.length at the end. */
function rowAt(model: TraceModel, clock: number) {
  if (clock >= model.timing.total) return model.rows.length;
  const rows = model.timing.rows;
  for (let i = 0; i < rows.length; i++) if (clock < (rows[i] as RowTiming).end) return i;
  return model.rows.length;
}

/** The last located row the packet has arrived at, or -1. */
function arrivedAt(model: TraceModel, clock: number) {
  let arrived = -1;
  model.timing.dwell.forEach((span, li) => {
    if (clock >= span.start) arrived = (model.located[li] as number);
  });
  return arrived;
}

/** The last hop that answered, by name or address; a trace whose last hops did not answer still names where it got to. */
function defaultTarget(model: TraceModel) {
  for (let i = model.rows.length - 1; i >= 0; i--) {
    const row = (model.rows[i] as HopRow);
    if (row.kind !== "timeout") return row.hop.name?.trim() || row.address;
  }
  return MISSING;
}

const formatRtt = (ms: number) => formatNumber(ms, { fractionDigits: 1 });

const jumpText = (delta: number) => `${formatNumber(delta, { sign: true })} ms`;

/** "7 located hops from Frankfurt to Singapore, 162 ms". */
function mapLabel(model: TraceModel) {
  const count = model.located.length;
  if (count === 0) return "Map: no hop has a location.";
  const first = (model.rows[(model.located[0] as number)] as HopRow);
  const last = (model.rows[(model.located[count - 1] as number)] as HopRow);
  if (count === 1) return `1 located hop in ${first.place}. No path to draw.`;
  const jumps = model.segments.filter((segment) => segment.jump).length;
  const jumpNote =
    jumps === 1
      ? " 1 long-haul jump."
      : jumps > 1
        ? ` ${jumps} long-haul jumps.`
        : "";
  return `${count} located hops from ${first.place} to ${last.place}, ${formatMs(last.median)}.${jumpNote}`;
}

/** The row button's name: hop number, where it is and its time. */
function rowLabel(row: HopRow) {
  if (row.kind === "timeout") return `Hop ${row.number}, no reply`;
  const where =
    row.kind === "located"
      ? row.place
      : row.kind === "private"
        ? "private address"
        : "no location";
  return `Hop ${row.number}, ${row.hop.name || row.address}, ${where}, ${formatRtt(row.median)} ms`;
}

function probeLabel(marks: readonly boolean[]) {
  const answered = marks.filter(Boolean).length;
  return `${answered} of ${marks.length} probes answered`;
}

/* Map view, markers and labels ---------------------------------------------------------------------- */

/**
 * Frames the located hops: their bounds (25 % margin, at least 60° on each axis) centred on the central meridian, and
 * the zoom of a whole-world Equal Earth map that fits those bounds into the box. The other axis gets more context, so
 * the map always fills its box edge to edge, without the curved sides a cropped Equal Earth map would have.
 */
function mapView(points: readonly LatLon[]): MapView {
  if (points.length === 0) return { lon0: 0, zoom: 1, focus: undefined };
  const bounds = boundsOf(points, 0.25, 60);
  const middle = (bounds.west + bounds.east) / 2;
  const lon0 = wrapLongitude(middle);
  const width = NOMINAL_WIDTH;
  const height = width / MAP_ASPECT;
  const projection = createProjection("equalEarth", {
    width,
    height,
    latRange: MAP_LAT_RANGE,
    center: { lat: 0, lon: lon0 },
  });
  const south = clamp(bounds.south, MAP_LAT_RANGE[0], MAP_LAT_RANGE[1]);
  const north = clamp(bounds.north, MAP_LAT_RANGE[0], MAP_LAT_RANGE[1]);
  const span = bounds.east - bounds.west;
  const point = createScreenPoint();
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const SAMPLES = 16;
  for (let i = 0; i <= SAMPLES; i++) {
    const lambda = bounds.west - middle + (span * i) / SAMPLES;
    const lat = south + ((north - south) * i) / SAMPLES;
    for (const [la, lo] of [
      [south, lambda],
      [north, lambda],
      [lat, bounds.west - middle],
      [lat, bounds.east - middle],
    ] as [number, number][]) {
      projection.projectRelative(la, lo, point);
      x0 = Math.min(x0, point.x);
      y0 = Math.min(y0, point.y);
      x1 = Math.max(x1, point.x);
      y1 = Math.max(y1, point.y);
    }
  }
  const zoom = clamp(
    Math.min(width / Math.max(1, x1 - x0), height / Math.max(1, y1 - y0)),
    1,
    24,
  );
  const focus = projection.invert((x0 + x1) / 2, (y0 + y1) / 2) ?? {
    lat: (south + north) / 2,
    lon: lon0,
  };
  return { lon0, zoom, focus };
}

function viewProjection(
  view: MapView,
  width: number,
  height: number,
): MapProjection {
  return createProjection("equalEarth", {
    width,
    height,
    latRange: MAP_LAT_RANGE,
    center: { lat: 0, lon: view.lon0 },
    zoom: view.zoom,
    focus: view.focus,
  });
}

interface MarkerLayout {
  /** Located hop centres as fractions of the map box, by located index. */
  points: readonly { x: number; y: number }[];
  /** Midpoint of each segment's curve as fractions of the map box. */
  midpoints: readonly { x: number; y: number }[];
  /** Points along every curve as fractions of the map box, which labels keep clear of. */
  samples: readonly { x: number; y: number }[];
}

/** Marker and chip positions from the nominal projection: pure, so the server renders them where the client draws. */
function markerLayout(model: TraceModel): MarkerLayout {
  const width = NOMINAL_WIDTH;
  const height = width / MAP_ASPECT;
  const projection = viewProjection(model.view, width, height);
  const screen = createScreenPoint();
  const points = model.located.map((row) => {
    const point = (model.rows[row] as HopRow).point ?? { lat: 0, lon: 0 };
    projection.project(point.lat, point.lon, screen);
    return { x: screen.x / width, y: screen.y / height };
  });
  const curve = { x0: 0, y0: 0, cx: 0, cy: 0, x1: 0, y1: 0 };
  const middle = { x: 0, y: 0 };
  const samples: { x: number; y: number }[] = [];
  const midpoints = model.segments.map((segment) => {
    const a = (model.rows[segment.from] as HopRow).point ?? { lat: 0, lon: 0 };
    const b = (model.rows[segment.to] as HopRow).point ?? { lat: 0, lon: 0 };
    // the same unwrapping as flatPaths: `to` follows `from` the short way round
    const lambdaA = wrapLongitude(a.lon - projection.centerLon);
    const lambdaB = unwrapLongitude(lambdaA, b.lon - projection.centerLon);
    projection.projectRelative(a.lat, lambdaA, screen);
    const ax = screen.x;
    const ay = screen.y;
    projection.projectRelative(b.lat, lambdaB, screen);
    flatCurve(ax, ay, screen.x, screen.y, BEND, curve);
    for (let i = 1; i < CURVE_SAMPLES; i++) {
      quadPoint(curve, i / CURVE_SAMPLES, middle);
      samples.push({ x: middle.x / width, y: middle.y / height });
    }
    quadPoint(curve, 0.5, middle);
    return { x: middle.x / width, y: middle.y / height };
  });
  return { points, midpoints, samples };
}

interface MapLabels {
  /** By located index: the label's top-left in px, whether it fitted and whether it carries the place name. */
  hops: { visible: boolean; x: number; y: number; named: boolean }[];
  /** By segment index: the jump chip's top-left and width in px, or null for segments without a chip. */
  chips: ({ x: number; y: number; width: number } | null)[];
}

interface Point {
  x: number;
  y: number;
}

interface Box extends Point {
  width: number;
  height: number;
}

/** A hop label to place: its marker centre, the widths to try (with the place name first), priority and gap. */
interface HopLabelAnchor extends Point {
  widths: readonly number[];
  priority: number;
  gap: number;
}

/** Where a hop label went: its top-left, and which of its widths fitted. */
interface HopLabelPlacement extends Point {
  visible: boolean;
  variant: number;
}

/**
 * Jump chips sit on their segment's midpoint like a dimension on a drawing line, or just beside the line when a marker
 * is in the way. Hop numbers go beside their markers, never over a chip, and clear of the path and of the ring of the
 * selected hop and of the hop the packet is at when they can. The first and last located hops, the selected one and
 * the one the packet is at also carry their place name when there is room for it.
 */
function placeMapLabels(
  model: TraceModel,
  layout: MarkerLayout,
  boxWidth: number,
  selectedIndex: number,
  packetRow: number,
): MapLabels {
  const width = boxWidth;
  const height = boxWidth / MAP_ASPECT;
  const markers = layout.points.map((point) => ({
    x: point.x * width,
    y: point.y * height,
  }));
  const chips = placeChips(model, layout, markers, width, height);
  const lastLocated = model.located.length - 1;
  const named: boolean[] = [];
  const anchors = model.located.map((row, li): HopLabelAnchor => {
    const hop = (model.rows[row] as HopRow);
    const isNamed =
      li === 0 ||
      li === lastLocated ||
      row === selectedIndex ||
      row === packetRow;
    named.push(isNamed);
    const short = `${hop.number}`.length * LABEL_CHAR_WIDTH + 2;
    const long = `${hop.number} ${hop.place}`.length * LABEL_CHAR_WIDTH + 2;
    const ringed = row === selectedIndex || row === packetRow;
    return {
      x: ((markers[li] as { x: number; y: number; }) as { x: number; y: number; }).x,
      y: ((markers[li] as { x: number; y: number; }) as { x: number; y: number; }).y,
      widths: isNamed ? [long, short] : [short],
      priority:
        row === selectedIndex
          ? 1000
          : row === packetRow
            ? 900
            : isNamed
              ? 600
              : 100 - li,
      gap: ringed ? RING_LABEL_GAP : LABEL_GAP,
    };
  });
  // the chips are already placed, and no label covers a marker: hard obstacles. A label's own marker never collides,
  // since every label keeps a gap larger than MARKER_RADIUS from its anchor.
  const obstacles: Box[] = markers.map((marker) => ({
    x: marker.x - MARKER_RADIUS,
    y: marker.y - MARKER_RADIUS,
    width: MARKER_RADIUS * 2,
    height: MARKER_RADIUS * 2,
  }));
  for (const chip of chips) {
    if (!chip) continue;
    obstacles.push({
      x: chip.x - CHIP_MARGIN,
      y: chip.y - CHIP_MARGIN,
      width: chip.width + CHIP_MARGIN * 2,
      height: CHIP_HEIGHT + CHIP_MARGIN * 2,
    });
  }
  // the path, and the rings of the selected hop and of the packet's hop, are points labels keep clear of when they can
  const points: Point[] = [];
  for (const sample of layout.samples) {
    const x = sample.x * width;
    const y = sample.y * height;
    if (markers.some((marker) => Math.hypot(marker.x - x, marker.y - y) < 10))
      continue;
    points.push({ x, y });
  }
  model.located.forEach((row, li) => {
    if (row !== selectedIndex && row !== packetRow) return;
    for (let k = 0; k < 8; k++) {
      const angle = (k / 8) * TAU;
      points.push({
        x: ((markers[li] as { x: number; y: number; }) as { x: number; y: number; }).x + Math.cos(angle) * 12,
        y: ((markers[li] as { x: number; y: number; }) as { x: number; y: number; }).y + Math.sin(angle) * 12,
      });
    }
  });
  const placed = placeHopLabels(anchors, obstacles, points, width, height);
  return {
    hops: placed.map((placement, li) => ({
      visible: placement.visible,
      x: placement.x,
      y: placement.y,
      named: (named[li] as boolean) && placement.variant === 0,
    })),
    chips,
  };
}

/**
 * Greedy label placement by priority, like placeLabels in the geo module, with fixed obstacles: each label tries
 * right, left, top and bottom of its marker and takes the first box inside the map that overlaps no chip and no placed
 * label, first keeping clear of the other markers and of `points`, then allowing them. A label that does not fit with
 * its place name tries again with the hop number only; one that fits nowhere stays hidden.
 */
function placeHopLabels(
  anchors: readonly HopLabelAnchor[],
  obstacles: readonly Box[],
  points: readonly Point[],
  width: number,
  height: number,
): HopLabelPlacement[] {
  const taken: Box[] = [...obstacles];
  const placements: HopLabelPlacement[] = anchors.map((anchor) => ({
    visible: false,
    x: anchor.x,
    y: anchor.y,
    variant: 0,
  }));
  const order = anchors
    .map((_, index) => index)
    .sort((a, b) => (anchors[b] as HopLabelAnchor).priority - (anchors[a] as HopLabelAnchor).priority || a - b);
  const near = (point: Point, box: Box) =>
    point.x > box.x - POINT_MARGIN &&
    point.x < box.x + box.width + POINT_MARGIN &&
    point.y > box.y - POINT_MARGIN &&
    point.y < box.y + box.height + POINT_MARGIN;
  const fits = (index: number, box: Box, avoidPoints: boolean) => {
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > width ||
      box.y + box.height > height
    )
      return false;
    for (const other of taken) {
      const apart =
        box.x >= other.x + other.width ||
        box.x + box.width <= other.x ||
        box.y >= other.y + other.height ||
        box.y + box.height <= other.y;
      if (!apart) return false;
    }
    if (!avoidPoints) return true;
    for (let j = 0; j < anchors.length; j++) {
      if (j !== index && near((anchors[j] as HopLabelAnchor), box)) return false;
    }
    return !points.some((point) => near(point, box));
  };
  for (const index of order) {
    const anchor = (anchors[index] as HopLabelAnchor);
    const h = LABEL_HEIGHT;
    placing: for (let variant = 0; variant < anchor.widths.length; variant++) {
      const w = (anchor.widths[variant] as number);
      for (const avoidPoints of [true, false]) {
        for (const side of LABEL_SIDES) {
          const box: Box = {
            x:
              side === "right"
                ? anchor.x + anchor.gap
                : side === "left"
                  ? anchor.x - anchor.gap - w
                  : anchor.x - w / 2,
            y:
              side === "top"
                ? anchor.y - anchor.gap - h
                : side === "bottom"
                  ? anchor.y + anchor.gap
                  : anchor.y - h / 2,
            width: w,
            height: h,
          };
          if (!fits(index, box, avoidPoints)) continue;
          placements[index] = { visible: true, x: box.x, y: box.y, variant };
          taken.push(box);
          break placing;
        }
      }
    }
  }
  return placements;
}

/**
 * Chip boxes for long-haul segments: centred on the curve's midpoint, else moved off the line along its normal, first
 * to the outside of the bend, whichever keeps clear of every marker, of the box edges and of earlier chips.
 */
function placeChips(
  model: TraceModel,
  layout: MarkerLayout,
  markers: readonly { x: number; y: number }[],
  width: number,
  height: number,
) {
  const placed: { x: number; y: number; width: number }[] = [];
  return model.segments.map((segment, k) => {
    if (!segment.jump) return null;
    const chipWidth = jumpText(segment.delta).length * CHIP_CHAR_WIDTH + 14;
    const middle = {
      x: ((layout.midpoints[k] as { x: number; y: number; }) as { x: number; y: number; }).x * width,
      y: ((layout.midpoints[k] as { x: number; y: number; }) as { x: number; y: number; }).y * height,
    };
    const from = ((markers[model.located.indexOf(segment.from)] as { x: number; y: number; }) as { x: number; y: number; });
    const to = ((markers[model.located.indexOf(segment.to)] as { x: number; y: number; }) as { x: number; y: number; });
    const chord = Math.max(1e-6, Math.hypot(to.x - from.x, to.y - from.y));
    // the left normal of travel: the side the curve bends to
    const nx = (to.y - from.y) / chord;
    const ny = -(to.x - from.x) / chord;
    let best: { x: number; y: number; width: number } | null = null;
    let bestScore = -Infinity;
    for (const offset of [0, 13, -13, 22, -22]) {
      const box = {
        x: clamp(
          middle.x + nx * offset - chipWidth / 2,
          2,
          width - chipWidth - 2,
        ),
        y: clamp(
          middle.y + ny * offset - CHIP_HEIGHT / 2,
          2,
          height - CHIP_HEIGHT - 2,
        ),
        width: chipWidth,
      };
      // clearance: the distance from the box to the closest marker, and no overlap with earlier chips
      let clearance = Infinity;
      for (const marker of markers) {
        const dx = Math.max(
          box.x - marker.x,
          0,
          marker.x - (box.x + chipWidth),
        );
        const dy = Math.max(
          box.y - marker.y,
          0,
          marker.y - (box.y + CHIP_HEIGHT),
        );
        clearance = Math.min(clearance, Math.hypot(dx, dy));
      }
      const overlaps = placed.some(
        (other) =>
          box.x < other.x + other.width + 3 &&
          box.x + chipWidth + 3 > other.x &&
          box.y < other.y + CHIP_HEIGHT + 3 &&
          box.y + CHIP_HEIGHT + 3 > other.y,
      );
      const score =
        (overlaps ? -100 : 0) +
        Math.min(clearance, CHIP_CLEARANCE) -
        Math.abs(offset) * 0.01;
      if (score > bestScore) {
        bestScore = score;
        best = box;
      }
      if (!overlaps && clearance >= CHIP_CLEARANCE) break;
    }
    if (best) placed.push(best);
    return best;
  });
}

/* Engine --------------------------------------------------------------------------------------------- */

/** Dots along one projected curve, every DOT_SPACING px, with their distance along it. */
interface Track {
  table: ArcLengthTable;
  count: number;
  x: Float32Array;
  y: Float32Array;
  s: Float32Array;
}

interface SegmentGeometry {
  /** The main curve, then its copies across the map's seam. */
  tracks: Track[];
  /** Heading of the packet as it lands, in radians: the dwell ring starts there and turns clockwise. */
  arrivalAngle: number;
}

/** Grid positions of the lattice around a point (land or not), for rings and pings that must read as full circles. */
interface DiscDots {
  count: number;
  x: Float32Array;
  y: Float32Array;
  distance: number[];
  /** Clockwise position around the hop from the ring's start angle, 0 to 1. */
  turn: Float32Array;
  jitter: Float32Array;
  land: Uint8Array;
}

interface HopGeometry {
  x: number;
  y: number;
  ring: DiscDots;
}

interface TraceGeometry {
  projection: MapProjection;
  lattice: DotLattice;
  dotSize: number;
  segments: SegmentGeometry[];
  hops: HopGeometry[];
  /** Grid dots around the destination for the ping, or null. */
  ping: DiscDots | null;
  /** Where the land reveal starts (the first located hop, else the middle) and its distance to the farthest corner. */
  revealX: number;
  revealY: number;
  revealReach: number;
}

interface TraceBatches {
  path: DotBatch;
  land: DotBatch;
}

/** Everything the animation loop owns. Lives in a ref, never in React state. */
interface TraceEngine {
  model: TraceModel;
  /** Playback clock in seconds at speed 1, from 0 to total + TAIL. */
  clock: number;
  playing: boolean;
  /** The end has been reached (the clock may still run the ping). */
  finished: boolean;
  restart: boolean;
  speed: number;
  /** The last row and arrival reported to React. */
  cursor: number;
  arrived: number;
  selected: number;
  /** Per segment: 1 normally, DIM when a selection leaves it out; and 1 for the selected hop's incoming segment. */
  emphasis: Spring[];
  hot: Spring[];
  /** Per located hop: the selection ring, 0 to 1, and whether it is filling (clockwise) or fading. */
  selectLight: number[];
  selectRising: boolean[];
  /** The model the geometry was built for (or a model with the same hops), and its key. */
  layoutModel: TraceModel | null;
  layoutKey: string | null;
  /** Seconds of the land reveal so far, up to REVEAL_SECONDS. */
  reveal: number;
  width: number;
  height: number;
  geometry: TraceGeometry | null;
  ink: GeoInk | null;
  batches: TraceBatches | null;
  inkStale: boolean;
  baked: boolean;
  dirty: boolean;
  sparks: Sparks;
  fxDirty: boolean;
}

function createEngine(model: TraceModel, playing: boolean): TraceEngine {
  return {
    model,
    clock: playing ? 0 : model.timing.total + TAIL,
    playing,
    finished: !playing,
    restart: false,
    speed: 1,
    cursor: playing ? -1 : model.rows.length,
    arrived:
      playing || model.located.length === 0
        ? -1
        : (model.located[model.located.length - 1] as number),
    selected: -1,
    emphasis: [],
    hot: [],
    selectLight: [],
    selectRising: [],
    layoutModel: null,
    layoutKey: null,
    reveal: 0,
    width: 0,
    height: 0,
    geometry: null,
    ink: null,
    batches: null,
    inkStale: true,
    baked: false,
    dirty: true,
    sparks: new Sparks(),
    fxDirty: false,
  };
}

/** New ink after a theme change: the path ramp runs from the accent to the shine (deep violet in light, white in dark). */
function refreshInk(engine: TraceEngine, palette: GeoPalette) {
  const ink = geoInk(palette);
  engine.ink = ink;
  const pathStops = [ink.accent, ink.shine];
  if (engine.batches) {
    engine.batches.path.setRamp(pathStops);
    engine.batches.land.setRamp([ink.land]);
  } else {
    engine.batches = {
      path: createDotBatch(2048, pathStops, { tones: 16, levels: 32 }),
      land: createDotBatch(8192, [ink.land], { tones: 1, levels: 16 }),
    };
  }
  engine.inkStale = false;
  engine.baked = false;
  engine.dirty = true;
}

const pathPoint = { x: 0, y: 0, angle: 0 };

/** A new size or trace: the projection, the lattice, every curve and every ring. */
function layoutEngine(engine: TraceEngine, width: number, height: number) {
  const model = engine.model;
  const projection = viewProjection(model.view, width, height);
  const pitch = width < NARROW_WIDTH ? 3 : 4;
  const lattice = mapLattice(projection, { pitch });
  const land = new Set<number>();
  for (let i = 0; i < lattice.count; i++)
    land.add((lattice.row[i] as number) * GRID_STRIDE + (lattice.column[i] as number));

  const segments = model.segments.map((segment): SegmentGeometry => {
    const from = (model.rows[segment.from] as HopRow).point ?? { lat: 0, lon: 0 };
    const to = (model.rows[segment.to] as HopRow).point ?? { lat: 0, lon: 0 };
    const tables = flatPaths(projection, from, to, {
      bend: BEND,
      segments: 48,
    });
    const tracks = tables.map((table) => sampleTrack(table));
    const main = (tables[0] as ArcLengthTable);
    let arrivalAngle = -Math.PI / 2;
    if (main && main.length > 0.5) {
      pointAtDistance(main, main.length, pathPoint);
      arrivalAngle = pathPoint.angle;
    }
    return { tracks, arrivalAngle };
  });

  const screen = createScreenPoint();
  const hops = model.located.map((row, li): HopGeometry => {
    const point = (model.rows[row] as HopRow).point ?? { lat: 0, lon: 0 };
    projection.project(point.lat, point.lon, screen);
    // the ring starts where the packet lands heading; the first hop has no incoming segment and starts at the top
    const startAngle =
      li > 0 ? ((segments[li - 1] as SegmentGeometry)?.arrivalAngle ?? -Math.PI / 2) : -Math.PI / 2;
    return {
      x: screen.x,
      y: screen.y,
      ring: discDots(
        projection,
        pitch,
        land,
        screen.x,
        screen.y,
        RING_INNER,
        RING_OUTER,
        startAngle,
      ),
    };
  });

  let ping: DiscDots | null = null;
  if (model.pingRow >= 0) {
    const hop = ((hops[model.located.indexOf(model.pingRow)] as HopGeometry));
    if (hop)
      ping = discDots(
        projection,
        pitch,
        land,
        hop.x,
        hop.y,
        0,
        PING_RADIUS + 12,
        0,
      );
  }

  const origin = (hops[0] as HopGeometry) ?? { x: width / 2, y: height / 2 };
  const reach = Math.max(
    Math.hypot(origin.x, origin.y),
    Math.hypot(width - origin.x, origin.y),
    Math.hypot(origin.x, height - origin.y),
    Math.hypot(width - origin.x, height - origin.y),
    1,
  );

  engine.geometry = {
    projection,
    lattice,
    dotSize: pitch >= 4 ? 1.6 : 1.3,
    segments,
    hops,
    ping,
    revealX: origin.x,
    revealY: origin.y,
    revealReach: reach,
  };
  engine.layoutModel = model;
  engine.layoutKey = model.key;
  engine.width = width;
  engine.height = height;
  engine.baked = false;
  engine.dirty = true;
  // springs follow the segment and hop count; a new trace starts with every segment at full strength
  engine.emphasis = model.segments.map(
    (_, k) => (engine.emphasis[k] as Spring) ?? { position: 1, velocity: 0 },
  );
  engine.hot = model.segments.map(
    (_, k) => (engine.hot[k] as Spring) ?? { position: 0, velocity: 0 },
  );
  engine.selectLight = model.located.map(
    (_, li) => (engine.selectLight[li] as number) ?? 0,
  );
  engine.selectRising = model.located.map(
    (_, li) => (engine.selectRising[li] as boolean) ?? false,
  );
}

/** Row stride for grid keys: wider than any lattice can get. */
const GRID_STRIDE = 1 << 16;

function sampleTrack(table: ArcLengthTable): Track {
  const capacity = Math.floor(table.length / DOT_SPACING) + 2;
  const track: Track = {
    table,
    count: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    s: new Float32Array(capacity),
  };
  forEachDot(table, DOT_SPACING, 0, table.length, (x, y, s) => {
    if (track.count >= capacity) return;
    track.x[track.count] = x;
    track.y[track.count] = y;
    track.s[track.count] = s;
    track.count++;
  });
  return track;
}

/**
 * The lattice's grid positions within [inner, outer] px of a point, whether land or water, so a dwell ring or a ping
 * reads as a whole circle even at a coastal hop. They sit exactly on the lattice grid, so land dots coincide.
 */
function discDots(
  projection: MapProjection,
  pitch: number,
  land: ReadonlySet<number>,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  startAngle: number,
): DiscDots {
  const { x0, y0 } = projection.frame;
  const c0 = Math.ceil((cx - outer - x0) / pitch - 0.5);
  const c1 = Math.floor((cx + outer - x0) / pitch - 0.5);
  const r0 = Math.ceil((cy - outer - y0) / pitch - 0.5);
  const r1 = Math.floor((cy + outer - y0) / pitch - 0.5);
  const xs: number[] = [];
  const ys: number[] = [];
  const distance: number[] = [];
  const turn: number[] = [];
  const jitter: number[] = [];
  const isLand: number[] = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const x = x0 + (c + 0.5) * pitch;
      const y = y0 + (r + 0.5) * pitch;
      const d = Math.hypot(x - cx, y - cy);
      if (d < inner || d > outer) continue;
      xs.push(x);
      ys.push(y);
      distance.push(d);
      // screen y points down, so a growing atan2 angle turns clockwise
      const angle = Math.atan2(y - cy, x - cx) - startAngle;
      turn.push((((angle % TAU) + TAU) % TAU) / TAU);
      jitter.push(hash(r * 31 + c * 7 + 0.5));
      isLand.push(land.has(r * GRID_STRIDE + c) ? 1 : 0);
    }
  }
  return {
    count: xs.length,
    x: Float32Array.from(xs),
    y: Float32Array.from(ys),
    distance,
    turn: Float32Array.from(turn),
    jitter: Float32Array.from(jitter),
    land: Uint8Array.from(isLand),
  };
}

/**
 * The land lattice in the quiet land ink, fading out toward the box edges so the map has no hard cut. While `progress`
 * is below 1 the land grows out from the first located hop behind an uneven front (threshold = n·0.82 + jitter·0.18),
 * the dots at the front a little brighter than the land behind it.
 */
function drawBase(
  surface: CanvasSurface,
  geometry: TraceGeometry,
  batch: DotBatch,
  progress: number,
) {
  const { context, width, height } = surface;
  context.clearRect(0, 0, width, height);
  const { lattice, dotSize, revealX, revealY, revealReach } = geometry;
  const growing = progress < 1;
  const front = easeOutCubic(progress) * (1 + REVEAL_SOFTNESS * 2);
  for (let i = 0; i < lattice.count; i++) {
    const x = (lattice.x[i] as number);
    const y = (lattice.y[i] as number);
    const edge = smoothstep(
      0,
      EDGE_FADE,
      Math.min(x, y, width - x, height - y),
    );
    let shown = 1;
    let crest = 0;
    if (growing) {
      const threshold =
        (Math.hypot(x - revealX, y - revealY) / revealReach) * 0.82 +
        (lattice.jitter[i] as number) * 0.18;
      shown = clamp((front - threshold) / REVEAL_SOFTNESS, 0, 1);
      crest = shown * (1 - shown) * 4;
    }
    batch.add(x, y, dotSize, 0, edge * (0.5 * shown + 0.4 * crest));
  }
  batch.flush(context);
}

/** Selection springs and rings. Returns whether anything moved. */
function stepEmphasis(engine: TraceEngine, delta: number, reduced: boolean) {
  const model = engine.layoutModel;
  if (!model) return false;
  const selected = engine.selected;
  const anySelected = selected >= 0 && selected < model.rows.length;
  let moving = false;
  model.segments.forEach((segment, k) => {
    const emphasis = (engine.emphasis[k] as Spring);
    const hot = (engine.hot[k] as Spring);
    if (!emphasis || !hot) return;
    const isSelected = anySelected && segment.to === selected;
    moving =
      settleSpring(
        emphasis,
        !anySelected || isSelected ? 1 : DIM,
        delta,
        reduced,
        EMPHASIS_SPRING,
      ) || moving;
    moving =
      settleSpring(hot, isSelected ? 1 : 0, delta, reduced, EMPHASIS_SPRING) ||
      moving;
  });
  model.located.forEach((row, li) => {
    const target = row === selected ? 1 : 0;
    const light = (engine.selectLight[li] as number) ?? 0;
    if (light === target) return;
    engine.selectRising[li] = target > light;
    engine.selectLight[li] = reduced
      ? target
      : target > light
        ? Math.min(target, light + delta / SELECT_FILL)
        : Math.max(target, light - delta / SELECT_FADE);
    moving = true;
  });
  return moving;
}

/**
 * The path drawn so far, the dwell and selection rings, the packet and the ping, as a function of the clock. Dot
 * squares start on the device pixel grid, so the path reads as crisp pixel rows, like the lattice under it.
 */
function drawTrace(
  engine: TraceEngine,
  surface: CanvasSurface,
  batch: DotBatch,
  reduced: boolean,
) {
  const { context, width, height, dpr } = surface;
  context.clearRect(0, 0, width, height);
  const geometry = engine.geometry;
  const model = engine.layoutModel;
  if (!geometry || !model) return;
  const t = engine.clock;
  const { timing } = model;
  const selected = engine.selected;
  const dimAll =
    selected >= 0 &&
    selected < model.rows.length &&
    (model.rows[selected] as HopRow).kind !== "located";
  const dimMap = dimAll ? DIM : 1;
  const base = engine.ink?.dark ? PATH_ALPHA.dark : PATH_ALPHA.light;

  // segments: dotted, dashed for long-haul jumps, drawn up to the packet with a hot wake behind it
  model.segments.forEach((segment, k) => {
    const span = (timing.travel[k] as Span);
    const shape = (geometry.segments[k] as SegmentGeometry);
    if (!span || !shape || t <= span.start) return;
    const progress =
      t >= span.end
        ? 1
        : TRAVEL_EASE((t - span.start) / (span.end - span.start));
    const traveling = progress < 1;
    const emphasis = clamp((engine.emphasis[k] as Spring)?.position ?? 1, 0, 1.2) * dimMap;
    const hot = clamp((engine.hot[k] as Spring)?.position ?? 0, 0, 1);
    const size = DOT_SIZE * (1 + 0.5 * hot);
    for (const track of shape.tracks) {
      const length = track.table.length;
      const head = progress * length;
      for (let j = 0; j < track.count; j++) {
        const s = (track.s[j] as number);
        if (s > head) break;
        if (s < TRIM || s > length - TRIM) continue;
        if (segment.jump && Math.round(s / DOT_SPACING) % 6 >= 3) continue;
        const heat = traveling ? Math.exp(-(head - s) / 22) : 0;
        const alpha = (base + (1 - base) * hot) * emphasis + heat * 0.45;
        const tone = Math.max(hot * 0.55, heat);
        batch.add(
          snapCenter((track.x[j] as number), size, dpr),
          snapCenter((track.y[j] as number), size, dpr),
          size,
          tone,
          Math.min(1, alpha),
        );
      }
    }
  });

  // rings: the dwell fills clockwise from the landing heading; a selected hop's ring fills the same way and holds
  model.located.forEach((_, li) => {
    const hop = (geometry.hops[li] as HopGeometry);
    const span = (timing.dwell[li] as Span);
    if (!hop || !span) return;
    let share = 0;
    let fade = 0;
    if (t >= span.start && !reduced) {
      share = clamp(
        (t - span.start) / Math.max(1e-6, span.end - span.start),
        0,
        1,
      );
      fade = t <= span.end ? 1 : 1 - smoothstep(0, RING_FADE, t - span.end);
    }
    const select = (engine.selectLight[li] as number) ?? 0;
    const rising = (engine.selectRising[li] as boolean) ?? false;
    if (fade <= 0 && select <= 0) return;
    const ring = hop.ring;
    // the whole ring shows faintly as a track while it fills, so it reads as a progress ring
    const track =
      Math.max(share < 1 ? fade : 0, rising && select < 1 ? 1 : 0) * 0.16;
    for (let i = 0; i < ring.count; i++) {
      const threshold = (ring.turn[i] as number) * 0.9 + (ring.jitter[i] as number) * 0.1;
      let lit = 0;
      let lead = 0;
      if (fade > 0) {
        const ahead = share - threshold;
        lit = clamp(ahead / 0.05, 0, 1) * fade;
        if (ahead > 0 && share < 1) lead = Math.exp(-ahead / 0.05) * fade;
      }
      const selectLit = rising
        ? clamp((select - threshold) / 0.05, 0, 1)
        : select;
      const shown = Math.max(lit, selectLit * 0.75);
      const depth = ((ring.distance[i] as number) - RING_INNER) / (RING_OUTER - RING_INNER);
      const alpha =
        (Math.max(track, shown * (0.95 - 0.4 * depth)) + lead * 0.35) * dimMap;
      if (alpha < 0.02) continue;
      batch.add(
        snapCenter((ring.x[i] as number), geometry.dotSize, dpr),
        snapCenter((ring.y[i] as number), geometry.dotSize, dpr),
        geometry.dotSize,
        Math.max(lead, 0.08),
        Math.min(1, alpha),
      );
    }
  });

  if (!reduced) {
    drawPacket(engine, geometry, model, batch, dpr);
    drawPing(engine, geometry, model, batch);
  }
  batch.flush(context);
}

const TAIL_GAP = 2.6;
const TAIL_ALPHA = [1, 0.7, 0.42, 0.2];

/** The packet: a hot head with a short tail, on its segment while travelling and orbiting the hop while it waits. */
function drawPacket(
  engine: TraceEngine,
  geometry: TraceGeometry,
  model: TraceModel,
  batch: DotBatch,
  dpr: number,
) {
  const t = engine.clock;
  const { timing } = model;
  if (t >= timing.total || model.located.length === 0) return;
  const put = (x: number, y: number, k: number) => {
    const size = k === 0 ? 3 : 1.75;
    batch.add(
      snapCenter(x, size, dpr),
      snapCenter(y, size, dpr),
      size,
      k === 0 ? 1 : 0.65 - k * 0.2,
      (TAIL_ALPHA[k] as number),
    );
  };
  for (let k = 0; k < model.segments.length; k++) {
    const span = (timing.travel[k] as Span);
    const shape = (geometry.segments[k] as SegmentGeometry);
    if (!span || !shape || t < span.start || t >= span.end) continue;
    const progress = TRAVEL_EASE((t - span.start) / (span.end - span.start));
    for (const track of shape.tracks) {
      const head = progress * track.table.length;
      for (let j = 0; j < TAIL_ALPHA.length; j++) {
        const along = head - j * TAIL_GAP;
        if (along < 0) break;
        pointAtDistance(track.table, along, pathPoint);
        put(pathPoint.x, pathPoint.y, j);
      }
    }
    return;
  }
  for (let li = 0; li < model.located.length; li++) {
    const span = (timing.dwell[li] as Span);
    const hop = (geometry.hops[li] as HopGeometry);
    if (!span || !hop || t < span.start || t >= span.end) continue;
    const share = (t - span.start) / Math.max(1e-6, span.end - span.start);
    const startAngle =
      li > 0
        ? ((geometry.segments[li - 1] as SegmentGeometry)?.arrivalAngle ?? -Math.PI / 2)
        : -Math.PI / 2;
    // out of the centre into the orbit, once round, and back in to leave along the next segment
    const radius =
      ORBIT * smoothstep(0, 0.16, share) * (1 - smoothstep(0.86, 1, share));
    const angle = startAngle + share * TAU;
    const step = TAIL_GAP / Math.max(1.5, radius);
    for (let j = 0; j < TAIL_ALPHA.length; j++) {
      const a = angle - Math.min(0.9, step) * j;
      put(hop.x + Math.cos(a) * radius, hop.y + Math.sin(a) * radius, j);
    }
    return;
  }
}

/** Two rings of land dots run out from the destination behind an uneven front, the second one fainter. */
function drawPing(
  engine: TraceEngine,
  geometry: TraceGeometry,
  model: TraceModel,
  batch: DotBatch,
) {
  const ping = geometry.ping;
  const since = engine.clock - model.timing.total;
  if (
    !ping ||
    !engine.finished ||
    since <= 0 ||
    since >= PING_SECONDS + PING_DELAY
  )
    return;
  for (let i = 0; i < ping.count; i++) {
    if (!(ping.land[i] as number)) continue;
    let value = 0;
    for (let ring = 0; ring < 2; ring++) {
      const p = (since - ring * PING_DELAY) / PING_SECONDS;
      if (p <= 0 || p >= 1) continue;
      const radius = easeOutCubic(p) * PING_RADIUS;
      value = Math.max(
        value,
        ringFront((ping.distance[i] as number), radius, 4.5, (ping.jitter[i] as number), 5) *
          Math.pow(1 - p, 1.2) *
          (ring === 0 ? 1 : 0.65),
      );
    }
    if (value < 0.04) continue;
    batch.add((ping.x[i] as number), (ping.y[i] as number), geometry.dotSize, value, value);
  }
}

/** Sparks from the destination on the layer that reaches past the map. Returns whether any are alive. */
function drawSparks(
  engine: TraceEngine,
  surface: CanvasSurface,
  delta: number,
) {
  const { context, width, height } = surface;
  if (!engine.sparks.active) {
    if (engine.fxDirty) {
      context.clearRect(0, 0, width, height);
      engine.fxDirty = false;
    }
    return false;
  }
  engine.fxDirty = true;
  context.clearRect(0, 0, width, height);
  return engine.sparks.step(context, delta);
}

export default GeoTraceroute;
