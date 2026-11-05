/**
 * LumeSec Elements: shared geometry for the Location components.
 *
 * Geodesy, globe rotation with drag, inertia and fly-to, flat projections, land and country dot lattices, arc
 * geometry for dotted strokes and constant-speed packets, hit testing, spatial keyboard navigation, label placement,
 * solar position, easing and theme ink. Components draw; this module computes.
 *
 * Conventions:
 * - Angles in the public API are degrees unless a name says otherwise (`centralAngle` returns radians).
 * - Unit vectors: x = cos(lat)·sin(lon), y = sin(lat), z = cos(lat)·cos(lon). Under the identity rotation the point
 *   lat 0, lon 0 faces the viewer, +y is up and +z points toward the viewer.
 * - Bearings are clockwise from north. Longitudes come out wrapped to [-180, 180).
 * - Screen coordinates are CSS pixels with y down.
 *
 * Nothing heavy runs at import. Lattices, paths and solvers are built lazily on first use and cached. Path2D is only
 * created by functions that run from effects or draw code. Hot paths take `out` parameters and do not allocate.
 */
import * as React from "react";

import { THEME_TOKENS, type ColorToken, type Palette } from "@/components/ui/geo-traceroute-utils/color";
import { COUNTRIES, countryAt, countryShape, isSeam } from "@/components/ui/geo-traceroute-utils/geo-countries";
import { coastlines, isLand, landCoverage } from "@/components/ui/geo-traceroute-utils/geo-world";
import { clamp, hash, mixRgb, rgba, TAU, type RGB } from "@/components/ui/geo-traceroute-utils/math";
import { springStep } from "@/components/ui/geo-traceroute-utils/motion";

/* types and constants */

/** A point in degrees. Every API takes and returns this shape. */
export interface LatLon {
  /** Latitude in degrees, -90 (south) to 90 (north). */
  readonly lat: number;
  /** Longitude in degrees, east positive. */
  readonly lon: number;
}

/**
 * Unit-sphere or view-space vector. x = cos(lat)·sin(lon), y = sin(lat), z = cos(lat)·cos(lon); view space has +z
 * toward the viewer and +y up.
 */
export type Vec3 = [x: number, y: number, z: number];

/**
 * Mutable out parameter for projections: CSS pixels plus depth (globe: view-space z scaled by 1 + altitude; flat
 * maps: 0).
 */
export interface ScreenPoint {
  x: number;
  y: number;
  z: number;
}

/** A zeroed ScreenPoint to reuse in hot loops. */
export function createScreenPoint(): ScreenPoint {
  return { x: 0, y: 0, z: 0 };
}

/** Lon/lat box in degrees; `east` may be greater than 180 when the box crosses the antimeridian. */
export interface GeoBounds {
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
}

/**
 * Whether a point has a finite latitude within ±90° and a finite longitude (of any size: the projections wrap it).
 * Points from props pass through it before they reach the geometry, which assumes valid coordinates.
 */
export function isValidLatLon(point: { readonly lat?: unknown; readonly lon?: unknown } | null | undefined): boolean {
  if (!point) return false;
  const { lat, lon } = point;
  return (
    typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon)
  );
}

/** Mean Earth radius in kilometres. */
export const EARTH_RADIUS_KM = 6371.0088;

/** One-way distance light covers in fibre per millisecond (c / 1.468), in kilometres. */
export const FIBER_KM_PER_MS = 204;

/** Degrees to radians factor: Math.PI / 180. */
export const DEG = Math.PI / 180;

/**
 * [-58, 84]: the default latitude crop for flat maps, so wide cards stay tall enough and Antarctica does not
 * dominate.
 */
export const MAP_LAT_RANGE: readonly [number, number] = [-58, 84];

/** Sun elevations in degrees that end each twilight. */
export const TWILIGHT = { civil: -6, nautical: -12, astronomical: -18 } as const;

/** 4x4 ordered-dither matrix, row-major, values 0 to 15. */
export const BAYER4: Uint8Array = Uint8Array.of(0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);

/**
 * Dither threshold in (0, 1): (BAYER4[(row & 3) * 4 + (column & 3)] + 0.5) / 16. A dot is lit when its level exceeds
 * this.
 */
export function bayer4(row: number, column: number): number {
  return (BAYER4[(row & 3) * 4 + (column & 3)] + 0.5) / 16;
}

/* angles */

/** Degrees to radians. */
export function toRadians(degrees: number): number {
  return degrees * DEG;
}

/** Radians to degrees. */
export function toDegrees(radians: number): number {
  return radians / DEG;
}

/** Wraps a longitude into [-180, 180). */
export function wrapLongitude(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  // -0 and float noise right below 180 both read as -180 in labels; normalise them
  return wrapped === 0 ? 0 : wrapped;
}

/** `to` shifted by a multiple of 360 so it lies within 180° of `from`; used for antimeridian-safe paths. */
export function unwrapLongitude(from: number, to: number): number {
  return to - 360 * Math.round((to - from) / 360);
}

/** Shortest signed difference from `from` to `to` in degrees, in (-180, 180]. Used for yaw and heading springs. */
export function angleDelta(from: number, to: number): number {
  const difference = (((to - from) % 360) + 360) % 360;
  return difference > 180 ? difference - 360 : difference;
}

/* easing */

const bezierCache = new Map<string, (t: number) => number>();

/**
 * Easing that matches CSS `cubic-bezier(x1, y1, x2, y2)`: returns t → y with t clamped to [0, 1]. Solved with 8
 * Newton steps on x and a bisection fallback; memoised per argument tuple. Arc draws use cubicBezier(.45, 0, .25, 1).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const key = `${x1},${y1},${x2},${y2}`;
  const cached = bezierCache.get(key);
  if (cached) return cached;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solve = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const error = sampleX(t) - x;
      if (Math.abs(error) < 1e-7) return t;
      const slope = slopeX(t);
      if (Math.abs(slope) < 1e-6) break;
      t -= error / slope;
    }
    // Newton left the curve or stalled on a flat tangent: bisect, which always converges on a monotonic x
    let low = 0;
    let high = 1;
    t = x;
    for (let i = 0; i < 40; i++) {
      const value = sampleX(t);
      if (Math.abs(value - x) < 1e-7) break;
      if (value < x) low = t;
      else high = t;
      t = (low + high) / 2;
    }
    return t;
  };
  const ease = (t: number) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return sampleY(solve(t));
  };
  bezierCache.set(key, ease);
  return ease;
}

/** Ease-out with overshoot (default 1.70158), t clamped to [0, 1]. For markers that pop into place. */
export function easeOutBack(t: number, overshoot = 1.70158): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const u = t - 1;
  return 1 + (overshoot + 1) * u * u * u + overshoot * u * u;
}

/** Cubic ease-in, t clamped to [0, 1]. For fades that should leave late. */
export function easeInCubic(t: number): number {
  const u = clamp(t, 0, 1);
  return u * u * u;
}

/* vectors */

/** Unit vector for a point in degrees. Writes into `out` when given. */
export function latLonToVector(lat: number, lon: number, out: Vec3 = [0, 0, 0]): Vec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);
  out[0] = cosPhi * Math.sin(lambda);
  out[1] = Math.sin(phi);
  out[2] = cosPhi * Math.cos(lambda);
  return out;
}

/** Inverse of latLonToVector (normalises first). The zero vector maps to lat 0, lon 0. */
export function vectorToLatLon(v: Readonly<Vec3>): LatLon {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0) return { lat: 0, lon: 0 };
  const lat = Math.asin(clamp(v[1] / length, -1, 1)) / DEG;
  const lon = wrapLongitude(Math.atan2(v[0], v[2]) / DEG);
  return { lat, lon };
}

/**
 * A unit vector perpendicular to `v` (unit), stable for every input: the direction toward the north pole, or +z at a
 * pole.
 */
function perpendicular(v: Readonly<Vec3>, out: Vec3): Vec3 {
  // project the pole axis onto the plane of v, so antipodal paths run through the poles like a meridian
  let x = -v[1] * v[0];
  let y = 1 - v[1] * v[1];
  let z = -v[1] * v[2];
  let length = Math.hypot(x, y, z);
  if (length < 1e-9) {
    x = -v[2] * v[0];
    y = -v[2] * v[1];
    z = 1 - v[2] * v[2];
    length = Math.hypot(x, y, z);
  }
  out[0] = x / length;
  out[1] = y / length;
  out[2] = z / length;
  return out;
}

const slerpScratch: Vec3 = [0, 0, 0];

/**
 * Allocation-free spherical interpolation of unit vectors (t in [0, 1], not clamped). Antipodal input travels through
 * the pole-facing plane so the path is stable.
 */
export function slerpVector(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number, out: Vec3): Vec3 {
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  if (omega < 1e-6) {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    return out;
  }
  if (sinOmega < 1e-6) {
    const p = perpendicular(a, slerpScratch);
    const angle = Math.PI * t;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    out[0] = a[0] * cos + p[0] * sin;
    out[1] = a[1] * cos + p[1] * sin;
    out[2] = a[2] * cos + p[2] * sin;
    return out;
  }
  const wa = Math.sin((1 - t) * omega) / sinOmega;
  const wb = Math.sin(t * omega) / sinOmega;
  out[0] = a[0] * wa + b[0] * wb;
  out[1] = a[1] * wa + b[1] * wb;
  out[2] = a[2] * wa + b[2] * wb;
  return out;
}

/* geodesy */

/** Great-circle angle between two points in radians (haversine, stable for small and near-antipodal distances). */
export function centralAngle(a: LatLon, b: LatLon): number {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const sinHalfPhi = Math.sin((phi2 - phi1) / 2);
  const sinHalfLambda = Math.sin(((b.lon - a.lon) * DEG) / 2);
  const h = clamp(sinHalfPhi * sinHalfPhi + Math.cos(phi1) * Math.cos(phi2) * sinHalfLambda * sinHalfLambda, 0, 1);
  return 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Great-circle distance in kilometres: centralAngle times EARTH_RADIUS_KM. */
export function distanceKm(a: LatLon, b: LatLon): number {
  return centralAngle(a, b) * EARTH_RADIUS_KM;
}

/** Initial great-circle bearing from a to b, degrees clockwise from north in [0, 360). */
export function initialBearing(a: LatLon, b: LatLon): number {
  const phi1 = a.lat * DEG;
  const phi2 = b.lat * DEG;
  const deltaLambda = (b.lon - a.lon) * DEG;
  const y = Math.sin(deltaLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(deltaLambda);
  const bearing = (((Math.atan2(y, x) / DEG) % 360) + 360) % 360;
  return bearing >= 360 ? 0 : bearing;
}

/** Point reached travelling `km` along a great circle from `origin` at `bearing` degrees. Longitude wrapped. */
export function destinationPoint(origin: LatLon, bearing: number, km: number): LatLon {
  const delta = km / EARTH_RADIUS_KM;
  const theta = bearing * DEG;
  const phi1 = origin.lat * DEG;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const sinPhi2 = clamp(sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta), -1, 1);
  const phi2 = Math.asin(sinPhi2);
  const lambda = Math.atan2(Math.sin(theta) * sinDelta * cosPhi1, cosDelta - sinPhi1 * sinPhi2);
  return { lat: phi2 / DEG, lon: wrapLongitude(origin.lon + lambda / DEG) };
}

const geodesyA: Vec3 = [0, 0, 0];
const geodesyB: Vec3 = [0, 0, 0];
const geodesyOut: Vec3 = [0, 0, 0];

/** Great-circle midpoint of two points (for antipodal points, the midpoint of the stable path slerpVector takes). */
export function midpoint(a: LatLon, b: LatLon): LatLon {
  latLonToVector(a.lat, a.lon, geodesyA);
  latLonToVector(b.lat, b.lon, geodesyB);
  return vectorToLatLon(slerpVector(geodesyA, geodesyB, 0.5, geodesyOut));
}

/**
 * Interpolator along the shorter great circle (slerp), t in [0, 1]. Antipodal input picks a stable plane through the
 * poles. Each call of the returned function allocates one LatLon; use slerpVector in hot loops.
 */
export function interpolateGreatCircle(a: LatLon, b: LatLon): (t: number) => LatLon {
  const from = latLonToVector(a.lat, a.lon);
  const to = latLonToVector(b.lat, b.lon);
  const out: Vec3 = [0, 0, 0];
  return (t: number) => {
    if (t <= 0) return { lat: a.lat, lon: wrapLongitude(a.lon) };
    if (t >= 1) return { lat: b.lat, lon: wrapLongitude(b.lon) };
    return vectorToLatLon(slerpVector(from, to, t, out));
  };
}

/**
 * `steps` (default 96) points of the small circle at `km` around `center`, built with destinationPoint at evenly
 * spaced bearings from north, clockwise, closed (the last point equals the first). Longitudes are wrapped; callers
 * unwrap relative to the centre (unwrapLongitude) before drawing on flat maps.
 */
export function geodesicCircle(center: LatLon, km: number, steps = 96): LatLon[] {
  const count = Math.max(3, Math.round(steps));
  const points: LatLon[] = [];
  for (let i = 0; i < count; i++) points.push(destinationPoint(center, (360 * i) / count, km));
  points.push(points[0]);
  return points;
}

/**
 * Nearest item by great-circle distance, or null when the list is empty or none is within `maxKm` (default: no
 * limit).
 */
export function nearestLocation<T extends LatLon>(
  items: readonly T[],
  point: LatLon,
  maxKm = Infinity,
): { index: number; km: number } | null {
  let best = -1;
  let bestKm = Infinity;
  for (let i = 0; i < items.length; i++) {
    const km = distanceKm(items[i], point);
    if (km < bestKm) {
      bestKm = km;
      best = i;
    }
  }
  return best >= 0 && bestKm <= maxKm ? { index: best, km: bestKm } : null;
}

/**
 * Bounding box of points with a relative margin (default 0.15 of each span per side) and a minimum span (default 40°
 * on each axis), choosing the smaller of the two longitude spans so Pacific tracks do not wrap the world. `west` is
 * in [-180, 180); `east` may exceed 180. Latitudes are clamped to ±90. No points give the whole world.
 */
export function boundsOf(points: readonly LatLon[], margin = 0.15, minSpanDeg = 40): GeoBounds {
  if (points.length === 0) return { west: -180, south: -90, east: 180, north: 90 };
  let south = Infinity;
  let north = -Infinity;
  const lons: number[] = [];
  for (const point of points) {
    south = Math.min(south, point.lat);
    north = Math.max(north, point.lat);
    lons.push(wrapLongitude(point.lon));
  }
  lons.sort((a, b) => a - b);
  // the box is the complement of the widest empty gap between neighbouring longitudes (the wrap gap included)
  let gap = lons[0] + 360 - lons[lons.length - 1];
  let west = lons[0];
  let east = lons[lons.length - 1];
  for (let i = 1; i < lons.length; i++) {
    const g = lons[i] - lons[i - 1];
    if (g > gap) {
      gap = g;
      west = lons[i];
      east = lons[i - 1] + 360;
    }
  }
  let lonSpan = east - west;
  let latSpan = north - south;
  west -= lonSpan * margin;
  east += lonSpan * margin;
  south -= latSpan * margin;
  north += latSpan * margin;
  lonSpan = east - west;
  latSpan = north - south;
  if (lonSpan < minSpanDeg) {
    const middle = (west + east) / 2;
    west = middle - minSpanDeg / 2;
    east = middle + minSpanDeg / 2;
  }
  if (latSpan < minSpanDeg) {
    const middle = (south + north) / 2;
    south = middle - minSpanDeg / 2;
    north = middle + minSpanDeg / 2;
  }
  // keep a minimum-span box inside the poles by sliding it rather than cutting it
  if (north > 90) {
    south = Math.max(-90, south - (north - 90));
    north = 90;
  }
  if (south < -90) {
    north = Math.min(90, north + (-90 - south));
    south = -90;
  }
  if (east - west >= 360) return { west: -180, south, east: 180, north };
  const shift = wrapLongitude(west) - west;
  return { west: west + shift, south, east: east + shift, north };
}

/** Round-trip floor in milliseconds over fibre: 2 · km / FIBER_KM_PER_MS · stretch (default 1). */
export function fiberRttMs(km: number, stretch = 1): number {
  return ((2 * km) / FIBER_KM_PER_MS) * stretch;
}

/** Result of checkTravel. */
export interface TravelCheck {
  /** Great-circle distance in kilometres. */
  readonly km: number;
  /** Elapsed time in hours (may be zero or negative when events arrive out of order). */
  readonly hours: number;
  /** Required speed in km/h; Infinity when the elapsed time is zero or negative and the places differ. */
  readonly kmh: number;
  /** True when the trip could not have been made: faster than `maxKmh` over more than `minKm`. */
  readonly impossible: boolean;
}

/**
 * Speed needed between two sign-ins. `impossible` when kmh > maxKmh (default 1000) and km > minKm (default 500, which
 * absorbs geo-IP error). Zero or negative elapsed time with km > minKm is impossible.
 */
export function checkTravel(
  from: LatLon,
  to: LatLon,
  elapsedMs: number,
  options: { maxKmh?: number; minKm?: number } = {},
): TravelCheck {
  const { maxKmh = 1000, minKm = 500 } = options;
  const km = distanceKm(from, to);
  const hours = elapsedMs / 3_600_000;
  const kmh = hours > 0 ? km / hours : km > 0 ? Infinity : 0;
  const impossible = km > minKm && (hours <= 0 || kmh > maxKmh);
  return { km, hours, kmh, impossible };
}

/* globe rotation and projection */

/** 3x3 row-major rotation matrix (length 9). */
export type Rotation = Float64Array;

/**
 * Rotation that maps the world point (centerLat, centerLon) to (0, 0, 1) with north up: Rx(lat) · Ry(-lon). A point
 * north of the centre then has a positive view y, so it lands above the centre on screen.
 */
export function rotationFromView(centerLon: number, centerLat: number, out: Rotation = new Float64Array(9)): Rotation {
  const lambda = centerLon * DEG;
  const phi = centerLat * DEG;
  const sinLambda = Math.sin(lambda);
  const cosLambda = Math.cos(lambda);
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  out[0] = cosLambda;
  out[1] = 0;
  out[2] = -sinLambda;
  out[3] = -sinPhi * sinLambda;
  out[4] = cosPhi;
  out[5] = -sinPhi * cosLambda;
  out[6] = cosPhi * sinLambda;
  out[7] = sinPhi;
  out[8] = cosPhi * cosLambda;
  return out;
}

/** Applies a rotation to a vector: nine multiplications, no allocation. `out` may be `v`. */
export function rotateVector(m: Rotation, v: Readonly<Vec3>, out: Vec3): Vec3 {
  const x = v[0];
  const y = v[1];
  const z = v[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[3] * x + m[4] * y + m[5] * z;
  out[2] = m[6] * x + m[7] * y + m[8] * z;
  return out;
}

/**
 * Orthographic globe on screen: centre and radius in CSS px (zoom already applied) and the view rotation. The centre
 * may lie outside the canvas (horizon globes).
 */
export interface GlobeView {
  cx: number;
  cy: number;
  radius: number;
  rotation: Rotation;
}

/**
 * Rotates a world unit vector and scales it by radius · (1 + altitude): x = cx + x·R', y = cy − y·R', out.z = view
 * z · (1 + altitude). Returns true when the surface point faces the viewer (view z > 0). Allocation-free.
 */
export function projectGlobe(view: GlobeView, v: Readonly<Vec3>, out: ScreenPoint, altitude = 0): boolean {
  const m = view.rotation;
  const x = m[0] * v[0] + m[1] * v[1] + m[2] * v[2];
  const y = m[3] * v[0] + m[4] * v[1] + m[5] * v[2];
  const z = m[6] * v[0] + m[7] * v[1] + m[8] * v[2];
  const lift = 1 + altitude;
  const r = view.radius * lift;
  out.x = view.cx + x * r;
  out.y = view.cy - y * r;
  out.z = z * lift;
  return z > 0;
}

const projectScratch: Vec3 = [0, 0, 0];

/** projectGlobe for a lat/lon in degrees, using an internal scratch vector. Allocation-free. */
export function projectLatLonGlobe(view: GlobeView, lat: number, lon: number, out: ScreenPoint, altitude = 0): boolean {
  return projectGlobe(view, latLonToVector(lat, lon, projectScratch), out, altitude);
}

/**
 * For a lifted point in unit view space (x, y, z with the globe radius 1): hidden when it is behind the globe's disc,
 * that is z < 0 and x² + y² < 1. Test per sample, not per arc, so arcs break where they pass behind the globe.
 */
export function isOccluded(x: number, y: number, z: number): boolean {
  return z < 0 && x * x + y * y < 1;
}

/**
 * Inverse orthographic projection: the world point under a screen point, or null outside the disc. Uses
 * z = sqrt(1 − ρ²) and the transposed rotation (screen y flipped).
 */
export function screenToGlobe(view: GlobeView, x: number, y: number): LatLon | null {
  if (view.radius <= 0) return null;
  const vx = (x - view.cx) / view.radius;
  const vy = -(y - view.cy) / view.radius;
  const rho2 = vx * vx + vy * vy;
  if (rho2 > 1) return null;
  const vz = Math.sqrt(1 - rho2);
  const m = view.rotation;
  projectScratch[0] = m[0] * vx + m[3] * vy + m[6] * vz;
  projectScratch[1] = m[1] * vx + m[4] * vy + m[7] * vz;
  projectScratch[2] = m[2] * vx + m[5] * vy + m[8] * vz;
  return vectorToLatLon(projectScratch);
}

/**
 * Altitude of an arc's apex as a share of the globe radius for a central angle in radians: (0.06 +
 * 0.32·angle/π)·scale.
 */
export function arcLift(angle: number, scale = 1): number {
  return (0.06 + (0.32 * angle) / Math.PI) * scale;
}

const arcFrom: Vec3 = [0, 0, 0];
const arcTo: Vec3 = [0, 0, 0];
const arcPoint: Vec3 = [0, 0, 0];

/**
 * World-space samples of a lifted great-circle arc: x, y, z per sample, segments + 1 samples (default 48 segments),
 * the slerp from → to scaled by (1 + lift · sin(πt)). `lift` defaults to arcLift(angle). Reuses `out` when it is
 * long enough (it may be longer than needed; read (segments + 1) · 3 values). To draw, rotate each sample with
 * rotateVector, test isOccluded on the rotated values and map to cx + x·R, cy − y·R.
 */
export function globeArc(
  from: LatLon,
  to: LatLon,
  options: { segments?: number; lift?: number } = {},
  out?: Float32Array,
): Float32Array {
  const segments = Math.max(1, Math.round(options.segments ?? 48));
  const lift = options.lift ?? arcLift(centralAngle(from, to));
  const size = (segments + 1) * 3;
  const samples = out && out.length >= size ? out : new Float32Array(size);
  latLonToVector(from.lat, from.lon, arcFrom);
  latLonToVector(to.lat, to.lon, arcTo);
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    slerpVector(arcFrom, arcTo, t, arcPoint);
    const scale = 1 + lift * Math.sin(Math.PI * t);
    samples[i * 3] = arcPoint[0] * scale;
    samples[i * 3 + 1] = arcPoint[1] * scale;
    samples[i * 3 + 2] = arcPoint[2] * scale;
  }
  return samples;
}

/* globe motion */

/**
 * Mutable globe view state, kept in a ref: centre in degrees, zoom, velocities in degrees (or zoom units) per second,
 * an optional fly-to target, seconds since the last interaction and the spring constants.
 */
export interface GlobeMotion {
  /** Centre longitude in degrees, wrapped to [-180, 180). */
  lon: number;
  /** Centre latitude in degrees, within ±latLimit. */
  lat: number;
  /** Zoom factor; multiply the base radius by it. */
  zoom: number;
  /** Longitude velocity in degrees per second (inertia, or the fly-to spring). */
  velocityLon: number;
  /** Latitude velocity in degrees per second. */
  velocityLat: number;
  /** Zoom velocity in zoom units per second. */
  velocityZoom: number;
  /** Fly-to target, or null when the globe coasts on inertia. */
  target: { lon: number; lat: number; zoom: number } | null;
  /** True while a pointer drags the globe. */
  dragging: boolean;
  /** Seconds since the last interaction (drag, fly-to, nudge). */
  idle: number;
  /**
   * Idle spin in degrees per second; positive turns the surface to the right like the real Earth (the centre
   * longitude decreases). 0 disables it.
   */
  autoRotate: number;
  /** Spring stiffness of fly-to and nudges. */
  stiffness: number;
  /** Spring damping ratio of fly-to and nudges (1 is critical). */
  damping: number;
  /** Largest centre latitude in degrees, either side of the equator. */
  latLimit: number;
  /** Smallest and largest zoom. */
  zoomRange: readonly [number, number];
}

/**
 * Options of createGlobeMotion. Defaults: lon 0, lat 20, zoom 1, autoRotate 0 deg/s, stiffness 120, damping 0.85
 * (large globes; badges pass 520 / 0.72), latLimit 35, zoomRange [0.8, 1.6].
 */
export interface GlobeMotionOptions {
  lon?: number;
  lat?: number;
  zoom?: number;
  autoRotate?: number;
  stiffness?: number;
  damping?: number;
  latLimit?: number;
  zoomRange?: readonly [number, number];
}

/** New globe motion state. Keep it in a ref: `useLazyRef(() => createGlobeMotion(...))` from `motion` (pure). */
export function createGlobeMotion(options: GlobeMotionOptions = {}): GlobeMotion {
  const latLimit = options.latLimit ?? 35;
  const zoomRange = options.zoomRange ?? [0.8, 1.6];
  return {
    lon: wrapLongitude(options.lon ?? 0),
    lat: clamp(options.lat ?? 20, -latLimit, latLimit),
    zoom: clamp(options.zoom ?? 1, zoomRange[0], zoomRange[1]),
    velocityLon: 0,
    velocityLat: 0,
    velocityZoom: 0,
    target: null,
    dragging: false,
    idle: 0,
    autoRotate: options.autoRotate ?? 0,
    stiffness: options.stiffness ?? 120,
    damping: options.damping ?? 0.85,
    latLimit,
    zoomRange,
  };
}

/**
 * Sets a spring target for the view centre (latitude clamped to latLimit; zoom clamped to zoomRange, default the
 * pending target zoom or the current zoom), cancels inertia and resets idle. Call loop.kick() afterwards.
 */
export function flyTo(motion: GlobeMotion, target: LatLon, zoom?: number): void {
  motion.target = {
    lon: wrapLongitude(target.lon),
    lat: clamp(target.lat, -motion.latLimit, motion.latLimit),
    zoom: clamp(zoom ?? motion.target?.zoom ?? motion.zoom, motion.zoomRange[0], motion.zoomRange[1]),
  };
  motion.velocityLon = 0;
  motion.velocityLat = 0;
  motion.velocityZoom = 0;
  motion.idle = 0;
}

/**
 * Keyboard step: offsets the pending target (or the current view) by degrees and zoom units and springs there.
 * nudgeGlobe(m, 10, 0) moves the view centre 10° east (the surface turns left); Arrow keys use 10°.
 */
export function nudgeGlobe(motion: GlobeMotion, deltaLon: number, deltaLat: number, deltaZoom = 0): void {
  const base = motion.target ?? motion;
  motion.target = {
    lon: wrapLongitude(base.lon + deltaLon),
    lat: clamp(base.lat + deltaLat, -motion.latLimit, motion.latLimit),
    zoom: clamp(base.zoom + deltaZoom, motion.zoomRange[0], motion.zoomRange[1]),
  };
  motion.idle = 0;
}

const springState = { position: 0, velocity: 0 };
const SETTLE_DEGREES = 0.01;
const SETTLE_SPEED = 0.05;
const INERTIA_STOP = 0.5;
const INERTIA_TIME = 0.6;
const IDLE_BEFORE_SPIN = 2.5;

/** Runs one spring step on a scalar through the shared scratch state; returns the new position. */
function springScalar(position: number, velocity: number, target: number, delta: number, motion: GlobeMotion) {
  springState.position = position;
  springState.velocity = velocity;
  springStep(springState, target, delta, motion.stiffness, motion.damping);
  return springState.position;
}

/**
 * Advances the view by one frame of `delta` seconds and returns true while anything moves. With a target: springs on
 * lon (the short way, via angleDelta), lat and zoom with springStep(stiffness, damping). Without one: inertia decays
 * with exp(−dt/0.6), latitude stays within latLimit, and autoRotate eases in over 1 s after 2.5 s idle (the loop
 * keeps running while autoRotate is set). Reduced motion jumps to the target and skips inertia and autoRotate. While
 * dragging it returns false (each pointer move calls onChange). Call it first in the frame step, then draw.
 */
export function stepGlobeMotion(motion: GlobeMotion, delta: number, reduced: boolean): boolean {
  if (motion.dragging) {
    motion.idle = 0;
    return false;
  }
  const target = motion.target;
  if (target) {
    motion.idle = 0;
    if (!reduced) {
      const lonStep = springScalar(0, motion.velocityLon, angleDelta(motion.lon, target.lon), delta, motion);
      motion.lon = wrapLongitude(motion.lon + lonStep);
      motion.velocityLon = springState.velocity;
      motion.lat = springScalar(motion.lat, motion.velocityLat, target.lat, delta, motion);
      motion.velocityLat = springState.velocity;
      motion.zoom = springScalar(motion.zoom, motion.velocityZoom, target.zoom, delta, motion);
      motion.velocityZoom = springState.velocity;
      const moving =
        Math.abs(angleDelta(motion.lon, target.lon)) > SETTLE_DEGREES ||
        Math.abs(motion.lat - target.lat) > SETTLE_DEGREES ||
        Math.abs(motion.zoom - target.zoom) > 0.0005 ||
        Math.abs(motion.velocityLon) > SETTLE_SPEED ||
        Math.abs(motion.velocityLat) > SETTLE_SPEED ||
        Math.abs(motion.velocityZoom) > 0.005;
      if (moving) return true;
    }
    motion.lon = target.lon;
    motion.lat = target.lat;
    motion.zoom = target.zoom;
    motion.velocityLon = 0;
    motion.velocityLat = 0;
    motion.velocityZoom = 0;
    motion.target = null;
    return false;
  }

  motion.idle += delta;
  let moving = false;
  if (reduced) {
    motion.velocityLon = 0;
    motion.velocityLat = 0;
    motion.velocityZoom = 0;
  } else {
    const decay = Math.exp(-delta / INERTIA_TIME);
    if (Math.abs(motion.velocityLon) > INERTIA_STOP || Math.abs(motion.velocityLat) > INERTIA_STOP) {
      motion.lon = wrapLongitude(motion.lon + motion.velocityLon * delta);
      motion.lat += motion.velocityLat * delta;
      motion.velocityLon *= decay;
      motion.velocityLat *= decay;
      moving = true;
    } else {
      motion.velocityLon = 0;
      motion.velocityLat = 0;
    }
    if (Math.abs(motion.velocityZoom) > 0.002) {
      motion.zoom += motion.velocityZoom * delta;
      motion.velocityZoom *= decay;
      moving = true;
    } else {
      motion.velocityZoom = 0;
    }
    if (motion.autoRotate !== 0) {
      const ease = clamp(motion.idle - IDLE_BEFORE_SPIN, 0, 1);
      motion.lon = wrapLongitude(motion.lon - motion.autoRotate * ease * ease * (3 - 2 * ease) * delta);
      moving = true;
    }
  }
  if (Math.abs(motion.lat) > motion.latLimit) {
    motion.lat = clamp(motion.lat, -motion.latLimit, motion.latLimit);
    motion.velocityLat = 0;
  }
  const zoom = clamp(motion.zoom, motion.zoomRange[0], motion.zoomRange[1]);
  if (zoom !== motion.zoom) {
    motion.zoom = zoom;
    motion.velocityZoom = 0;
  }
  return moving;
}

/**
 * Options of useGlobeDrag. `radius` returns the current on-screen radius in px (drag maps px to degrees); `onChange`
 * is usually loop.kick; `axis` defaults to "x", which lets vertical touch drags scroll the page; `onTap` fires for
 * presses that moved less than 4 px within 300 ms, with element coordinates in CSS px.
 */
export interface GlobeDragOptions {
  radius: () => number;
  onChange: () => void;
  axis?: "x" | "both";
  disabled?: boolean;
  onTap?: (x: number, y: number) => void;
}

const DRAG_SAMPLES = 16;
const DRAG_VELOCITY_WINDOW = 80;
const MAX_DRAG_SPEED = 720;

/**
 * Pointer-capture drag for a globe: the grabbed point follows the pointer (dLon = −dx / R, dLat = dy / R, in degrees),
 * velocity is sampled over the last 80 ms and handed to inertia on release. For touch with axis "x", a drag that
 * starts mostly vertical is released so the page scrolls; give the element `touch-pan-y` (axis "both": `touch-none`),
 * `select-none` and a grab cursor. Pressing cancels a fly-to. Every listener is removed on unmount.
 */
export function useGlobeDrag(
  target: React.RefObject<HTMLElement | null>,
  motion: React.RefObject<GlobeMotion>,
  options: GlobeDragOptions,
): void {
  const latest = React.useRef(options);
  React.useEffect(() => {
    latest.current = options;
  });

  React.useEffect(() => {
    const element = target.current;
    if (!element) return;
    let pointerId = -1;
    let decided = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastY = 0;
    let startTime = 0;
    let totalLon = 0;
    let totalLat = 0;
    // ring buffer of (time, cumulative lon, cumulative lat) for the release velocity
    const samples = new Float64Array(DRAG_SAMPLES * 3);
    let sampleCount = 0;
    let sampleHead = 0;

    const record = (time: number) => {
      samples[sampleHead * 3] = time;
      samples[sampleHead * 3 + 1] = totalLon;
      samples[sampleHead * 3 + 2] = totalLat;
      sampleHead = (sampleHead + 1) % DRAG_SAMPLES;
      sampleCount = Math.min(DRAG_SAMPLES, sampleCount + 1);
    };

    const release = () => {
      if (pointerId !== -1 && element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
      pointerId = -1;
      motion.current.dragging = false;
      motion.current.idle = 0;
    };

    const onDown = (event: PointerEvent) => {
      const { disabled, onChange } = latest.current;
      if (disabled || pointerId !== -1) return;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const axis = latest.current.axis ?? "x";
      pointerId = event.pointerId;
      decided = !(event.pointerType === "touch" && axis === "x");
      moved = false;
      startX = lastX = event.clientX;
      startY = lastY = event.clientY;
      startTime = event.timeStamp;
      totalLon = 0;
      totalLat = 0;
      sampleCount = 0;
      sampleHead = 0;
      record(event.timeStamp);
      const state = motion.current;
      state.target = null;
      state.velocityLon = 0;
      state.velocityLat = 0;
      state.velocityZoom = 0;
      state.idle = 0;
      state.dragging = decided;
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // synthetic or already released pointers cannot be captured; the drag still works over the element
      }
      onChange();
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const { radius, onChange } = latest.current;
      const axis = latest.current.axis ?? "x";
      const totalX = event.clientX - startX;
      const totalY = event.clientY - startY;
      const distance = Math.hypot(totalX, totalY);
      if (distance >= 4) moved = true;
      if (!decided) {
        if (distance < 6) return;
        if (Math.abs(totalY) > Math.abs(totalX)) {
          // a vertical swipe on touch: give the gesture back to the page
          release();
          return;
        }
        decided = true;
        motion.current.dragging = true;
      }
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      lastX = event.clientX;
      lastY = event.clientY;
      const r = Math.max(1, radius());
      const deltaLon = -toDegrees(dx / r);
      const deltaLat = axis === "x" ? 0 : toDegrees(dy / r);
      totalLon += deltaLon;
      totalLat += deltaLat;
      record(event.timeStamp);
      const state = motion.current;
      state.lon = wrapLongitude(state.lon + deltaLon);
      state.lat = clamp(state.lat + deltaLat, -state.latLimit, state.latLimit);
      state.idle = 0;
      onChange();
    };

    const releaseVelocity = (now: number) => {
      const state = motion.current;
      state.velocityLon = 0;
      state.velocityLat = 0;
      if (sampleCount < 2) return;
      const newest = (sampleHead - 1 + DRAG_SAMPLES) % DRAG_SAMPLES;
      // a pointer that rested before release throws nothing
      if (now - samples[newest * 3] > DRAG_VELOCITY_WINDOW) return;
      let base = newest;
      for (let k = 1; k < sampleCount; k++) {
        base = (newest - k + DRAG_SAMPLES) % DRAG_SAMPLES;
        if (now - samples[base * 3] > DRAG_VELOCITY_WINDOW) break;
      }
      const seconds = Math.max(0.016, (samples[newest * 3] - samples[base * 3]) / 1000);
      const lonSpeed = (samples[newest * 3 + 1] - samples[base * 3 + 1]) / seconds;
      const latSpeed = (samples[newest * 3 + 2] - samples[base * 3 + 2]) / seconds;
      state.velocityLon = clamp(lonSpeed, -MAX_DRAG_SPEED, MAX_DRAG_SPEED);
      state.velocityLat = clamp(latSpeed, -MAX_DRAG_SPEED, MAX_DRAG_SPEED);
    };

    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const { onTap, onChange } = latest.current;
      const tapped = !moved && event.timeStamp - startTime < 300;
      if (decided && !tapped) releaseVelocity(event.timeStamp);
      release();
      if (tapped && onTap) {
        const rect = element.getBoundingClientRect();
        onTap(event.clientX - rect.left, event.clientY - rect.top);
      }
      onChange();
    };

    const onCancel = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      release();
      latest.current.onChange();
    };

    element.addEventListener("pointerdown", onDown);
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
    element.addEventListener("pointercancel", onCancel);
    element.addEventListener("lostpointercapture", onCancel);
    return () => {
      element.removeEventListener("pointerdown", onDown);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
      element.removeEventListener("pointercancel", onCancel);
      element.removeEventListener("lostpointercapture", onCancel);
      if (pointerId !== -1) release();
    };
  }, [target, motion]);
}

/* flat projections */

/** Supported flat projections. */
export type ProjectionKind = "equirectangular" | "equalEarth" | "mercator" | "azimuthalEquidistant";

/**
 * Fit box and view of a flat projection, in CSS px and degrees. `center.lon` is the central meridian (default: the
 * middle of `lonRange`, else 0) and, for the azimuthal projection, `center` is the centre point. `latRange` and
 * `lonRange` crop the domain (`lonRange` east may exceed 180 for boxes across the antimeridian). `zoom` ≥ 1 scales
 * about `focus`, which is kept at the box centre (without a focus the cropped extent stays centred). `maxAngle`
 * limits the azimuthal disc (default 180°).
 */
export interface ProjectionOptions {
  width: number;
  height: number;
  /** Inner padding of the fit in px. Default 0. */
  padding?: number;
  latRange?: readonly [number, number];
  lonRange?: readonly [number, number];
  center?: LatLon;
  zoom?: number;
  focus?: LatLon;
  maxAngle?: number;
}

/**
 * A pure projection object (no DOM; safe to create during render). `project` moves an ordinary longitude in
 * [-180, 180) into the map's window, so markers always land on the map, and leaves longitudes outside that interval
 * as they are, so `lon + 360` or `lon − 360` gives the seam copy past the edge. It writes x/y even when it returns
 * false (outside the cropped domain or beyond the azimuthal `maxAngle`), so lines can run past the edge. `invert`
 * returns null outside the domain. `key` identifies the geometry for caches; `scale` is px per radian at the centre
 * (zoom included); `frame` is the screen box of the projected domain.
 */
export interface MapProjection {
  readonly kind: ProjectionKind;
  readonly width: number;
  readonly height: number;
  readonly key: string;
  readonly scale: number;
  /** The central meridian in degrees (the azimuthal centre longitude). */
  readonly centerLon: number;
  /** Screen box of the whole projected domain in CSS px (larger than the canvas when zoomed). */
  readonly frame: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  project(lat: number, lon: number, out: ScreenPoint): boolean;
  /**
   * Projects a longitude given as degrees east of `centerLon`, never wrapped. Use it for continuous lines: start with
   * wrapLongitude(lon − centerLon) and continue with unwrapLongitude(previous, lon − centerLon).
   */
  projectRelative(lat: number, lambda: number, out: ScreenPoint): boolean;
  invert(x: number, y: number): LatLon | null;
}

const EE_A1 = 1.340264;
const EE_A2 = -0.081106;
const EE_A3 = 0.000893;
const EE_A4 = 0.003796;
const EE_M = Math.sqrt(3) / 2;
const MERCATOR_LIMIT = 85;

/** Equal Earth y for a parametric latitude θ. */
function equalEarthY(theta: number) {
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return theta * (EE_A1 + EE_A2 * t2 + t6 * (EE_A3 + EE_A4 * t2));
}

/** Derivative of equalEarthY, which is also the denominator of x. */
function equalEarthSlope(theta: number) {
  const t2 = theta * theta;
  const t6 = t2 * t2 * t2;
  return EE_A1 + 3 * EE_A2 * t2 + t6 * (7 * EE_A3 + 9 * EE_A4 * t2);
}

/** x per radian of longitude at latitude φ (radians) in Equal Earth; largest at the equator. */
function equalEarthFactor(phi: number) {
  const theta = Math.asin(EE_M * Math.sin(phi));
  return Math.cos(theta) / (EE_M * equalEarthSlope(theta));
}

const mercatorY = (phi: number) => Math.log(Math.tan(Math.PI / 4 + phi / 2));

interface RawPoint {
  x: number;
  y: number;
}

interface RawAngles {
  lambda: number;
  phi: number;
}

/** Forward flat projection of relative longitude λ and latitude φ (radians) into raw units (y up). */
function forwardFlat(kind: ProjectionKind, lambda: number, phi: number, out: RawPoint) {
  if (kind === "equalEarth") {
    const theta = Math.asin(EE_M * Math.sin(phi));
    out.x = (lambda * Math.cos(theta)) / (EE_M * equalEarthSlope(theta));
    out.y = equalEarthY(theta);
  } else if (kind === "mercator") {
    out.x = lambda;
    out.y = mercatorY(clamp(phi, -MERCATOR_LIMIT * DEG, MERCATOR_LIMIT * DEG));
  } else {
    out.x = lambda;
    out.y = phi;
  }
}

/** Inverse of forwardFlat; false when the raw point has no preimage. */
function inverseFlat(kind: ProjectionKind, x: number, y: number, out: RawAngles): boolean {
  if (kind === "equalEarth") {
    let theta = y;
    for (let i = 0; i < 6; i++) theta -= (equalEarthY(theta) - y) / equalEarthSlope(theta);
    if (!Number.isFinite(theta) || Math.abs(theta) > Math.PI / 3 + 1e-9) return false;
    out.phi = Math.asin(clamp(Math.sin(theta) / EE_M, -1, 1));
    out.lambda = (EE_M * x * equalEarthSlope(theta)) / Math.cos(theta);
    return true;
  }
  out.lambda = x;
  out.phi = kind === "mercator" ? 2 * Math.atan(Math.exp(y)) - Math.PI / 2 : y;
  return Math.abs(out.phi) <= Math.PI / 2 + 1e-9;
}

/** Forward azimuthal equidistant projection about (φ0, λ = 0); returns the central angle c. */
function forwardAzimuthal(sinPhi0: number, cosPhi0: number, lambda: number, phi: number, out: RawPoint) {
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const cosLambda = Math.cos(lambda);
  const sinHalfPhi = Math.sin((phi - Math.asin(sinPhi0)) / 2);
  const sinHalfLambda = Math.sin(lambda / 2);
  const h = clamp(sinHalfPhi * sinHalfPhi + cosPhi0 * cosPhi * sinHalfLambda * sinHalfLambda, 0, 1);
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  // the bearing form (ρ = c along the initial bearing) stays stable near the antipode, where k = c / sin c is not
  const theta = Math.atan2(Math.sin(lambda) * cosPhi, cosPhi0 * sinPhi - sinPhi0 * cosPhi * cosLambda);
  out.x = c * Math.sin(theta);
  out.y = c * Math.cos(theta);
  return c;
}

/** Inverse azimuthal equidistant projection about (φ0, λ = 0). */
function inverseAzimuthal(sinPhi0: number, cosPhi0: number, x: number, y: number, out: RawAngles) {
  const c = Math.hypot(x, y);
  if (c < 1e-12) {
    out.phi = Math.asin(sinPhi0);
    out.lambda = 0;
    return;
  }
  const sinC = Math.sin(c);
  const cosC = Math.cos(c);
  const sinPhi = clamp(cosC * sinPhi0 + (y * sinC * cosPhi0) / c, -1, 1);
  out.phi = Math.asin(sinPhi);
  out.lambda = Math.atan2(x * sinC, c * cosPhi0 * cosC - y * sinPhi0 * sinC);
}

/** The cropped domain of a flat projection: relative longitudes and latitudes in radians. */
interface Domain {
  lambdaMin: number;
  lambdaMax: number;
  phiMin: number;
  phiMax: number;
}

function domainOf(
  kind: ProjectionKind,
  latRange?: readonly [number, number],
  lonRange?: readonly [number, number],
  lon0 = 0,
): Domain {
  let south = latRange ? Math.min(latRange[0], latRange[1]) : -90;
  let north = latRange ? Math.max(latRange[0], latRange[1]) : 90;
  if (kind === "mercator") {
    south = Math.max(south, -MERCATOR_LIMIT);
    north = Math.min(north, MERCATOR_LIMIT);
  }
  let west = -180;
  let east = 180;
  if (lonRange) {
    west = lonRange[0] - lon0;
    east = lonRange[1] - lon0;
    if (east <= west) east += 360;
    // keep the cropped range centred near the central meridian, whatever multiple of 360 the caller used
    const turns = Math.round((west + east) / 2 / 360);
    west -= 360 * turns;
    east -= 360 * turns;
  }
  return { lambdaMin: west * DEG, lambdaMax: east * DEG, phiMin: south * DEG, phiMax: north * DEG };
}

/** Raw extent of a cropped flat domain: [x0, x1, y0, y1] with y up. */
function extentOf(kind: ProjectionKind, domain: Domain): [number, number, number, number] {
  const point: RawPoint = { x: 0, y: 0 };
  forwardFlat(kind, 0, domain.phiMin, point);
  const y0 = point.y;
  forwardFlat(kind, 0, domain.phiMax, point);
  const y1 = point.y;
  if (kind !== "equalEarth") return [domain.lambdaMin, domain.lambdaMax, y0, y1];
  // x = λ · factor(φ): the factor peaks at the equator, so each edge reaches furthest at the latitude nearest 0
  // when it points away from the central meridian, and at the latitude furthest from 0 when it points toward it
  const nearest = clamp(0, domain.phiMin, domain.phiMax);
  const furthest = Math.abs(domain.phiMin) > Math.abs(domain.phiMax) ? domain.phiMin : domain.phiMax;
  const widest = equalEarthFactor(nearest);
  const narrowest = equalEarthFactor(furthest);
  const x0 = domain.lambdaMin * (domain.lambdaMin < 0 ? widest : narrowest);
  const x1 = domain.lambdaMax * (domain.lambdaMax > 0 ? widest : narrowest);
  return [x0, x1, y0, y1];
}

/**
 * Width / height of a cropped projection, for CSS aspect-ratio so the server markup reserves the right height. The
 * azimuthal projection is always 1.
 */
export function projectionAspect(
  kind: ProjectionKind,
  latRange?: readonly [number, number],
  lonRange?: readonly [number, number],
): number {
  if (kind === "azimuthalEquidistant") return 1;
  const lon0 = lonRange ? (lonRange[0] + lonRange[1]) / 2 : 0;
  const [x0, x1, y0, y1] = extentOf(kind, domainOf(kind, latRange, lonRange, lon0));
  return (x1 - x0) / Math.max(1e-9, y1 - y0);
}

/** Internal state behind a MapProjection, for the outline and the lattice. */
interface ProjectionState {
  kind: ProjectionKind;
  domain: Domain;
  extent: [number, number, number, number];
  /** Raw focus point kept at the box centre. */
  fx: number;
  fy: number;
  /** px per raw unit, zoom included. */
  s: number;
  width: number;
  height: number;
  /** Azimuthal disc radius in radians. */
  maxAngle: number;
  /** Raw azimuthal centre on screen. */
  originX: number;
  originY: number;
}

const projectionStates = new WeakMap<MapProjection, ProjectionState>();

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Creates a flat projection fitted into a box: Equal Earth with the published coefficients and a Newton inverse,
 * equirectangular, Mercator clamped at ±85°, and azimuthal equidistant (k = c / sin c) about `center`. The cropped
 * extent is fitted with padding, aspect preserved and centred. Pure and cheap; create it in render or a memo.
 */
export function createProjection(kind: ProjectionKind, options: ProjectionOptions): MapProjection {
  const { width, height, padding = 0, latRange, lonRange, center, zoom = 1, focus, maxAngle = 180 } = options;
  const azimuthal = kind === "azimuthalEquidistant";
  const lon0 = wrapLongitude(center?.lon ?? (lonRange && !azimuthal ? (lonRange[0] + lonRange[1]) / 2 : 0));
  const phi0 = azimuthal ? clamp(center?.lat ?? 0, -90, 90) * DEG : 0;
  const sinPhi0 = Math.sin(phi0);
  const cosPhi0 = Math.cos(phi0);
  const angleLimit = clamp(maxAngle, 1, 180) * DEG;
  const domain = domainOf(kind, latRange, lonRange, lon0);
  const extent: [number, number, number, number] = azimuthal
    ? [-angleLimit, angleLimit, -angleLimit, angleLimit]
    : extentOf(kind, domain);
  const extentWidth = Math.max(1e-9, extent[1] - extent[0]);
  const extentHeight = Math.max(1e-9, extent[3] - extent[2]);
  const fit = Math.max(0, Math.min((width - 2 * padding) / extentWidth, (height - 2 * padding) / extentHeight));
  const s = fit * Math.max(1, zoom);
  // the window that ordinary longitudes are wrapped into: 360° centred on the cropped range
  const windowCenter = (domain.lambdaMin + domain.lambdaMax) / 2 / DEG;
  const raw: RawPoint = { x: 0, y: 0 };
  const angles: RawAngles = { lambda: 0, phi: 0 };

  const forward = (lat: number, lambda: number, out: RawPoint) => {
    if (azimuthal) return forwardAzimuthal(sinPhi0, cosPhi0, lambda * DEG, lat * DEG, out) <= angleLimit + 1e-9;
    forwardFlat(kind, lambda * DEG, lat * DEG, out);
    const eps = 1e-9;
    return (
      lat * DEG >= domain.phiMin - eps &&
      lat * DEG <= domain.phiMax + eps &&
      lambda * DEG >= domain.lambdaMin - eps &&
      lambda * DEG <= domain.lambdaMax + eps
    );
  };

  let fx = (extent[0] + extent[1]) / 2;
  let fy = (extent[2] + extent[3]) / 2;
  if (focus) {
    const relative = wrapLongitude(focus.lon - lon0 - windowCenter) + windowCenter;
    forward(focus.lat, relative, raw);
    fx = raw.x;
    fy = raw.y;
  }
  const toScreenX = (x: number) => width / 2 + s * (x - fx);
  const toScreenY = (y: number) => height / 2 - s * (y - fy);
  const frame = {
    x0: toScreenX(extent[0]),
    y0: toScreenY(extent[3]),
    x1: toScreenX(extent[1]),
    y1: toScreenY(extent[2]),
  };

  const key = [
    kind,
    round2(width),
    round2(height),
    round2(padding),
    latRange ? `${round2(latRange[0])},${round2(latRange[1])}` : "",
    lonRange ? `${round2(lonRange[0])},${round2(lonRange[1])}` : "",
    round2(lon0),
    round2(phi0 / DEG),
    round2(zoom),
    focus ? `${round2(focus.lat)},${round2(focus.lon)}` : "",
    azimuthal ? round2(maxAngle) : "",
  ].join("|");

  const projectRelative = (lat: number, lambda: number, out: ScreenPoint) => {
    const inside = forward(lat, lambda, raw);
    out.x = toScreenX(raw.x);
    out.y = toScreenY(raw.y);
    out.z = 0;
    return inside;
  };

  const projection: MapProjection = {
    kind,
    width,
    height,
    key,
    scale: s,
    centerLon: lon0,
    frame,
    projectRelative,
    project(lat, lon, out) {
      const lambda = lon >= -180 && lon < 180 ? wrapLongitude(lon - lon0 - windowCenter) + windowCenter : lon - lon0;
      return projectRelative(lat, lambda, out);
    },
    invert(x, y) {
      if (s <= 0) return null;
      const rx = fx + (x - width / 2) / s;
      const ry = fy - (y - height / 2) / s;
      if (azimuthal) {
        if (Math.hypot(rx, ry) > angleLimit + 1e-9) return null;
        inverseAzimuthal(sinPhi0, cosPhi0, rx, ry, angles);
      } else {
        if (!inverseFlat(kind, rx, ry, angles)) return null;
        const eps = 1e-9;
        if (angles.phi < domain.phiMin - eps || angles.phi > domain.phiMax + eps) return null;
        if (angles.lambda < domain.lambdaMin - eps || angles.lambda > domain.lambdaMax + eps) return null;
      }
      return { lat: angles.phi / DEG, lon: wrapLongitude(angles.lambda / DEG + lon0) };
    },
  };
  projectionStates.set(projection, {
    kind,
    domain,
    extent,
    fx,
    fy,
    s,
    width,
    height,
    maxAngle: angleLimit,
    originX: toScreenX(0),
    originY: toScreenY(0),
  });
  return projection;
}

/** Formats a number for SVG path data (two decimals, no trailing zeros). */
const svgNumber = (value: number) => `${Math.round(value * 100) / 100}`;

/**
 * SVG path data for the projection's outer border: Equal Earth with curved sides, a circle for the azimuthal disc,
 * a rectangle otherwise. Works in SSR markup (`<path d>`) and as `new Path2D(d)` on canvas.
 */
export function projectionOutlineSvgPath(projection: MapProjection): string {
  const state = projectionStates.get(projection);
  if (!state) return `M0 0H${svgNumber(projection.width)}V${svgNumber(projection.height)}H0Z`;
  const { s, fx, fy, width, height, domain } = state;
  if (state.kind === "azimuthalEquidistant") {
    const r = state.maxAngle * s;
    const cx = state.originX;
    const cy = state.originY;
    const left = `${svgNumber(cx - r)} ${svgNumber(cy)}`;
    const right = `${svgNumber(cx + r)} ${svgNumber(cy)}`;
    const radius = `${svgNumber(r)} ${svgNumber(r)}`;
    return `M${left}A${radius} 0 1 0 ${right}A${radius} 0 1 0 ${left}Z`;
  }
  const raw: RawPoint = { x: 0, y: 0 };
  const parts: string[] = [];
  const add = (lambda: number, phi: number) => {
    forwardFlat(state.kind, lambda, phi, raw);
    const x = width / 2 + s * (raw.x - fx);
    const y = height / 2 - s * (raw.y - fy);
    parts.push(`${parts.length === 0 ? "M" : "L"}${svgNumber(x)} ${svgNumber(y)}`);
  };
  // sides are curved only in Equal Earth; top and bottom are straight in every flat projection
  const latSpan = domain.phiMax - domain.phiMin;
  const sideSteps = state.kind === "equalEarth" ? Math.max(2, Math.ceil(latSpan / (2 * DEG))) : 1;
  for (let i = 0; i <= sideSteps; i++) add(domain.lambdaMin, domain.phiMax - (latSpan * i) / sideSteps);
  for (let i = 0; i <= sideSteps; i++) add(domain.lambdaMax, domain.phiMin + (latSpan * i) / sideSteps);
  return `${parts.join("")}Z`;
}

/**
 * SVG path data of the front-facing graticule (default every 30°) of an orthographic globe of diameter `size` centred
 * in a size × size box, for SSR placeholders that crossfade to the canvas. Lines are cut at the limb.
 */
export function graticuleSvgPath(options: {
  size: number;
  centerLon: number;
  centerLat: number;
  step?: number;
}): string {
  const { size, centerLon, centerLat } = options;
  const step = Math.max(5, options.step ?? 30);
  const r = size / 2;
  const rotation = rotationFromView(centerLon, centerLat);
  const v: Vec3 = [0, 0, 0];
  const parts: string[] = [];
  let px = 0;
  let py = 0;
  let pz = -1;
  let drawing = false;
  const point = (x: number, y: number) => `${svgNumber(r + x * r)} ${svgNumber(r - y * r)}`;
  const visit = (lat: number, lon: number, first: boolean) => {
    rotateVector(rotation, latLonToVector(lat, lon, v), v);
    const [x, y, z] = v;
    if (first) {
      drawing = z >= 0;
      if (drawing) parts.push(`M${point(x, y)}`);
    } else if (z >= 0 && pz >= 0) {
      parts.push(`L${point(x, y)}`);
    } else if (z >= 0 !== pz >= 0) {
      // cut where the line crosses the limb, pushed onto the circle
      const t = pz / (pz - z);
      let cx = px + (x - px) * t;
      let cy = py + (y - py) * t;
      const length = Math.hypot(cx, cy) || 1;
      cx /= length;
      cy /= length;
      parts.push(`${z >= 0 ? "M" : "L"}${point(cx, cy)}`);
      if (z >= 0) parts.push(`L${point(x, y)}`);
    }
    px = x;
    py = y;
    pz = z;
  };
  for (let lon = -180; lon < 180; lon += step) {
    for (let lat = -90; lat <= 90; lat += 3) visit(lat, lon, lat === -90);
  }
  for (let lat = -90 + step; lat < 90; lat += step) {
    for (let lon = -180; lon <= 180; lon += 3) visit(lat, lon, lon === -180);
  }
  return parts.join("");
}

/**
 * Projects a polyline continuously on a flat map: each longitude is unwrapped relative to the previous one, so a line
 * that crosses the antimeridian (or the map's seam) runs past the edge instead of jumping across. Returns the main
 * table first, then a copy shifted by ∓360° for each side the line leaves, so a clipped canvas shows both halves.
 * `closed` appends the first point again. Use it for tracks, circles and routes; flatPaths covers two-point arcs.
 */
export function projectPath(
  projection: MapProjection,
  points: readonly LatLon[],
  options: { closed?: boolean } = {},
): ArcLengthTable[] {
  const count = points.length + (options.closed && points.length > 1 ? 1 : 0);
  const lambdas = new Float64Array(count);
  const xs = new Float32Array(count);
  const ys = new Float32Array(count);
  const screen = createScreenPoint();
  const lon0 = projection.centerLon;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < count; i++) {
    const point = points[i % points.length];
    const relative = point.lon - lon0;
    lambdas[i] = i === 0 ? windowLambda(projection, point.lon) : unwrapLongitude(lambdas[i - 1], relative);
    min = Math.min(min, lambdas[i]);
    max = Math.max(max, lambdas[i]);
  }
  const build = (shift: number) => {
    for (let i = 0; i < count; i++) {
      projection.projectRelative(points[i % points.length].lat, lambdas[i] + shift, screen);
      xs[i] = screen.x;
      ys[i] = screen.y;
    }
    return buildArcLength(xs, ys, count);
  };
  const tables = [build(0)];
  if (projection.kind !== "azimuthalEquidistant") {
    const center = windowCenterOf(projection);
    if (max > center + 180) tables.push(build(-360));
    if (min < center - 180) tables.push(build(360));
  }
  return tables;
}

/** Centre of the 360° window ordinary longitudes are wrapped into, in degrees relative to the central meridian. */
function windowCenterOf(projection: MapProjection) {
  const state = projectionStates.get(projection);
  return state ? (state.domain.lambdaMin + state.domain.lambdaMax) / 2 / DEG : 0;
}

/** The relative longitude `project` uses for an ordinary longitude: inside the map's window. */
function windowLambda(projection: MapProjection, lon: number) {
  const center = windowCenterOf(projection);
  return wrapLongitude(lon - projection.centerLon - center) + center;
}

/* caches */

/** A small least-recently-used cache: reading an entry moves it to the back; the oldest entry leaves first. */
class LruCache<V> {
  private readonly entries = new Map<string, V>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  set(key: string, value: V) {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > this.limit) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}

/* spatial index */

/**
 * Uniform-grid index over 2D points. `query` visits every point within `radius` of (x, y) with its squared distance;
 * `nearest` returns the closest point's index, or −1 when nothing is within `maxDistance` (default: no limit).
 */
export interface SpatialGrid {
  query(x: number, y: number, radius: number, visit: (index: number, distanceSquared: number) => void): void;
  nearest(x: number, y: number, maxDistance?: number): number;
}

/**
 * Builds a SpatialGrid over the first `count` points of xs/ys with square cells of `cell` px (about 2 × the dot pitch
 * works well): a counting sort into cells, typed arrays only.
 */
export function createSpatialGrid(xs: Float32Array, ys: Float32Array, count: number, cell: number): SpatialGrid {
  const size = Math.max(1, cell);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < count; i++) {
    minX = Math.min(minX, xs[i]);
    minY = Math.min(minY, ys[i]);
    maxX = Math.max(maxX, xs[i]);
    maxY = Math.max(maxY, ys[i]);
  }
  if (count === 0) {
    return { query() {}, nearest: () => -1 };
  }
  const columns = Math.floor((maxX - minX) / size) + 1;
  const rows = Math.floor((maxY - minY) / size) + 1;
  const starts = new Int32Array(columns * rows + 1);
  const cellOf = new Int32Array(count);
  const items = new Int32Array(count);
  for (let i = 0; i < count; i++) {
    const c = Math.floor((xs[i] - minX) / size);
    const r = Math.floor((ys[i] - minY) / size);
    cellOf[i] = r * columns + c;
    starts[cellOf[i] + 1]++;
  }
  for (let k = 0; k < columns * rows; k++) starts[k + 1] += starts[k];
  const fill = starts.slice(0, columns * rows);
  for (let i = 0; i < count; i++) items[fill[cellOf[i]]++] = i;

  let bestIndex = -1;
  let bestDistance = Infinity;
  /** Finds the closest point within radius into bestIndex / bestDistance (squared). */
  const scan = (x: number, y: number, radius: number) => {
    bestIndex = -1;
    bestDistance = radius * radius;
    const c0 = Math.max(0, Math.floor((x - radius - minX) / size));
    const c1 = Math.min(columns - 1, Math.floor((x + radius - minX) / size));
    const r0 = Math.max(0, Math.floor((y - radius - minY) / size));
    const r1 = Math.min(rows - 1, Math.floor((y + radius - minY) / size));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const k = r * columns + c;
        for (let j = starts[k]; j < starts[k + 1]; j++) {
          const i = items[j];
          const dx = xs[i] - x;
          const dy = ys[i] - y;
          const d = dx * dx + dy * dy;
          if (d <= bestDistance) {
            bestDistance = d;
            bestIndex = i;
          }
        }
      }
    }
  };

  return {
    query(x, y, radius, visit) {
      const limit = radius * radius;
      const c0 = Math.max(0, Math.floor((x - radius - minX) / size));
      const c1 = Math.min(columns - 1, Math.floor((x + radius - minX) / size));
      const r0 = Math.max(0, Math.floor((y - radius - minY) / size));
      const r1 = Math.min(rows - 1, Math.floor((y + radius - minY) / size));
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const k = r * columns + c;
          for (let j = starts[k]; j < starts[k + 1]; j++) {
            const i = items[j];
            const dx = xs[i] - x;
            const dy = ys[i] - y;
            const d = dx * dx + dy * dy;
            if (d <= limit) visit(i, d);
          }
        }
      }
    },
    nearest(x, y, maxDistance = Infinity) {
      if (Number.isFinite(maxDistance)) {
        scan(x, y, maxDistance);
        return bestIndex;
      }
      // grow the search until something turns up; the result is exact once a hit lies within the searched radius
      const reachX = Math.max(Math.abs(x - minX), Math.abs(x - maxX));
      const reachY = Math.max(Math.abs(y - minY), Math.abs(y - maxY));
      const reach = Math.hypot(reachX, reachY);
      for (let radius = size; ; radius *= 2) {
        scan(x, y, Math.min(radius, reach + size));
        if (bestIndex >= 0 || radius > reach) return bestIndex;
      }
    },
  };
}

/* dot lattices */

/**
 * Screen-space map lattice as a structure of arrays. Seeds follow the effort-slider Dot (seed = i·31 + 7: density,
 * jitter, phase, speed), so reveals and twinkles feel the same in every component. `row` and `column` are lattice
 * indices for bayer4; `grid` indexes x/y for neighbourhood queries.
 */
export interface DotLattice {
  readonly count: number;
  readonly pitch: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly lat: Float32Array;
  readonly lon: Float32Array;
  readonly row: Int16Array;
  readonly column: Int16Array;
  /** hash(seed): 0..1, for thinning and dithered reveals. */
  readonly density: Float32Array;
  /** hash(seed + 1.13): 0..1, for uneven fronts (threshold = n·0.82 + jitter·0.18). */
  readonly jitter: Float32Array;
  /** hash(seed + 0.37)·2π: twinkle phase. */
  readonly phase: Float32Array;
  /** 2 + hash(seed + 0.71)·5: twinkle speed in rad/s. */
  readonly speed: Float32Array;
  readonly grid: SpatialGrid;
}

/**
 * Options of mapLattice. Defaults: pitch 4 px, square layout, landOnly true, minCoverage 0.45. `viewport` (screen px)
 * restricts generation for zoomed maps; without it the canvas box limits it.
 */
export interface MapLatticeOptions {
  pitch?: number;
  layout?: "square" | "honeycomb";
  landOnly?: boolean;
  minCoverage?: number;
  viewport?: { x0: number; y0: number; x1: number; y1: number };
}

/** Per-dot seeds shared by every lattice. */
function seedDots(count: number) {
  const density = new Float32Array(count);
  const jitter = new Float32Array(count);
  const phase = new Float32Array(count);
  const speed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const seed = i * 31 + 7;
    density[i] = hash(seed);
    jitter[i] = hash(seed + 1.13);
    phase[i] = hash(seed + 0.37) * TAU;
    speed[i] = 2 + hash(seed + 0.71) * 5;
  }
  return { density, jitter, phase, speed };
}

const mapLatticeCache = new LruCache<DotLattice>(12);

/**
 * A dot grid in screen space at `pitch`, each point inverted to lat/lon and kept when land covers at least
 * `minCoverage` of the dot's footprint (landOnly). The grid is anchored to the projection's frame, so rows and
 * columns stay put across viewports. Cached (LRU of 12) by projection.key and the options; the first call for a
 * 660 px map takes a few milliseconds, so build it in an effect.
 */
export function mapLattice(projection: MapProjection, options: MapLatticeOptions = {}): DotLattice {
  const pitch = Math.max(1, options.pitch ?? 4);
  const layout = options.layout ?? "square";
  const landOnly = options.landOnly ?? true;
  const minCoverage = options.minCoverage ?? 0.45;
  const viewport = options.viewport;
  const viewportKey = viewport ? [viewport.x0, viewport.y0, viewport.x1, viewport.y1].map(round2).join(",") : "";
  const key = `${projection.key}|${pitch}|${layout}|${landOnly}|${minCoverage}|${viewportKey}`;
  const cached = mapLatticeCache.get(key);
  if (cached) return cached;

  const frame = projection.frame;
  const box = viewport ?? { x0: 0, y0: 0, x1: projection.width, y1: projection.height };
  const left = Math.max(frame.x0, Math.min(box.x0, box.x1));
  const right = Math.min(frame.x1, Math.max(box.x0, box.x1));
  const top = Math.max(frame.y0, Math.min(box.y0, box.y1));
  const bottom = Math.min(frame.y1, Math.max(box.y0, box.y1));
  const rowStep = layout === "honeycomb" ? pitch * 0.866 : pitch;
  const footprint = Math.max(0.5, toDegrees(pitch / Math.max(1e-9, projection.scale)));
  const firstRow = Math.max(0, Math.ceil((top - frame.y0) / rowStep - 0.5));
  const lastRow = Math.floor((bottom - frame.y0) / rowStep - 0.5);
  const firstColumn = Math.max(0, Math.ceil((left - frame.x0) / pitch - 1));
  const lastColumn = Math.floor((right - frame.x0) / pitch);
  const capacity = Math.max(0, (lastRow - firstRow + 1) * (lastColumn - firstColumn + 2));
  const xs = new Float32Array(capacity);
  const ys = new Float32Array(capacity);
  const lats = new Float32Array(capacity);
  const lons = new Float32Array(capacity);
  const rows = new Int16Array(capacity);
  const columns = new Int16Array(capacity);
  let count = 0;
  for (let r = firstRow; r <= lastRow; r++) {
    const y = frame.y0 + (r + 0.5) * rowStep;
    const offset = layout === "honeycomb" && r % 2 === 1 ? pitch / 2 : 0;
    for (let c = firstColumn; c <= lastColumn; c++) {
      const x = frame.x0 + (c + 0.5) * pitch + offset;
      if (x < left || x > right || count >= capacity) continue;
      const point = projection.invert(x, y);
      if (!point) continue;
      if (landOnly) {
        const covered =
          footprint > 0.5 ? landCoverage(point.lat, point.lon, footprint) >= minCoverage : isLand(point.lat, point.lon);
        if (!covered) continue;
      }
      xs[count] = x;
      ys[count] = y;
      lats[count] = point.lat;
      lons[count] = point.lon;
      rows[count] = r;
      columns[count] = c;
      count++;
    }
  }
  const x = xs.slice(0, count);
  const y = ys.slice(0, count);
  const lattice: DotLattice = {
    count,
    pitch,
    x,
    y,
    lat: lats.slice(0, count),
    lon: lons.slice(0, count),
    row: rows.slice(0, count),
    column: columns.slice(0, count),
    ...seedDots(count),
    grid: createSpatialGrid(x, y, count, Math.max(8, pitch * 2)),
  };
  mapLatticeCache.set(key, lattice);
  return lattice;
}

/**
 * Dots on the unit sphere as a structure of arrays: unit vectors (`xyz`, 3 per dot), lat/lon, a land flag, lattice
 * row/column for bayer4 and the shared seeds. `lonBuckets` (361 start offsets, one bucket per degree of longitude
 * from −180) is set when ordered by longitude, so a partial view iterates only the visible longitudes:
 * for bucket b, dots lonBuckets[b] .. lonBuckets[b + 1] − 1.
 */
export interface SphereLattice {
  readonly count: number;
  readonly xyz: Float32Array;
  readonly lat: Float32Array;
  readonly lon: Float32Array;
  readonly land: Uint8Array;
  readonly row: Int32Array;
  readonly column: Int32Array;
  readonly density: Float32Array;
  readonly jitter: Float32Array;
  readonly phase: Float32Array;
  readonly speed: Float32Array;
  readonly lonBuckets: Int32Array | null;
}

/**
 * Options of sphereLattice. Rows (default): latitude rows every `spacingDeg` (default 2) with
 * max(1, round(360·cos φ / spacing)) dots per row, each row offset by hash(row). Fibonacci: `count` (default 1000)
 * points with the ε = 0.36 offset (no pole clumping). Both carry a land flag; `landOnly` (default false) keeps only
 * land; `latRange` crops; `order: "longitude"` sorts by longitude and fills lonBuckets.
 */
export interface SphereLatticeOptions {
  spacingDeg?: number;
  count?: number;
  method?: "rows" | "fibonacci";
  landOnly?: boolean;
  latRange?: readonly [number, number];
  order?: "rows" | "longitude";
}

const sphereLatticeCache = new LruCache<SphereLattice>(8);
const GOLDEN_RATIO = (1 + Math.sqrt(5)) / 2;

/** Land test for a dot that covers `size` degrees: area share when the dot is larger than a mask cell. */
const dotIsLand = (lat: number, lon: number, size: number) =>
  size > 0.5 ? landCoverage(lat, lon, size) >= 0.5 : isLand(lat, lon);

/**
 * Dots on the sphere for globes. Lazy and cached (LRU of 8) by options, so several globes of one size share one
 * lattice. Large lattices (spacing below 0.5°) take tens of milliseconds the first time: build them in an effect.
 */
export function sphereLattice(options: SphereLatticeOptions): SphereLattice {
  const method = options.method ?? "rows";
  const landOnly = options.landOnly ?? false;
  const order = options.order ?? "rows";
  const spacing = Math.max(0.1, options.spacingDeg ?? 2);
  const total = Math.max(1, Math.round(options.count ?? 1000));
  const south = options.latRange ? Math.min(options.latRange[0], options.latRange[1]) : -90;
  const north = options.latRange ? Math.max(options.latRange[0], options.latRange[1]) : 90;
  const key = [method, method === "rows" ? spacing : total, landOnly, order, round2(south), round2(north)].join("|");
  const cached = sphereLatticeCache.get(key);
  if (cached) return cached;

  const lats: number[] = [];
  const lons: number[] = [];
  const lands: number[] = [];
  const rowIndex: number[] = [];
  const columnIndex: number[] = [];
  const push = (lat: number, lon: number, land: boolean, row: number, column: number) => {
    if (lat < south || lat > north || (landOnly && !land)) return;
    lats.push(lat);
    lons.push(lon);
    lands.push(land ? 1 : 0);
    rowIndex.push(row);
    columnIndex.push(column);
  };
  if (method === "rows") {
    for (let row = 0; -90 + spacing / 2 + row * spacing < 90; row++) {
      const lat = -90 + spacing / 2 + row * spacing;
      if (lat < south - spacing || lat > north + spacing) continue;
      const perRow = Math.max(1, Math.round((360 * Math.cos(lat * DEG)) / spacing));
      const step = 360 / perRow;
      const offset = hash(row) * step;
      for (let k = 0; k < perRow; k++) {
        const lon = wrapLongitude(-180 + offset + k * step);
        push(lat, lon, dotIsLand(lat, lon, spacing), row, k);
      }
    }
  } else {
    const epsilon = 0.36;
    const size = Math.sqrt(41253 / total);
    for (let i = 0; i < total; i++) {
      const lat = Math.asin(clamp(1 - (2 * (i + epsilon)) / (total - 1 + 2 * epsilon), -1, 1)) / DEG;
      const lon = wrapLongitude((360 * i) / GOLDEN_RATIO);
      // an approximate grid position, so bayer4 dithering still spreads evenly
      const row = Math.round((lat + 90) / size);
      const column = Math.round(((lon + 180) * Math.cos(lat * DEG)) / size);
      push(lat, lon, dotIsLand(lat, lon, size), row, column);
    }
  }

  const count = lats.length;
  const indices = Array.from({ length: count }, (_, i) => i);
  let lonBuckets: Int32Array | null = null;
  if (order === "longitude") {
    indices.sort((a, b) => lons[a] - lons[b]);
    lonBuckets = new Int32Array(361);
    let bucket = 0;
    for (let i = 0; i < count; i++) {
      const b = clamp(Math.floor(lons[indices[i]] + 180), 0, 359);
      while (bucket <= b) lonBuckets[bucket++] = i;
    }
    while (bucket <= 360) lonBuckets[bucket++] = count;
  }
  const xyz = new Float32Array(count * 3);
  const lat = new Float32Array(count);
  const lon = new Float32Array(count);
  const land = new Uint8Array(count);
  const row = new Int32Array(count);
  const column = new Int32Array(count);
  const v: Vec3 = [0, 0, 0];
  for (let i = 0; i < count; i++) {
    const source = indices[i];
    lat[i] = lats[source];
    lon[i] = lons[source];
    land[i] = lands[source];
    row[i] = rowIndex[source];
    column[i] = columnIndex[source];
    latLonToVector(lats[source], lons[source], v);
    xyz[i * 3] = v[0];
    xyz[i * 3 + 1] = v[1];
    xyz[i * 3 + 2] = v[2];
  }
  const lattice: SphereLattice = { count, xyz, lat, lon, land, row, column, ...seedDots(count), lonBuckets };
  sphereLatticeCache.set(key, lattice);
  return lattice;
}

/**
 * Degrees between lattice rows so that dots at the globe's centre are `pitch` px apart: toDegrees(pitch / radius), at
 * least 0.25.
 */
export function spacingForRadius(radius: number, pitch: number): number {
  return Math.max(0.25, toDegrees(pitch / Math.max(1e-9, radius)));
}

const vectorCache = new WeakMap<DotLattice, Float32Array>();

/**
 * Unit vectors (x, y, z per dot) of a map lattice's points, for angular tests such as catchments. Cached per lattice.
 */
export function latticeVectors(lattice: DotLattice): Float32Array {
  const cached = vectorCache.get(lattice);
  if (cached) return cached;
  const xyz = new Float32Array(lattice.count * 3);
  const v: Vec3 = [0, 0, 0];
  for (let i = 0; i < lattice.count; i++) {
    latLonToVector(lattice.lat[i], lattice.lon[i], v);
    xyz[i * 3] = v[0];
    xyz[i * 3 + 1] = v[1];
    xyz[i * 3 + 2] = v[2];
  }
  vectorCache.set(lattice, xyz);
  return xyz;
}

/* dot drawing */

/**
 * Draws every dot of a map lattice as a `size` px square centred on its point, with one fillStyle and the given alpha
 * (default 1). For static offscreen layers that are baked once and blitted with drawImage.
 */
export function bakeLattice(
  context: CanvasRenderingContext2D,
  lattice: DotLattice,
  color: RGB,
  size: number,
  alpha = 1,
): void {
  const half = size / 2;
  context.fillStyle = rgba(color);
  context.globalAlpha = alpha;
  for (let i = 0; i < lattice.count; i++) context.fillRect(lattice.x[i] - half, lattice.y[i] - half, size, size);
  context.globalAlpha = 1;
}

/**
 * rgb() strings at `steps` (default 32) evenly spaced positions along a multi-stop ramp; precompute them once per
 * theme.
 */
export function shadeRamp(stops: readonly RGB[], steps = 32): string[] {
  const count = Math.max(1, Math.round(steps));
  const ramp: string[] = [];
  if (stops.length === 0) return Array.from({ length: count }, () => "rgb(128,128,128)");
  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0 : i / (count - 1);
    const position = t * (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(position));
    ramp.push(stops.length === 1 ? rgba(stops[0]) : rgba(mixRgb(stops[index], stops[index + 1], position - index)));
  }
  return ramp;
}

/**
 * Bucketed dot renderer: `add` queues a square dot with a tone (0..1, a position on the colour ramp) and an alpha
 * (quantised to `levels`; below 1/levels it is skipped). `flush` draws the queue with one fillStyle and globalAlpha
 * per bucket and empties it, so hot loops never build colour strings. `setRamp` swaps the colours (theme change).
 */
export interface DotBatch {
  add(x: number, y: number, size: number, tone: number, alpha: number): void;
  flush(context: CanvasRenderingContext2D): void;
  setRamp(stops: readonly RGB[]): void;
}

/**
 * Creates a DotBatch for about `capacity` dots per frame (it grows by doubling) over a colour ramp through `stops`.
 * Defaults: 16 tones × 16 alpha levels.
 */
export function createDotBatch(
  capacity: number,
  stops: readonly RGB[],
  options: { tones?: number; levels?: number } = {},
): DotBatch {
  const tones = clamp(Math.round(options.tones ?? 16), 1, 256);
  const levels = clamp(Math.round(options.levels ?? 16), 1, 256);
  const buckets = tones * levels;
  let size = Math.max(16, Math.round(capacity));
  let xs = new Float32Array(size);
  let ys = new Float32Array(size);
  let sizes = new Float32Array(size);
  let bucketOf = new Uint16Array(size);
  let order = new Int32Array(size);
  const starts = new Int32Array(buckets + 1);
  const cursor = new Int32Array(buckets);
  let ramp = shadeRamp(stops, tones);
  let count = 0;

  const grow = () => {
    size *= 2;
    const nextXs = new Float32Array(size);
    const nextYs = new Float32Array(size);
    const nextSizes = new Float32Array(size);
    const nextBuckets = new Uint16Array(size);
    nextXs.set(xs);
    nextYs.set(ys);
    nextSizes.set(sizes);
    nextBuckets.set(bucketOf);
    xs = nextXs;
    ys = nextYs;
    sizes = nextSizes;
    bucketOf = nextBuckets;
    order = new Int32Array(size);
  };

  return {
    add(x, y, dotSize, tone, alpha) {
      if (!(alpha >= 1 / levels)) return;
      if (count >= size) grow();
      const toneIndex = Math.round(clamp(tone, 0, 1) * (tones - 1));
      const level = Math.min(levels - 1, Math.max(0, Math.round(alpha * levels) - 1));
      xs[count] = x;
      ys[count] = y;
      sizes[count] = dotSize;
      bucketOf[count] = toneIndex * levels + level;
      count++;
    },
    flush(context) {
      if (count === 0) return;
      starts.fill(0);
      for (let i = 0; i < count; i++) starts[bucketOf[i] + 1]++;
      for (let b = 0; b < buckets; b++) starts[b + 1] += starts[b];
      for (let b = 0; b < buckets; b++) cursor[b] = starts[b];
      for (let i = 0; i < count; i++) order[cursor[bucketOf[i]]++] = i;
      for (let b = 0; b < buckets; b++) {
        if (starts[b] === starts[b + 1]) continue;
        context.fillStyle = ramp[Math.floor(b / levels)];
        context.globalAlpha = ((b % levels) + 1) / levels;
        for (let j = starts[b]; j < starts[b + 1]; j++) {
          const i = order[j];
          const half = sizes[i] / 2;
          context.fillRect(xs[i] - half, ys[i] - half, sizes[i], sizes[i]);
        }
      }
      context.globalAlpha = 1;
      count = 0;
    },
    setRamp(next) {
      ramp = shadeRamp(next, tones);
    },
  };
}

/* coastlines, countries and zones on flat maps */

const traceScratch = createScreenPoint();

/** Screen box accumulated while tracing. */
interface TraceBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Adds a projected polyline to a path, breaking where the longitude jumps across the map's seam (more than 180°
 * between neighbours in the map's window) or, with `skipSeams`, along antimeridian cut segments (isSeam). Returns the
 * stroked length in px and grows `box` by the drawn points.
 */
function traceProjected(
  target: CanvasPath,
  projection: MapProjection,
  lonLat: ArrayLike<number>,
  closed: boolean,
  skipSeams: boolean,
  box?: TraceBox,
): number {
  const n = Math.floor(lonLat.length / 2);
  if (n < 2) return 0;
  const center = windowCenterOf(projection);
  const lon0 = projection.centerLon;
  const segments = closed ? n : n - 1;
  let length = 0;
  let penDown = false;
  let previousLambda = 0;
  let previousLon = 0;
  let px = 0;
  let py = 0;
  for (let k = 0; k <= segments; k++) {
    const i = k % n;
    const lon = lonLat[i * 2];
    const lat = lonLat[i * 2 + 1];
    const lambda = wrapLongitude(lon - lon0 - center) + center;
    projection.projectRelative(lat, lambda, traceScratch);
    const x = traceScratch.x;
    const y = traceScratch.y;
    if (k > 0) {
      const jump = Math.abs(lambda - previousLambda) > 180 || (skipSeams && isSeam(previousLon, lon));
      if (jump) {
        penDown = false;
      } else {
        if (!penDown) {
          target.moveTo(px, py);
          penDown = true;
          if (box) growBox(box, px, py);
        }
        target.lineTo(x, y);
        length += Math.hypot(x - px, y - py);
        if (box) growBox(box, x, y);
      }
    }
    previousLambda = lambda;
    previousLon = lon;
    px = x;
    py = y;
  }
  return length;
}

function growBox(box: TraceBox, x: number, y: number) {
  box.x0 = Math.min(box.x0, x);
  box.y0 = Math.min(box.y0, y);
  box.x1 = Math.max(box.x1, x);
  box.y1 = Math.max(box.y1, y);
}

const coastPathCache = new LruCache<Path2D>(16);

/**
 * Every coastline from geo-world projected into one Path2D, split at seam jumps. Cached by projection.key. Client
 * only: call it from effects or draw code, never during render.
 */
export function coastlinePath(projection: MapProjection): Path2D {
  const cached = coastPathCache.get(projection.key);
  if (cached) return cached;
  const path = new Path2D();
  for (const ring of coastlines()) traceProjected(path, projection, ring, false, false);
  coastPathCache.set(projection.key, path);
  return path;
}

/**
 * Adds a projected [lon, lat, …] polyline to the current path, breaking at seam jumps (isSeam or a jump of more than
 * 180° in the map's window). `closed` also draws the segment from the last point back to the first. The caller
 * strokes. Works on a CanvasRenderingContext2D or a Path2D.
 */
export function traceMapLine(
  context: CanvasPath,
  projection: MapProjection,
  lonLat: ArrayLike<number>,
  closed: boolean,
): void {
  traceProjected(context, projection, lonLat, closed, true);
}

/**
 * A country's stroke outline on a projection: the path, its stroked length in px (for dash animations) and its screen
 * box.
 */
export interface CountryOutline {
  readonly path: Path2D;
  readonly length: number;
  readonly bounds: { x0: number; y0: number; x1: number; y1: number };
}

const outlineCache = new LruCache<CountryOutline>(256);

/**
 * Stroke outline of a country from geo-countries (outer rings and holes, antimeridian seam segments skipped) with its
 * stroked length in px and its screen bounds. Cached by code + projection.key; an empty outline (length 0) for
 * unknown codes. Client only. For a border light: setLineDash([dash, outline.length]) and run lineDashOffset.
 */
export function countryOutline(code: string, projection: MapProjection): CountryOutline {
  const key = `${code.toUpperCase()}|${projection.key}`;
  const cached = outlineCache.get(key);
  if (cached) return cached;
  const path = new Path2D();
  const box: TraceBox = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let length = 0;
  for (const polygon of countryShape(code)) {
    for (const ring of polygon) length += traceProjected(path, projection, ring, false, true, box);
  }
  const bounds = Number.isFinite(box.x0) ? box : { x0: 0, y0: 0, x1: 0, y1: 0 };
  const outline: CountryOutline = { path, length, bounds };
  outlineCache.set(key, outline);
  return outline;
}

/** The narrowest longitude interval [west, east] that holds every longitude (east may exceed 180). */
function narrowestLonSpan(lons: number[]): [number, number] {
  const sorted = lons.map(wrapLongitude).sort((a, b) => a - b);
  let gap = sorted[0] + 360 - sorted[sorted.length - 1];
  let west = sorted[0];
  let east = sorted[sorted.length - 1];
  for (let i = 1; i < sorted.length; i++) {
    const g = sorted[i] - sorted[i - 1];
    if (g > gap) {
      gap = g;
      west = sorted[i];
      east = sorted[i - 1] + 360;
    }
  }
  return [west, east];
}

const countryBoundsCache = new Map<string, GeoBounds | null>();

/**
 * Lon/lat box of a country's outer rings, using the smaller longitude span (east may exceed 180, so Fiji or Russia do
 * not span the world); null for unknown codes. Cached.
 */
export function countryBounds(code: string): GeoBounds | null {
  const key = code.toUpperCase();
  const cached = countryBoundsCache.get(key);
  if (cached !== undefined) return cached;
  const lons: number[] = [];
  let south = Infinity;
  let north = -Infinity;
  for (const polygon of countryShape(key)) {
    const outer = polygon[0];
    if (!outer) continue;
    for (let i = 0; i + 1 < outer.length; i += 2) {
      lons.push(outer[i]);
      south = Math.min(south, outer[i + 1]);
      north = Math.max(north, outer[i + 1]);
    }
  }
  let bounds: GeoBounds | null = null;
  if (lons.length > 0) {
    const [west, east] = narrowestLonSpan(lons);
    bounds = { west, south, east, north };
  }
  countryBoundsCache.set(key, bounds);
  return bounds;
}

let countryIndexByCode: Map<string, number> | null = null;

/** Index of a country in COUNTRIES by ISO code (case-insensitive), or −1. */
export function countryIndex(code: string): number {
  countryIndexByCode ??= new Map(COUNTRIES.map((country, index) => [country.code, index]));
  return countryIndexByCode.get(code.toUpperCase()) ?? -1;
}

const membershipCache = new WeakMap<DotLattice, Int16Array>();

/**
 * Per lattice dot, the index into COUNTRIES of the country it lies in (via countryAt), or −1 over water. Computed once
 * per lattice (about 20 ms for a 660 px map; run it in an effect) and cached.
 */
export function countryMembership(lattice: DotLattice): Int16Array {
  const cached = membershipCache.get(lattice);
  if (cached) return cached;
  const membership = new Int16Array(lattice.count);
  for (let i = 0; i < lattice.count; i++) {
    const country = countryAt(lattice.lat[i], lattice.lon[i]);
    membership[i] = country ? countryIndex(country.code) : -1;
  }
  membershipCache.set(lattice, membership);
  return membership;
}

/** Even-odd ray cast of a point (degrees) against a flat [lon, lat, …] ring (closed or not). */
export function pointInRing(lat: number, lon: number, ring: ArrayLike<number>): boolean {
  let inside = false;
  const n = Math.floor(ring.length / 2);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A jurisdiction: ISO alpha-2 country codes, a custom polygon (closed or not), or both (their union). */
export interface ZoneShape {
  readonly countries?: readonly string[];
  readonly polygon?: readonly LatLon[];
}

const zoneCodeCache = new WeakMap<readonly string[], Set<string>>();
const zoneRingCache = new WeakMap<readonly LatLon[], { ring: Float64Array; center: number }>();

/** The polygon as a flat ring with longitudes unwrapped point to point, so polygons across the antimeridian work. */
function zoneRing(polygon: readonly LatLon[]) {
  const cached = zoneRingCache.get(polygon);
  if (cached) return cached;
  const ring = new Float64Array(polygon.length * 2);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const lon = i === 0 ? wrapLongitude(polygon[0].lon) : unwrapLongitude(ring[(i - 1) * 2], polygon[i].lon);
    ring[i * 2] = lon;
    ring[i * 2 + 1] = polygon[i].lat;
    min = Math.min(min, lon);
    max = Math.max(max, lon);
  }
  const entry = { ring, center: (min + max) / 2 };
  zoneRingCache.set(polygon, entry);
  return entry;
}

/** The zone's country codes, upper-cased, as a set (cached per array). */
function zoneCodes(countries: readonly string[]) {
  let codes = zoneCodeCache.get(countries);
  if (!codes) {
    codes = new Set(countries.map((code) => code.toUpperCase()));
    zoneCodeCache.set(countries, codes);
  }
  return codes;
}

/**
 * Whether a point (degrees) lies in a zone: in one of its countries (countryAt) or inside its polygon (pointInRing).
 */
export function zoneContains(zone: ZoneShape, lat: number, lon: number): boolean {
  if (zone.countries && zone.countries.length > 0) {
    const country = countryAt(lat, lon);
    if (country && zoneCodes(zone.countries).has(country.code)) return true;
  }
  if (zone.polygon && zone.polygon.length >= 3) {
    const { ring, center } = zoneRing(zone.polygon);
    if (pointInRing(lat, unwrapLongitude(center, lon), ring)) return true;
  }
  return false;
}

/**
 * Per lattice dot, 1 when the dot lies in the zone, else 0: countries through countryMembership, the polygon through
 * pointInRing. Not cached (zones change); compute it in a memo or effect once per lattice and zone.
 */
export function zoneMembership(lattice: DotLattice, zone: ZoneShape): Uint8Array {
  const inside = new Uint8Array(lattice.count);
  const indices = new Set<number>();
  for (const code of zone.countries ?? []) {
    const index = countryIndex(code);
    if (index >= 0) indices.add(index);
  }
  const membership = indices.size > 0 ? countryMembership(lattice) : null;
  const polygon = zone.polygon && zone.polygon.length >= 3 ? zoneRing(zone.polygon) : null;
  for (let i = 0; i < lattice.count; i++) {
    if (membership && indices.has(membership[i])) inside[i] = 1;
    else if (polygon && pointInRing(lattice.lat[i], unwrapLongitude(polygon.center, lattice.lon[i]), polygon.ring)) {
      inside[i] = 1;
    }
  }
  return inside;
}

/* lines on the globe */

let rotatedBuffer = new Float64Array(3 * 512);

function ensureRotatedBuffer(points: number) {
  if (rotatedBuffer.length < points * 3) {
    rotatedBuffer = new Float64Array(Math.max(points * 3, rotatedBuffer.length * 2));
  }
  return rotatedBuffer;
}

/** Limb point between two rotated vertices a and b (view space) where z crosses 0, pushed onto the unit circle. */
function limbPoint(buffer: Float64Array, a: number, b: number, out: { x: number; y: number }) {
  const za = buffer[a * 3 + 2];
  const zb = buffer[b * 3 + 2];
  const t = za / (za - zb);
  const x = buffer[a * 3] + (buffer[b * 3] - buffer[a * 3]) * t;
  const y = buffer[a * 3 + 1] + (buffer[b * 3 + 1] - buffer[a * 3 + 1]) * t;
  const length = Math.hypot(x, y) || 1;
  out.x = x / length;
  out.y = y / length;
}

const limbScratch = { x: 0, y: 0 };

/** Signed area of the rotated ring's x/y in view space (y up): negative when it runs clockwise as seen. */
function viewArea(buffer: Float64Array, n: number) {
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area += buffer[j * 3] * buffer[i * 3 + 1] - buffer[i * 3] * buffer[j * 3 + 1];
  }
  return area / 2;
}

/** Traces n rotated vertices held in rotatedBuffer. */
function traceRotated(target: CanvasPath, view: GlobeView, n: number, closed: boolean, altitude: number) {
  const buffer = rotatedBuffer;
  const r = view.radius * (1 + altitude);
  const cx = view.cx;
  const cy = view.cy;
  const sx = (i: number) => cx + buffer[i * 3] * r;
  const sy = (i: number) => cy - buffer[i * 3 + 1] * r;
  if (n < 2) return;
  if (!closed) {
    let penDown = false;
    for (let i = 0; i < n; i++) {
      const front = buffer[i * 3 + 2] >= 0;
      if (i === 0) {
        if (front) {
          target.moveTo(sx(0), sy(0));
          penDown = true;
        }
        continue;
      }
      const previousFront = buffer[(i - 1) * 3 + 2] >= 0;
      if (front && previousFront) {
        if (!penDown) target.moveTo(sx(i - 1), sy(i - 1));
        target.lineTo(sx(i), sy(i));
        penDown = true;
      } else if (previousFront) {
        limbPoint(buffer, i - 1, i, limbScratch);
        target.lineTo(cx + limbScratch.x * r, cy - limbScratch.y * r);
        penDown = false;
      } else if (front) {
        limbPoint(buffer, i - 1, i, limbScratch);
        target.moveTo(cx + limbScratch.x * r, cy - limbScratch.y * r);
        target.lineTo(sx(i), sy(i));
        penDown = true;
      } else {
        penDown = false;
      }
    }
    return;
  }

  // closed ring as an area whose interior lies right of the travel direction (seen from outside the globe)
  let visible = 0;
  let entry = -1;
  for (let i = 0; i < n; i++) {
    if (buffer[i * 3 + 2] < 0) continue;
    visible++;
    if (entry < 0 && buffer[((i - 1 + n) % n) * 3 + 2] < 0) entry = i;
  }
  if (visible === 0 || visible === n) {
    const clockwise = viewArea(buffer, n) < 0;
    if (visible === n) {
      target.moveTo(sx(0), sy(0));
      for (let i = 1; i < n; i++) target.lineTo(sx(i), sy(i));
      target.closePath();
    }
    // all behind and clockwise as seen through the globe: the area holds the whole front hemisphere; all in front and
    // counter-clockwise: the area is everything but the loop. Both add the disc (fill with "evenodd").
    if ((visible === 0 && clockwise) || (visible === n && !clockwise)) {
      target.moveTo(cx + r, cy);
      target.arc(cx, cy, r, 0, TAU);
      target.closePath();
    }
    return;
  }
  const first = (entry - 1 + n) % n;
  limbPoint(buffer, first, entry, limbScratch);
  target.moveTo(cx + limbScratch.x * r, cy - limbScratch.y * r);
  target.lineTo(sx(entry), sy(entry));
  let exitAngle = 0;
  for (let k = 0; k < n; k++) {
    const a = (entry + k) % n;
    const b = (a + 1) % n;
    const frontA = buffer[a * 3 + 2] >= 0;
    const frontB = buffer[b * 3 + 2] >= 0;
    if (frontA && frontB) {
      target.lineTo(sx(b), sy(b));
    } else if (frontA) {
      limbPoint(buffer, a, b, limbScratch);
      target.lineTo(cx + limbScratch.x * r, cy - limbScratch.y * r);
      exitAngle = Math.atan2(-limbScratch.y, limbScratch.x);
    } else if (frontB) {
      limbPoint(buffer, a, b, limbScratch);
      // along the limb, clockwise on screen, keeps the interior on the right
      target.arc(cx, cy, r, exitAngle, Math.atan2(-limbScratch.y, limbScratch.x), false);
      target.lineTo(sx(b), sy(b));
    }
  }
  target.closePath();
}

/**
 * Adds subpaths for the front-facing parts of a flat [lon, lat, …] polyline on a globe; segments crossing the horizon
 * are cut at the interpolated z = 0 point pushed onto the limb. `closed: false` is for strokes (a ring whose last
 * point repeats the first strokes correctly). `closed: true` treats the ring as an area whose interior lies to the
 * right of the travel direction seen from outside (clockwise rings, as geodesicCircle returns) and joins the visible
 * parts along the limb, so `fill("evenodd")` covers exactly its visible part (night side, coverage caps). Works on a
 * CanvasRenderingContext2D or a Path2D; the caller strokes or fills. `altitude` lifts the line (share of the radius).
 */
export function traceGlobeLine(
  context: CanvasPath,
  view: GlobeView,
  lonLat: ArrayLike<number>,
  closed: boolean,
  altitude = 0,
): void {
  const n = Math.floor(lonLat.length / 2);
  const buffer = ensureRotatedBuffer(n);
  const m = view.rotation;
  for (let i = 0; i < n; i++) {
    const phi = lonLat[i * 2 + 1] * DEG;
    const lambda = lonLat[i * 2] * DEG;
    const cosPhi = Math.cos(phi);
    const x = cosPhi * Math.sin(lambda);
    const y = Math.sin(phi);
    const z = cosPhi * Math.cos(lambda);
    buffer[i * 3] = m[0] * x + m[1] * y + m[2] * z;
    buffer[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z;
    buffer[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z;
  }
  traceRotated(context, view, n, closed, altitude);
}

/** Flattens LatLon points into the [lon, lat, …] form traceGlobeLine and traceMapLine take. */
export function toLonLat(points: readonly LatLon[]): Float64Array {
  const flat = new Float64Array(points.length * 2);
  for (let i = 0; i < points.length; i++) {
    flat[i * 2] = points[i].lon;
    flat[i * 2 + 1] = points[i].lat;
  }
  return flat;
}

let coastVectors: Float32Array[] | null = null;

/** Unit vectors of every coastline vertex, computed once. */
function coastlineVectors(): readonly Float32Array[] {
  if (coastVectors) return coastVectors;
  const v: Vec3 = [0, 0, 0];
  coastVectors = coastlines().map((ring) => {
    const n = Math.floor(ring.length / 2);
    const xyz = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      latLonToVector(ring[i * 2 + 1], ring[i * 2], v);
      xyz[i * 3] = v[0];
      xyz[i * 3 + 1] = v[1];
      xyz[i * 3 + 2] = v[2];
    }
    return xyz;
  });
  return coastVectors;
}

/**
 * traceGlobeLine for every coastline (unit vectors cached once). The caller strokes, typically 0.75 px foreground at
 * 0.16.
 */
export function traceGlobeCoastlines(context: CanvasPath, view: GlobeView): void {
  const m = view.rotation;
  for (const xyz of coastlineVectors()) {
    const n = xyz.length / 3;
    const buffer = ensureRotatedBuffer(n);
    for (let i = 0; i < n; i++) {
      const x = xyz[i * 3];
      const y = xyz[i * 3 + 1];
      const z = xyz[i * 3 + 2];
      buffer[i * 3] = m[0] * x + m[1] * y + m[2] * z;
      buffer[i * 3 + 1] = m[3] * x + m[4] * y + m[5] * z;
      buffer[i * 3 + 2] = m[6] * x + m[7] * y + m[8] * z;
    }
    traceRotated(context, view, n, false, 0);
  }
}

/* curves and arc length */

/** Quadratic Bézier in screen px: start, control point, end. */
export interface QuadCurve {
  x0: number;
  y0: number;
  cx: number;
  cy: number;
  x1: number;
  y1: number;
}

/**
 * A curve between two screen points: control point = midpoint + left normal × chord length × bend. Positive bends to
 * the left of the travel direction (as seen on screen), so the two directions of a link bend apart. Writes into `out`
 * when given.
 */
export function flatCurve(x0: number, y0: number, x1: number, y1: number, bend: number, out?: QuadCurve): QuadCurve {
  const curve = out ?? { x0: 0, y0: 0, cx: 0, cy: 0, x1: 0, y1: 0 };
  curve.x0 = x0;
  curve.y0 = y0;
  curve.x1 = x1;
  curve.y1 = y1;
  // (dy, −dx) is the left normal in y-down screen space, already scaled by the chord length
  curve.cx = (x0 + x1) / 2 + (y1 - y0) * bend;
  curve.cy = (y0 + y1) / 2 - (x1 - x0) * bend;
  return curve;
}

/** Point on a quadratic curve at t in [0, 1]. Allocation-free. */
export function quadPoint(curve: QuadCurve, t: number, out: { x: number; y: number }): void {
  const u = 1 - t;
  out.x = u * u * curve.x0 + 2 * u * t * curve.cx + t * t * curve.x1;
  out.y = u * u * curve.y0 + 2 * u * t * curve.cy + t * t * curve.y1;
}

/** Unit tangent of a quadratic curve at t (the chord direction for degenerate curves). Allocation-free. */
export function quadTangent(curve: QuadCurve, t: number, out: { x: number; y: number }): void {
  const u = 1 - t;
  let x = 2 * u * (curve.cx - curve.x0) + 2 * t * (curve.x1 - curve.cx);
  let y = 2 * u * (curve.cy - curve.y0) + 2 * t * (curve.y1 - curve.cy);
  let length = Math.hypot(x, y);
  if (length < 1e-9) {
    x = curve.x1 - curve.x0;
    y = curve.y1 - curve.y0;
    length = Math.hypot(x, y);
  }
  out.x = length < 1e-9 ? 1 : x / length;
  out.y = length < 1e-9 ? 0 : y / length;
}

/**
 * Polyline with cumulative distances, for constant-speed packets and evenly spaced dots. Buffers may be longer than
 * `count`.
 */
export interface ArcLengthTable {
  count: number;
  /** Total length in px. */
  length: number;
  xs: Float32Array;
  ys: Float32Array;
  /** Cumulative distance at each point; distances[0] = 0. */
  distances: Float32Array;
}

function tableWithCapacity(count: number, out?: ArcLengthTable): ArcLengthTable {
  if (out && out.xs.length >= count && out.ys.length >= count && out.distances.length >= count) return out;
  const size = Math.max(2, count);
  const empty = new Float32Array(0);
  const table = out ?? { count: 0, length: 0, xs: empty, ys: empty, distances: empty };
  table.xs = new Float32Array(size);
  table.ys = new Float32Array(size);
  table.distances = new Float32Array(size);
  return table;
}

/**
 * Builds a table from the first `count` points of xs/ys, or refills `out` (its buffers are reused when large enough,
 * so a per-frame rebuild does not allocate). xs/ys may be the table's own buffers.
 */
export function buildArcLength(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  count: number,
  out?: ArcLengthTable,
): ArcLengthTable {
  const table = tableWithCapacity(count, out);
  let length = 0;
  for (let i = 0; i < count; i++) {
    const x = xs[i];
    const y = ys[i];
    if (i > 0) length += Math.hypot(x - table.xs[i - 1], y - table.ys[i - 1]);
    table.xs[i] = x;
    table.ys[i] = y;
    table.distances[i] = length;
  }
  table.count = count;
  table.length = length;
  return table;
}

/** Samples a quadratic curve at segments + 1 points (default 40 segments) into an arc-length table, reusing `out`. */
export function quadArcLength(curve: QuadCurve, segments = 40, out?: ArcLengthTable): ArcLengthTable {
  const steps = Math.max(1, Math.round(segments));
  const table = tableWithCapacity(steps + 1, out);
  const point = { x: 0, y: 0 };
  for (let i = 0; i <= steps; i++) {
    quadPoint(curve, i / steps, point);
    table.xs[i] = point.x;
    table.ys[i] = point.y;
  }
  return buildArcLength(table.xs, table.ys, steps + 1, table);
}

let resampleX = new Float32Array(128);
let resampleY = new Float32Array(128);

/**
 * `count` points evenly spaced by arc length along a table, as a new table (or refilled `out`, which may be the input),
 * so two different polylines (a relayed and a direct path, a globe and a map route) can be blended sample by sample.
 */
export function resampleArcLength(table: ArcLengthTable, count: number, out?: ArcLengthTable): ArcLengthTable {
  const n = Math.max(2, Math.round(count));
  if (resampleX.length < n) {
    resampleX = new Float32Array(n);
    resampleY = new Float32Array(n);
  }
  if (table.count < 2) {
    const x = table.count > 0 ? table.xs[0] : 0;
    const y = table.count > 0 ? table.ys[0] : 0;
    resampleX.fill(x, 0, n);
    resampleY.fill(y, 0, n);
    return buildArcLength(resampleX, resampleY, n, out);
  }
  let j = 0;
  for (let k = 0; k < n; k++) {
    const s = (table.length * k) / (n - 1);
    while (j < table.count - 2 && table.distances[j + 1] < s) j++;
    const span = table.distances[j + 1] - table.distances[j];
    const t = span > 0 ? clamp((s - table.distances[j]) / span, 0, 1) : 0;
    resampleX[k] = table.xs[j] + (table.xs[j + 1] - table.xs[j]) * t;
    resampleY[k] = table.ys[j] + (table.ys[j + 1] - table.ys[j]) * t;
  }
  return buildArcLength(resampleX, resampleY, n, out);
}

/**
 * Position and tangent angle (radians, atan2 of the segment) at distance `s` along a table, clamped to [0, length].
 * Binary search; allocation-free.
 */
export function pointAtDistance(table: ArcLengthTable, s: number, out: { x: number; y: number; angle: number }): void {
  const count = table.count;
  if (count === 0) {
    out.x = 0;
    out.y = 0;
    out.angle = 0;
    return;
  }
  if (count === 1) {
    out.x = table.xs[0];
    out.y = table.ys[0];
    out.angle = 0;
    return;
  }
  const d = clamp(s, 0, table.length);
  let low = 0;
  let high = count - 2;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (table.distances[middle] <= d) low = middle;
    else high = middle - 1;
  }
  segmentPoint(table, low, d, out);
}

/** Interpolates on segment j (j, j + 1) at distance d, writing position and angle. */
function segmentPoint(table: ArcLengthTable, j: number, d: number, out: { x: number; y: number; angle: number }) {
  const span = table.distances[j + 1] - table.distances[j];
  const t = span > 0 ? clamp((d - table.distances[j]) / span, 0, 1) : 0;
  const dx = table.xs[j + 1] - table.xs[j];
  const dy = table.ys[j + 1] - table.ys[j];
  out.x = table.xs[j] + dx * t;
  out.y = table.ys[j] + dy * t;
  out.angle = Math.atan2(dy, dx);
}

const dotScratch = { x: 0, y: 0, angle: 0 };

/**
 * Visits positions every `spacing` px with from ≤ s ≤ to (clamped to the table), phase-locked to s = 0 (s = k·spacing),
 * so dotted strokes do not crawl while an arc grows or erases. For dashes, skip by index in `visit`:
 * `if (Math.round(s / spacing) % 4 >= 2) return` gives 2 dots on, 2 off. Allocation-free (apart from your closure).
 */
export function forEachDot(
  table: ArcLengthTable,
  spacing: number,
  from: number,
  to: number,
  visit: (x: number, y: number, s: number) => void,
): void {
  if (!(spacing > 0) || table.count === 0) return;
  const start = Math.max(0, from);
  const end = Math.min(table.length, to);
  if (end < start) return;
  if (table.count === 1) {
    if (start <= 0) visit(table.xs[0], table.ys[0], 0);
    return;
  }
  let j = 0;
  for (let k = Math.ceil(start / spacing - 1e-9); k * spacing <= end + 1e-9; k++) {
    const s = Math.min(k * spacing, table.length);
    while (j < table.count - 2 && table.distances[j + 1] < s) j++;
    segmentPoint(table, j, s, dotScratch);
    visit(dotScratch.x, dotScratch.y, k * spacing);
  }
}

const pathFrom: Vec3 = [0, 0, 0];
const pathTo: Vec3 = [0, 0, 0];
const pathPoint: Vec3 = [0, 0, 0];

/**
 * Curves between two places on a flat map as arc-length tables. `to` is unwrapped relative to `from` (the short way
 * round), then either a sampled great circle (`geodesic`) or a flatCurve with `bend` (default 0.15) between the
 * projected endpoints, `segments` (default 40) segments. When the curve leaves the map across the seam, a copy shifted
 * by ∓360° of longitude follows the main table, so both halves show inside a clipped canvas.
 */
export function flatPaths(
  projection: MapProjection,
  from: LatLon,
  to: LatLon,
  options: { bend?: number; segments?: number; geodesic?: boolean } = {},
): ArcLengthTable[] {
  const bend = options.bend ?? 0.15;
  const segments = Math.max(1, Math.round(options.segments ?? 40));
  const geodesic = options.geodesic ?? false;
  const lon0 = projection.centerLon;
  const center = windowCenterOf(projection);
  const lambdaFrom = windowLambda(projection, from.lon);
  const lambdaTo = unwrapLongitude(lambdaFrom, to.lon - lon0);
  const screen = createScreenPoint();
  const xs = new Float32Array(segments + 1);
  const ys = new Float32Array(segments + 1);
  let lats: Float64Array | null = null;
  let lambdas: Float64Array | null = null;
  let min = Math.min(lambdaFrom, lambdaTo);
  let max = Math.max(lambdaFrom, lambdaTo);
  if (geodesic) {
    lats = new Float64Array(segments + 1);
    lambdas = new Float64Array(segments + 1);
    latLonToVector(from.lat, from.lon, pathFrom);
    latLonToVector(to.lat, to.lon, pathTo);
    for (let i = 0; i <= segments; i++) {
      slerpVector(pathFrom, pathTo, i / segments, pathPoint);
      lats[i] = Math.asin(clamp(pathPoint[1], -1, 1)) / DEG;
      const lon = Math.atan2(pathPoint[0], pathPoint[2]) / DEG;
      lambdas[i] = i === 0 ? lambdaFrom : unwrapLongitude(lambdas[i - 1], lon - lon0);
      min = Math.min(min, lambdas[i]);
      max = Math.max(max, lambdas[i]);
    }
  }
  const curve: QuadCurve = { x0: 0, y0: 0, cx: 0, cy: 0, x1: 0, y1: 0 };
  const point = { x: 0, y: 0 };
  const build = (shift: number) => {
    if (lats && lambdas) {
      for (let i = 0; i <= segments; i++) {
        projection.projectRelative(lats[i], lambdas[i] + shift, screen);
        xs[i] = screen.x;
        ys[i] = screen.y;
      }
    } else {
      projection.projectRelative(from.lat, lambdaFrom + shift, screen);
      const x0 = screen.x;
      const y0 = screen.y;
      projection.projectRelative(to.lat, lambdaTo + shift, screen);
      flatCurve(x0, y0, screen.x, screen.y, bend, curve);
      for (let i = 0; i <= segments; i++) {
        quadPoint(curve, i / segments, point);
        xs[i] = point.x;
        ys[i] = point.y;
      }
    }
    return buildArcLength(xs, ys, segments + 1);
  };
  const tables = [build(0)];
  if (projection.kind !== "azimuthalEquidistant") {
    if (max > center + 180) tables.push(build(-360));
    if (min < center - 180) tables.push(build(360));
  }
  return tables;
}

/* hit testing, keyboard and labels */

/**
 * Index of the point nearest to (x, y) among the first `count` (linear search for small sets: markers, spikes, recent
 * events), or −1 when none is within `maxDistance`.
 */
export function nearestIndex(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  count: number,
  x: number,
  y: number,
  maxDistance: number,
): number {
  let best = -1;
  let bestDistance = maxDistance * maxDistance;
  for (let i = 0; i < count; i++) {
    const dx = xs[i] - x;
    const dy = ys[i] - y;
    const d = dx * dx + dy * dy;
    if (d <= bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** Arrow-key direction (screen space: up is toward smaller y). */
export type NavigationDirection = "left" | "right" | "up" | "down";

/** The direction of each arrow key, by `KeyboardEvent.key`, for spatialNavigate and panning. Other keys give undefined. */
export const ARROW_DIRECTIONS: Readonly<Partial<Record<string, NavigationDirection>>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
};

/**
 * Next point for an arrow key: the candidates within a ±45° cone in that direction, minimising distance + 2 ×
 * perpendicular offset. Returns `from` when there is none, so focus stays put at the edge.
 */
export function spatialNavigate(
  points: readonly { x: number; y: number }[],
  from: number,
  direction: NavigationDirection,
): number {
  const origin = points[from];
  if (!origin) return from;
  let best = from;
  let bestScore = Infinity;
  for (let i = 0; i < points.length; i++) {
    if (i === from) continue;
    const dx = points[i].x - origin.x;
    const dy = points[i].y - origin.y;
    const along = direction === "right" ? dx : direction === "left" ? -dx : direction === "down" ? dy : -dy;
    const across = direction === "right" || direction === "left" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 0 || across > along) continue;
    const score = Math.hypot(dx, dy) + 2 * across;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/**
 * A label to place: the anchor point (marker centre) in px, the label box size, a priority (higher places first) and
 * the gap between anchor and box (default 6 px).
 */
export interface LabelAnchor {
  x: number;
  y: number;
  width: number;
  height: number;
  priority: number;
  gap?: number;
}

/** Where a label went: its box's top-left corner and the side of the anchor, or visible false when it did not fit. */
export interface LabelPlacement {
  visible: boolean;
  x: number;
  y: number;
  side: "right" | "left" | "top" | "bottom";
}

const LABEL_SIDES = ["right", "left", "top", "bottom"] as const;

/**
 * Greedy label placement by priority: each label tries right, left, top, bottom of its anchor and takes the first box
 * inside the bounds that overlaps no placed box (first avoiding other anchors' points, then allowing them). Labels
 * that fit nowhere get visible: false. Output in input order. O(n²); fine for up to a few hundred labels.
 */
export function placeLabels(anchors: readonly LabelAnchor[], width: number, height: number): LabelPlacement[] {
  const placements: LabelPlacement[] = anchors.map((anchor) => ({
    visible: false,
    x: anchor.x,
    y: anchor.y,
    side: "right",
  }));
  const order = anchors.map((_, index) => index).sort((a, b) => anchors[b].priority - anchors[a].priority || a - b);
  const boxes: number[] = [];
  const POINT = 4;
  const fits = (index: number, x: number, y: number, w: number, h: number, avoidPoints: boolean) => {
    if (x < 0 || y < 0 || x + w > width || y + h > height) return false;
    for (let k = 0; k < boxes.length; k += 4) {
      const apartX = x >= boxes[k] + boxes[k + 2] || x + w <= boxes[k];
      const apartY = y >= boxes[k + 1] + boxes[k + 3] || y + h <= boxes[k + 1];
      if (!apartX && !apartY) return false;
    }
    if (avoidPoints) {
      for (let j = 0; j < anchors.length; j++) {
        if (j === index) continue;
        const p = anchors[j];
        if (p.x > x - POINT && p.x < x + w + POINT && p.y > y - POINT && p.y < y + h + POINT) return false;
      }
    }
    return true;
  };
  for (const index of order) {
    const anchor = anchors[index];
    const gap = anchor.gap ?? 6;
    const w = anchor.width;
    const h = anchor.height;
    placing: for (const avoidPoints of [true, false]) {
      for (const side of LABEL_SIDES) {
        const x = side === "right" ? anchor.x + gap : side === "left" ? anchor.x - gap - w : anchor.x - w / 2;
        const y = side === "top" ? anchor.y - gap - h : side === "bottom" ? anchor.y + gap : anchor.y - h / 2;
        if (!fits(index, x, y, w, h, avoidPoints)) continue;
        placements[index] = { visible: true, x, y, side };
        boxes.push(x, y, w, h);
        break placing;
      }
    }
  }
  return placements;
}

/**
 * Brightness 0..1 of a lattice dot for an expanding ring at `radius` (same units as `distance`):
 * exp(−((distance − radius − jitter·unevenness) / width)²), unevenness default 5. Pass the dot's jitter so the front
 * is uneven, the way growth travels in every Location component. Allocation-free.
 */
export function ringFront(distance: number, radius: number, width: number, jitter: number, unevenness = 5): number {
  const d = (distance - radius - jitter * unevenness) / width;
  return Math.exp(-d * d);
}

/* bounds */

/** Union of lon/lat boxes, choosing the smaller longitude span around the globe. No boxes give the whole world. */
export function unionBounds(boxes: readonly GeoBounds[]): GeoBounds {
  if (boxes.length === 0) return { west: -180, south: -90, east: 180, north: 90 };
  const lons: number[] = [];
  let south = Infinity;
  let north = -Infinity;
  for (const box of boxes) {
    const span = box.east >= box.west ? box.east - box.west : box.east + 360 - box.west;
    if (span >= 360) {
      const southmost = Math.min(...boxes.map((b) => b.south));
      const northmost = Math.max(...boxes.map((b) => b.north));
      return { west: -180, south: southmost, east: 180, north: northmost };
    }
    // sample each span finely, so the widest empty gap can never fall inside a box
    const steps = Math.max(1, Math.ceil(span / 5));
    for (let i = 0; i <= steps; i++) lons.push(box.west + (span * i) / steps);
    south = Math.min(south, box.south);
    north = Math.max(north, box.north);
  }
  const [west, east] = narrowestLonSpan(lons);
  return { west, south, east, north };
}

/** Whether a point lies in a box; longitudes compare around the globe, so boxes with east > 180 work. */
export function boundsContains(bounds: GeoBounds, lat: number, lon: number): boolean {
  if (lat < bounds.south || lat > bounds.north) return false;
  if (bounds.east - bounds.west >= 360) return true;
  const offset = (((lon - bounds.west) % 360) + 360) % 360;
  return offset <= bounds.east - bounds.west;
}

/**
 * Widens a box (never shrinks it) about its centre until the cropped projection has the given width / height, so a
 * fitted map fills its card: more longitude when the box is too tall, more latitude when it is too wide (sliding
 * away from the poles). Pass the result as `lonRange` [west, east] and `latRange` [south, north].
 */
export function fitBoundsToAspect(
  bounds: GeoBounds,
  aspect: number,
  kind: ProjectionKind = "equirectangular",
): GeoBounds {
  if (kind === "azimuthalEquidistant" || !(aspect > 0)) return bounds;
  const latLimit = kind === "mercator" ? MERCATOR_LIMIT : 90;
  const west = bounds.west;
  const east = bounds.east >= west ? bounds.east : bounds.east + 360;
  const south = clamp(Math.min(bounds.south, bounds.north), -latLimit, latLimit);
  const north = clamp(Math.max(bounds.south, bounds.north), -latLimit, latLimit);
  const aspectOf = (s: number, n: number, w: number, e: number) => projectionAspect(kind, [s, n], [w, e]);
  const current = aspectOf(south, north, west, east);
  if (current < aspect) {
    // x grows linearly with the longitude span in every flat projection here (the range stays centred)
    const span = Math.min(360, ((east - west) * aspect) / current);
    const middle = (west + east) / 2;
    const shift = wrapLongitude(middle - span / 2) - (middle - span / 2);
    return { west: middle - span / 2 + shift, south, east: middle + span / 2 + shift, north };
  }
  if (current > aspect) {
    const middle = (south + north) / 2;
    const latSpan = (span: number) => {
      let s = middle - span / 2;
      let n = middle + span / 2;
      if (n > latLimit) {
        s -= n - latLimit;
        n = latLimit;
      }
      if (s < -latLimit) {
        n = Math.min(latLimit, n + (-latLimit - s));
        s = -latLimit;
      }
      return [s, n] as const;
    };
    let low = north - south;
    let high = 2 * latLimit;
    const [fullSouth, fullNorth] = latSpan(high);
    if (aspectOf(fullSouth, fullNorth, west, east) >= aspect) return { west, south: fullSouth, east, north: fullNorth };
    for (let i = 0; i < 40; i++) {
      const span = (low + high) / 2;
      const [s, n] = latSpan(span);
      if (aspectOf(s, n, west, east) > aspect) low = span;
      else high = span;
    }
    const [s, n] = latSpan(high);
    return { west, south: s, east, north: n };
  }
  return { west, south, east, north };
}

/* sun */

/** The J2000.0 epoch (2000-01-01 12:00 UTC) in epoch milliseconds. */
const J2000_MS = 946_728_000_000;

/**
 * Low-precision subsolar point (about 0.5°, enough for a terminator): lat = solar declination, lon = right ascension
 * minus Greenwich sidereal time, wrapped. Pass a time in ms or a Date; never call it with Date.now() during render.
 */
export function subsolarPoint(date: Date | number): LatLon {
  const ms = typeof date === "number" ? date : date.getTime();
  // days since the J2000.0 epoch, 2000-01-01 12:00 UTC
  const n = (ms - J2000_MS) / 86_400_000;
  const meanLongitude = 280.46 + 0.9856474 * n;
  const anomaly = (357.528 + 0.9856003 * n) * DEG;
  const eclipticLongitude = (meanLongitude + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * DEG;
  const obliquity = (23.439 - 0.0000004 * n) * DEG;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude));
  const siderealTime = 280.46061837 + 360.98564736629 * n;
  return { lat: declination / DEG, lon: wrapLongitude(rightAscension / DEG - siderealTime) };
}

/**
 * Sun elevation in degrees at a point for a subsolar point: 90 − the central angle in degrees. Compare with TWILIGHT.
 */
export function solarElevation(point: LatLon, subsolar: LatLon): number {
  return 90 - centralAngle(point, subsolar) / DEG;
}

/* theme ink */

/** Theme tokens for usePalette in Location components: the same variables and fallbacks as THEME_TOKENS. */
export const GEO_TOKENS: {
  readonly foreground: ColorToken;
  readonly muted: ColorToken;
  readonly card: ColorToken;
  readonly border: ColorToken;
  readonly accent: ColorToken;
  readonly accentSoft: ColorToken;
  readonly glint: ColorToken;
  readonly shine: ColorToken;
  readonly success: ColorToken;
  readonly warning: ColorToken;
  readonly info: ColorToken;
  readonly destructive: ColorToken;
} = {
  foreground: THEME_TOKENS.foreground,
  muted: THEME_TOKENS.muted,
  card: THEME_TOKENS.card,
  border: THEME_TOKENS.border,
  accent: THEME_TOKENS.accent,
  accentSoft: THEME_TOKENS.accentSoft,
  glint: THEME_TOKENS.glint,
  shine: THEME_TOKENS.shine,
  success: THEME_TOKENS.success,
  warning: THEME_TOKENS.warning,
  info: THEME_TOKENS.info,
  destructive: THEME_TOKENS.destructive,
};

/** A palette resolved from GEO_TOKENS by usePalette(rootRef, GEO_TOKENS, kick). */
export type GeoPalette = Palette<keyof typeof GEO_TOKENS>;

/** Drawing colours derived from a GeoPalette; components never hard-code colours. */
export interface GeoInk {
  /** The quiet base lattice: muted-foreground mixed 30 % toward the card. */
  land: RGB;
  /** Emphasised land (globes, paths): foreground mixed 45 % toward the card. */
  landStrong: RGB;
  /** Coastline strokes: the foreground (draw at low alpha). */
  coast: RGB;
  accent: RGB;
  soft: RGB;
  glint: RGB;
  shine: RGB;
  /**
   * The hottest shade (flashes, crests, packet heads): the glint in dark themes, the deep shine in light ones, where a
   * pale glint would vanish into the card.
   */
  hot: RGB;
  info: RGB;
  success: RGB;
  warning: RGB;
  destructive: RGB;
  card: RGB;
  border: RGB;
  foreground: RGB;
  muted: RGB;
  dark: boolean;
}

/**
 * Derived drawing colours: land = mix(muted, card, 0.3) (like the effort-slider lattice grey), landStrong =
 * mix(foreground, card, 0.45), coast = foreground, hot = glint (dark) or shine (light); the rest straight from the
 * palette. Recompute on theme change (usePalette's callback) and rebake static layers.
 */
export function geoInk(palette: GeoPalette): GeoInk {
  return {
    land: mixRgb(palette.muted, palette.card, 0.3),
    landStrong: mixRgb(palette.foreground, palette.card, 0.45),
    coast: palette.foreground,
    accent: palette.accent,
    soft: palette.accentSoft,
    glint: palette.glint,
    shine: palette.shine,
    hot: palette.dark ? palette.glint : palette.shine,
    info: palette.info,
    success: palette.success,
    warning: palette.warning,
    destructive: palette.destructive,
    card: palette.card,
    border: palette.border,
    foreground: palette.foreground,
    muted: palette.muted,
    dark: palette.dark,
  };
}

/** The status colours a Location marker, arc or region can take. */
export type GeoTone = "accent" | "info" | "success" | "warning" | "destructive" | "muted";

/** The ink of a tone. Anything that is not a tone (a typo in untyped code) draws in the accent. */
export function toneColor(ink: GeoInk, tone: GeoTone): RGB {
  switch (tone) {
    case "info":
      return ink.info;
    case "success":
      return ink.success;
    case "warning":
      return ink.warning;
    case "destructive":
      return ink.destructive;
    case "muted":
      return ink.muted;
    default:
      return ink.accent;
  }
}
