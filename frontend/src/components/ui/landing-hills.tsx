// Canvas painting adapted from kedhareswer Meadow Rise Footer, 21st.dev 44510.
import { useEffect, useRef } from 'react';

export function LandingHills() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let visible = false;
    let layers: HTMLCanvasElement[] = [];
    let width = 0;
    const height = 260;
    const palette = [['#EDD3C5', '#DFBFA9'], ['#E5B899', '#CB9979'], ['#D8A181', '#B97E60'], ['#CB7752', '#A65F40'], ['#B3502F', '#894128'], ['#6A4430', '#241C14']] as const;
    const paint = () => {
      width = Math.max(1, Math.round(canvas.clientWidth));
      canvas.width = width;
      canvas.height = height;
      layers = palette.map(([lit, shadow], i) => {
        const layer = document.createElement('canvas');
        layer.width = width;
        layer.height = height;
        const g = layer.getContext('2d');
        if (!g) return layer;
        const spec = mrfLayerSpec(i, 6, 3);
        const fill = g.createLinearGradient(0, height * spec.base - height * spec.amp, 0, height);
        fill.addColorStop(0, lit);
        fill.addColorStop(1, shadow);
        g.fillStyle = fill;
        g.beginPath();
        g.moveTo(0, height);
        for (let x = 0; x <= width; x += 2) g.lineTo(x, mrfCrestAt(spec, x, width, height));
        g.lineTo(width, height);
        g.closePath();
        g.fill();
        return layer;
      });
    };
    const draw = (time: number) => {
      if (!visible) return;
      ctx.fillStyle = '#FBF8F2';
      ctx.fillRect(0, 0, width, height);
      layers.forEach((layer, i) => ctx.drawImage(layer, 0, motion.matches ? 0 : Math.sin(time / 5000 + i) * (i + 1)));
      canvas.dataset.painted = 'true';
      canvas.dataset.animating = String(!motion.matches);
      if (!motion.matches) frame = requestAnimationFrame(draw);
    };
    const wake = () => {
      cancelAnimationFrame(frame);
      if (!visible) { canvas.dataset.animating = 'false'; return; }
      if (!layers.length || width !== Math.round(canvas.clientWidth)) paint();
      frame = requestAnimationFrame(draw);
    };
    const observer = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; wake(); });
    observer.observe(canvas);
    const resize = new ResizeObserver(wake);
    resize.observe(canvas);
    motion.addEventListener('change', wake);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); motion.removeEventListener('change', wake); };
  }, []);
  return <canvas ref={ref} className="beam-landing-hills" aria-hidden="true" />;
}

function mrfRng(seed: number) {
  let a = (seed | 0) ^ 0x9e3779b9
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface MrfDome {
  c: number
  w: number
  h: number
}

interface MrfLayerSpec {
  /** 0 for the farthest ridge, 1 for the nearest. */
  q: number
  /** Crest baseline, as a fraction of the hero height. */
  base: number
  /** How tall the domes stand, as a fraction of the hero height. */
  amp: number
  domes: MrfDome[]
  waves: { f: number; p: number; a: number }[]
  /** Depth of the hill face that the shading runs over, as a fraction of the hero height. */
  depth: number
  /** Aerial haze mixed into the whole ridge. */
  haze: number
}

/** The shape of ridge i of n: a soft union of grassy domes over a slow undulation. */
function mrfLayerSpec(i: number, n: number, seed: number) {
  const q = n > 1 ? i / (n - 1) : 1
  const rnd = mrfRng(seed * 977 + i * 131 + 7)
  const count = q > 0.9 ? 2 : 3 + Math.floor(rnd() * 1.6)
  const domes = [] as MrfDome[]
  const span = 2.8 / count
  // Alternate the tall side layer to layer, so ridges overlap like real valleys.
  const lean = i % 2 ? 1 : -1
  for (let k = 0; k < count; k++) {
    const c = -1.4 + (k + 0.15 + rnd() * 0.7) * span
    domes.push({
      c,
      w: (0.3 + rnd() * 0.32) * (1 + q * 0.7),
      h: 0.42 + rnd() * 0.42 + 0.16 * Math.max(0, Math.min(1, 0.5 + c * lean * 0.6)),
    })
  }
  const spec: MrfLayerSpec = {
    q,
    base: 0.68 + q * 0.29,
    amp: 0.27 - q * 0.17,
    domes,
    waves: [
      { f: 1.6 + rnd() * 1.4, p: rnd() * 6.2832, a: 0.07 },
      { f: 4.5 + rnd() * 3, p: rnd() * 6.2832, a: 0.025 },
    ],
    depth: 0.16 + q * 0.3,
    haze: 0.03 + 0.5 * Math.pow(1 - q, 1.7),
  }
  return spec
}

/** Crest height (CSS px from the top) of a ridge at x, for a scene W wide whose hero band is H tall. */
function mrfCrestAt(spec: MrfLayerSpec, x: number, W: number, H: number) {
  // World units are 1000 CSS px wide and centred, so a narrow screen sees a
  // crop of the same range instead of a squashed one.
  const u = (x - W / 2) / 1000
  // Smooth max of the domes: rounded creases where one hill overlaps the next.
  let sum = 0
  for (const d of spec.domes) {
    const z = (u - d.c) / d.w
    sum += Math.exp(14 * d.h * Math.exp(-z * z))
  }
  const top = Math.log(sum) / 14
  let wave = 0
  for (const o of spec.waves) {
    wave += o.a * Math.sin(u * o.f * 6.2832 + o.p)
  }
  return H * (spec.base - spec.amp * (top + wave))
}
