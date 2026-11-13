import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AssetAnalytics } from './AssetAnalytics';
import { api } from '../api/client';
vi.mock('../api/client', () => ({ api: { get: vi.fn() } }));
vi.mock('recharts', () => ({ ResponsiveContainer: () => null, AreaChart: () => null, Area: () => null, CartesianGrid: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null }));
const empty = { summary: {opens:0,unique_visitors:0,returning_opens:0,file_opens:0,page_opens:0,asset_count:0},assets:[],daily:[],hours:[],countries:[],devices:[],companies:[],referrers:[],meta:{timezone:'UTC',asset_limit:50,visitor_basis:'Estimated browsers, not people.',filtering:'Known bots excluded.'} };
function mount() { render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><AssetAnalytics /></MemoryRouter></QueryClientProvider>); }
afterEach(() => { cleanup(); vi.clearAllMocks(); });
it('does not print zero totals or an empty conclusion during a pending request', () => {
  vi.mocked(api.get).mockReturnValue(new Promise(()=>{})); mount();
  expect(screen.getByRole('status')).toHaveTextContent('Loading content');
  expect(screen.queryByText('No opens in this date range')).toBeNull();
  expect(screen.queryByText('Estimated visitors')).toBeNull();
});
it('retries failed data and clears the error after a real empty response', async () => {
  vi.mocked(api.get).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({data:empty}); mount();
  fireEvent.click(await screen.findByRole('button',{name:'Retry analytics'}));
  await screen.findByText('No opens in this date range');
  expect(screen.queryByRole('alert')).toBeNull();
});
it('drills into the right content type and sends the selected date range', async () => {
  vi.mocked(api.get).mockResolvedValue({data:{...empty,assets:[{id:'sample',filename:'Sample guide',asset_type:'page',opens:0,unique_visitors:0,returning_opens:0,last_opened_at:null}]}}); mount();
  expect(await screen.findByRole('link',{name:/Sample guide/})).toHaveAttribute('href','/pages/sample/analytics');
  fireEvent.click(screen.getByRole('button',{name:'7D'}));
  await screen.findByRole('link',{name:/Sample guide/});
  expect(api.get).toHaveBeenLastCalledWith('/analytics/assets',{params:{scope:'own',days:7,start_date:undefined,end_date:undefined}});
});
