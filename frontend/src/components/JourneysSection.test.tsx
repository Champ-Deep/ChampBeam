import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { JourneysSection } from './JourneysSection';
import { journeysApi, type VisitorJourney } from '../api/journeys';

vi.mock('../api/journeys', () => ({ journeysApi: { list: vi.fn() } }));
vi.mock('./ui/geo-traceroute', () => ({ GeoTraceroute: ({ target, showProbes, title }: { target: string; showProbes: boolean; title: string }) => <div data-testid="map">{target} {title} {String(showProbes)}</div> }));
const journey = (id: string, cities: number): VisitorJourney => ({
  visitor_id: id, company_name: null, cities, forwarded: cities >= 2,
  first_at: '2026-11-01T10:00:00Z', last_at: '2026-11-01T11:00:00Z',
  touches: [{ at: '2026-11-01T10:00:00Z', asset: { id: 'file', type: 'file', title: 'Deck.pdf', url: '/f/test' }, city: 'Bangalore', country_code: 'IN', lat: 12.97, lon: 77.59, device_type: 'desktop', count: 1 }],
});
function mount(props = {}) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><JourneysSection {...props} /></QueryClientProvider>);
}
const response = (journeys: VisitorJourney[]) => ({ journeys, meta: { days: 90, unattributed: 0 } });
describe('JourneysSection', () => {
  it('loads an asset, prioritizes forwarded visitors and selects another journey', async () => {
    vi.mocked(journeysApi.list).mockResolvedValue(response([journey('cd34', 1), journey('ab12', 2)]));
    mount({ assetType: 'file', assetId: 'file' });
    await screen.findByText('Forwarded');
    expect(journeysApi.list).toHaveBeenCalledWith('file', 'file');
    expect(screen.getByTestId('map')).toHaveTextContent('Visitor ab12 Visitor journey false');
    fireEvent.click(screen.getByRole('button', { name: /Visitor cd34/ }));
    expect(screen.getByTestId('map')).toHaveTextContent('Visitor cd34');
  });
  it('collapses the empty top section and exposes the specified empty state', async () => {
    vi.mocked(journeysApi.list).mockResolvedValue(response([]));
    mount();
    await screen.findByText('No journeys yet');
    const title = screen.getByText('Forwarded journeys');
    expect(title.closest('details')).not.toHaveAttribute('open');
    fireEvent.click(title);
    expect(screen.getByText('No visitor has opened more than one item yet')).toBeInTheDocument();
  });
  it('shows loading, request failure, then recovers via retry', async () => {
    let reject: (error: Error) => void = () => {};
    vi.mocked(journeysApi.list).mockReturnValueOnce(new Promise((_resolve, rejectPromise) => { reject = rejectPromise; }));
    mount();
    expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Loading visitor journeys');
    reject(new Error('Offline'));
    await screen.findByText('Journeys could not load');
    vi.mocked(journeysApi.list).mockResolvedValue(response([journey('ab12', 2)]));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('Forwarded');
    expect(screen.queryByText('Journeys could not load')).not.toBeInTheDocument();
  });
  it('limits the overview to five visitors with forwarded journeys first', async () => {
    vi.mocked(journeysApi.list).mockResolvedValue(response(Array.from({ length: 7 }, (_, index) => journey(`v${index}xx`, index === 6 ? 2 : 1))));
    mount();
    await screen.findByText('Forwarded');
    expect(screen.getAllByRole('button')).toHaveLength(5);
    expect(screen.getByTestId('map')).toHaveTextContent('Visitor v6xx');
  });
  it('does not render the old asset journey after its query key changes', async () => {
    vi.mocked(journeysApi.list).mockResolvedValue(response([journey('ab12', 2)]));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(<QueryClientProvider client={client}><JourneysSection assetType="link" assetId="first" /></QueryClientProvider>);
    await screen.findByTestId('map');
    vi.mocked(journeysApi.list).mockReturnValue(new Promise(() => {}));
    view.rerender(<QueryClientProvider client={client}><JourneysSection assetType="link" assetId="second" /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByTestId('map')).not.toBeInTheDocument());
  });
});
