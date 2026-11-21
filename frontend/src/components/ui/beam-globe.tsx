import { useEffect, useRef } from "react";

// [city, lat, lon]. Broad city centers only, no individual locations.
const CITIES = {
  blr: ["Bengaluru", 12.97, 77.59],
  mum: ["Mumbai", 19.08, 72.88],
  sin: ["Singapore", 1.35, 103.82],
  syd: ["Sydney", -33.87, 151.21],
  lon: ["London", 51.51, -0.13],
  ber: ["Berlin", 52.52, 13.4],
  dxb: ["Dubai", 25.2, 55.27],
  nyc: ["New York", 40.71, -74],
  sfo: ["San Francisco", 37.77, -122.42],
  aus: ["Austin", 30.27, -97.74],
  tor: ["Toronto", 43.65, -79.38],
  sao: ["Sao Paulo", -23.55, -46.63],
  tok: ["Tokyo", 35.68, 139.69],
  lag: ["Lagos", 6.52, 3.38],
  jnb: ["Johannesburg", -26.2, 28.05],
  par: ["Paris", 48.86, 2.35],
  tlv: ["Tel Aviv", 32.08, 34.78],
  sel: ["Seoul", 37.57, 126.98],
} as const;

// Illustrative city-center routes only: a link sent here, opened there. Not customer activity.
const EDGES: [CityKey, CityKey][] = [
  ['blr', 'lon'], ['lon', 'nyc'], ['nyc', 'sfo'], ['sin', 'syd'],
  ['ber', 'blr'], ['dxb', 'mum'], ['par', 'sin'], ['tor', 'lon'],
];
type CityKey = keyof typeof CITIES;
const RAD = Math.PI / 180;

export function BeamGlobe() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const canvas: HTMLCanvasElement = cv;
    const x: CanvasRenderingContext2D = ctx;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let dots: number[] = [];
    let W = 0,
      R = 0,
      dpr = 1;
    let yaw = -60;
    let elapsed = 0;
    let visible = false,
      raf = 0,
      last = 0,
      alive = true;
    const tilt = 22;
    const life: number[] = EDGES.map(() => (reduce.matches ? 1 : 0));
    const colors = getComputedStyle(canvas);
    const accent = colors.getPropertyValue("--cb-accent").trim();
    const land = colors.getPropertyValue("--cb-accent2").trim();
    const ground = colors.getPropertyValue("--cb-bg-hover").trim();

    function proj(lat: number, lon: number, h = 0): [number, number, number] {
      const la = lat * RAD,
        lo = (lon + yaw) * RAD,
        t = tilt * RAD,
        k = R * (1 + h);
      const cx = Math.cos(la) * Math.sin(lo),
        cy = Math.sin(la),
        cz = Math.cos(la) * Math.cos(lo);
      const y2 = cy * Math.cos(t) - cz * Math.sin(t);
      const z2 = cy * Math.sin(t) + cz * Math.cos(t);
      return [W / 2 + cx * k, W / 2 - y2 * k, z2];
    }

    // Great-circle interpolation between two [name, lat, lon] cities.
    function gc(
      a: readonly [string, number, number],
      b: readonly [string, number, number],
      t: number,
    ): [number, number, number] {
      const la1 = a[1] * RAD,
        lo1 = a[2] * RAD,
        la2 = b[1] * RAD,
        lo2 = b[2] * RAD;
      const d =
        Math.acos(
          Math.min(
            1,
            Math.sin(la1) * Math.sin(la2) +
              Math.cos(la1) * Math.cos(la2) * Math.cos(lo2 - lo1),
          ),
        ) || 1e-6;
      const A = Math.sin((1 - t) * d) / Math.sin(d),
        B = Math.sin(t * d) / Math.sin(d);
      const X =
        A * Math.cos(la1) * Math.cos(lo1) + B * Math.cos(la2) * Math.cos(lo2);
      const Y =
        A * Math.cos(la1) * Math.sin(lo1) + B * Math.cos(la2) * Math.sin(lo2);
      const Z = A * Math.sin(la1) + B * Math.sin(la2);
      return [Math.atan2(Z, Math.hypot(X, Y)) / RAD, Math.atan2(Y, X) / RAD, d];
    }

    function draw() {
      x.setTransform(dpr, 0, 0, dpr, 0, 0);
      x.clearRect(0, 0, W, W);
      x.beginPath();
      x.arc(W / 2, W / 2, R, 0, 7);
      x.fillStyle = ground;
      x.fill();
      const s = Math.max(1.1, R / 230);
      x.fillStyle = land;
      for (let i = 0; i + 1 < dots.length; i += 2) {
        const lat = dots[i], lon = dots[i + 1];
        if (lat === undefined || lon === undefined) continue;
        const p = proj(lat / 10, lon / 10);
        if (p[2] <= 0) continue;
        x.globalAlpha = 0.3 + 0.6 * p[2];
        x.fillRect(p[0] - s / 2, p[1] - s / 2, s, s);
      }
      x.globalAlpha = 1;
      EDGES.forEach(([from, to], i) => {
        const L = life[i] ?? 0;
        if (L <= 0) return;
        const a = CITIES[from],
          b = CITIES[to],
          col = accent;
        const t = Math.min(L, 1);
        const fade = reduce.matches
          ? 1
          : L > 1
            ? Math.max(0, 1 - (L - 1) / 0.6)
            : 1;
        const n = 40,
          pts: [number, number, number][] = [];
        for (let k = 0; k <= n; k++) {
          const u = (k / n) * t,
            q = gc(a, b, u);
          pts.push(
            proj(
              q[0],
              q[1],
              0.18 * Math.sin(Math.PI * u) * Math.min(1, q[2] * 1.6 + 0.1),
            ),
          );
        }
        x.lineWidth = 1.4;
        x.strokeStyle = col;
        for (let k = 1; k < pts.length; k++) {
          const prev = pts[k - 1];
          const point = pts[k];
          if (!prev || !point) continue;
          if (point[2] <= 0 && prev[2] <= 0) continue;
          x.globalAlpha = 0.75 * fade;
          x.beginPath();
          x.moveTo(prev[0], prev[1]);
          x.lineTo(point[0], point[1]);
          x.stroke();
        }
        const h = pts[pts.length - 1];
        x.fillStyle = col;
        if (h && h[2] > 0 && t < 1) {
          x.globalAlpha = fade;
          x.beginPath();
          x.arc(h[0], h[1], 3, 0, 7);
          x.fill();
        }
        [a, b].forEach((c) => {
          const p = proj(c[1], c[2]);
          if (p[2] <= 0) return;
          x.globalAlpha = 0.9 * fade;
          x.beginPath();
          x.arc(p[0], p[1], 2.6, 0, 7);
          x.fill();
        });
      });
      x.globalAlpha = 1;
    }

    function size() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.getBoundingClientRect().width;
      canvas.width = W * dpr;
      canvas.height = W * dpr;
      R = W * 0.4;
      draw();
    }

    function tick(ts: number) {
      raf = 0;
      if (!visible || !alive || document.hidden || reduce.matches) return;
      const dt = Math.min(0.05, (ts - (last || ts)) / 1000);
      last = ts;
      elapsed += dt;
      // Settle the globe first, then draw exactly one route at a time.
      yaw = -60 - 12 * (1 - Math.pow(1 - Math.min(elapsed / 1.2, 1), 3));
      const routeTime = Math.max(0, elapsed - 1.2);
      const active = Math.floor(routeTime / 3) % EDGES.length;
      life.forEach((_, i) => { life[i] = i === active ? (routeTime % 3) / 1.6 : 0; });
      draw();
      raf = requestAnimationFrame(tick);
    }
    function start() {
      if (!raf && visible && !document.hidden && !reduce.matches) {
        last = 0;
        raf = requestAnimationFrame(tick);
      }
    }

    function syncAnimation() {
      cancelAnimationFrame(raf);
      raf = 0;
      start();
    }
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      syncAnimation();
    });
    io.observe(canvas);
    const resize = new ResizeObserver(size);
    resize.observe(canvas);
    document.addEventListener("visibilitychange", syncAnimation);

    const onMotion = () => {
      elapsed = 0;
      yaw = -72;
      life.fill(reduce.matches ? 1 : 0);
      syncAnimation();
      draw();
    };
    reduce.addEventListener("change", onMotion);

    fetch(`${import.meta.env.BASE_URL}beam-globe-land.json`)
      .then((r) => { if (!r.ok) throw new Error("Globe map unavailable"); return r.json(); })
      .then((d: number[]) => {
        if (!alive) return;
        dots = d;
        draw();
      })
      .catch(() => {});

    size();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", syncAnimation);
      reduce.removeEventListener("change", onMotion);
    };
  }, []);

  return <figure className="m-0 min-w-0">
    <canvas ref={canvasRef} aria-hidden="true" className="block aspect-square w-full" />
    <figcaption className="text-center text-sm text-cb-muted">A link sent here, opened there. Illustrative routes.</figcaption>
  </figure>;
}
