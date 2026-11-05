import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Route } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { journeysApi } from '../api/journeys';
import { journeyHops } from '../lib/journeyHops';
import { Badge, Button, Card, EmptyState, LoadingSpinner } from './ui';
import { GeoTraceroute } from './ui/geo-traceroute';

export function JourneysSection({ assetType, assetId }: { assetType?: 'link' | 'file'; assetId?: string }) {
  const query = useQuery({
    queryKey: ['journeys', assetType ?? 'top', assetId],
    queryFn: () => journeysApi.list(assetType, assetId),
    enabled: !assetType || !!assetId,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const journeys = useMemo(() => [...(query.data?.journeys ?? [])]
    .sort((a, b) => Number(b.cities >= 2) - Number(a.cities >= 2))
    .slice(0, assetType ? 20 : 5), [query.data, assetType]);
  const journey = journeys.find((item) => item.visitor_id === selected) ?? journeys[0];
  const hops = useMemo(() => journeyHops(journey?.touches ?? []), [journey]);
  const name = journey ? journey.company_name || `Visitor ${journey.visitor_id.slice(0, 4)}` : '';
  const duration = hops.at(-1)?.display ?? '+0m';
  const content = query.isPending ? <div role="status" aria-label="Loading visitor journeys"><LoadingSpinner /></div>
    : query.isError ? <EmptyState icon={Route} title="Journeys could not load" description="Check your connection and try again.">
      <Button variant="outline" className="min-h-11" onClick={() => { void query.refetch(); }}>Try again</Button>
    </EmptyState>
    : journeys.length === 0 ? <EmptyState icon={Route} title="No journeys yet" description="No visitor has opened more than one item yet" />
    : <>
      <Card padding="none" className="cb-journey-list overflow-hidden">
        {journeys.map((item) => <button key={item.visitor_id} type="button" className="cb-journey-choice" aria-pressed={item.visitor_id === journey?.visitor_id} onClick={() => setSelected(item.visitor_id)}>
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-mono font-medium break-all">{item.company_name || `Visitor ${item.visitor_id.slice(0, 4)}`}</span>
            {item.cities >= 2 && <Badge variant="info" className="cb-forwarded">Forwarded</Badge>}
          </span>
          <span className="mt-2 block text-sm text-[var(--cb-text-mid)] break-words">{[...new Set(item.touches.map((touch) => touch.city).filter(Boolean))].join(' → ') || 'No location'}</span>
          <span className="mt-1 block font-mono text-xs text-[var(--cb-muted)]">{item.touches.length} {item.touches.length === 1 ? 'touch' : 'touches'} · {item.cities} {item.cities === 1 ? 'city' : 'cities'} · Last seen {formatDistanceToNow(new Date(item.last_at), { addSuffix: true })}</span>
        </button>)}
      </Card>
      <GeoTraceroute key={journey?.visitor_id} hops={hops} title="Visitor journey" target={name} metricLabel="Elapsed" formatMetric={() => duration} showProbes={false} jumpMs={Number.MAX_VALUE} speed={Math.max(1, hops.length / 5)} />
    </>;
  const title = assetType ? 'Journeys' : 'Forwarded journeys';
  return <section className="cb-journeys" aria-label={title}>
    {!assetType && query.isSuccess && !journeys.length ? <details><summary className="min-h-11 cursor-pointer font-mono font-semibold">{title}</summary>{content}</details>
      : <><h2 className="text-lg font-semibold mb-2">{title}</h2><p className="text-sm text-[var(--cb-muted)] mb-4">Last {assetType ? 90 : 30} days, across accessible items. Locations can suggest forwarding, not prove it.</p>{content}</>}
  </section>;
}
