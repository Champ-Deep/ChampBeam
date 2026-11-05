import type { JourneyTouch } from '../api/journeys';
import type { TraceHop } from '../components/ui/geo-traceroute';

export function formatElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return '+0m';
  if (minutes < 60) return `+${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `+${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`;
  return `+${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ''}`;
}

export function journeyHops(touches: readonly JourneyTouch[]): TraceHop[] {
  const first = Date.parse(touches[0]?.at ?? '');
  let elapsed = 0;
  let previousPoint = '';
  return touches.map((touch) => {
    const delta = Date.parse(touch.at) - first;
    elapsed = Math.max(elapsed, Number.isFinite(delta) ? delta : 0);
    const located = touch.lat !== null && touch.lon !== null && Number.isFinite(touch.lat) && Number.isFinite(touch.lon)
      && Math.abs(touch.lat) <= 90 && Math.abs(touch.lon) <= 180;
    const point = located ? `${touch.lat},${touch.lon}` : '';
    // Stationary repeat touches stay in the ledger without drawing a zero-length map leg.
    const draw = located && point !== previousPoint;
    if (located) previousPoint = point;
    return {
      address: touch.asset.title,
      name: `${touch.asset.type} · ${touch.device_type ?? 'Unknown device'}`,
      location: [touch.city, touch.country_code].filter(Boolean).join(', ') || 'No location',
      lat: draw ? (touch.lat as number) : undefined,
      lon: draw ? (touch.lon as number) : undefined,
      rtt: [1 + 40 * Math.log10(1 + elapsed / 60_000)],
      display: formatElapsed(elapsed),
    };
  });
}
