import React from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api/client';
import { LinkAnalyticsPage } from '../src/pages/LinkAnalyticsPage';
import { FileAnalyticsPage } from '../src/pages/FileAnalyticsPage';
import { PageAnalyticsPage } from '../src/pages/PageAnalyticsPage';
import { AnalyticsPage } from '../src/pages/AnalyticsPage';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../src/components/ui/dropdown-menu';
import '../src/index.css';

// Local verification entry only. Vite's production build has no entry or link to this fixture.
const params = new URLSearchParams(location.search);
const theme = params.get('theme') ?? 'paper';
const scenario = params.get('scenario') ?? 'two';
const surface = params.get('surface') ?? 'link';
document.documentElement.dataset.cbTheme = theme;
if (params.has('region')) {
  const style = document.createElement('style');
  style.textContent = '#root > main > div > :not(.cb-journeys){display:none!important} .cb-journeys{margin-top:0!important}';
  document.head.append(style);
}
const first = '2026-11-01T10:00:00Z';
const last = scenario === 'long' ? '2026-11-22T10:00:00Z' : '2026-11-03T14:00:00Z';
const asset = { id: 'fixture', type: 'file', title: 'APAC partner deck.pdf', url: '/f/fixture' };
const journey = {
  visitor_id: 'ab12-fixture', company_name: null, first_at: first, last_at: last,
  cities: scenario === 'one' ? 1 : 2, forwarded: scenario !== 'one',
  touches: [
    { at: first, asset: { ...asset, type: 'link', title: 'Partner briefing' }, city: 'Bangalore', country_code: 'IN', lat: 12.9716, lon: 77.5946, device_type: 'desktop', count: 1 },
    { at: last, asset, city: scenario === 'one' ? 'Bangalore' : 'Singapore', country_code: scenario === 'one' ? 'IN' : 'SG', lat: scenario === 'one' ? 12.9716 : 1.3521, lon: scenario === 'one' ? 77.5946 : 103.8198, device_type: 'mobile', count: 1 },
    { at: new Date(Date.parse(last) + 300_000).toISOString(), asset: { ...asset, title: 'Pricing.html' }, city: null, country_code: null, lat: null, lon: null, device_type: 'desktop', count: 1 },
  ],
};
const secondary = { ...journey, visitor_id: 'cd34-fixture', company_name: 'Fixture studio', cities: 1, forwarded: false, touches: [journey.touches[0]] };
const summary = { file_id:'fixture', filename:asset.title, short_code:'fixture', download_count:3, unique_visitors:1, view_count:3, total_downloads:3, total_views:3, size_bytes:1234, created_at:first };
const beamPage = { page_id:'fixture', title:'Partner briefing', slug:'fixture', url:'/p/fixture', current_version:1, view_count:3, unique_visitors:1, revisits:0, created_at:first, enabled:true };
let failOnce = scenario === 'error';
const requests: string[] = [];
(window as unknown as { fixtureRequests: string[] }).fixtureRequests = requests;
api.defaults.adapter = async (config) => {
  const url = config.url ?? '';
  requests.push(url + JSON.stringify(config.params ?? {}));
  let data: unknown = [];
  if (url.includes('/analytics/journeys')) {
    if (scenario === 'loading') await new Promise(resolve => setTimeout(resolve, 30_000));
    if (failOnce) { failOnce = false; throw new Error('Fixture request failure'); }
    data = { journeys: scenario === 'empty' ? [] : [secondary, journey], meta: { days: surface === 'top' ? 30 : 90, unattributed: 0 } };
  } else if (url.includes('/utm/analytics/links')) data = [{ link_id:'fixture', original_url:'/partner-briefing', tracked_url:'/r/fixture', redirect_url:'/r/fixture', click_count:3, unique_clicks:1 }];
  else if (url.includes('/summary')) data = summary;
  else if (url.includes('/pages/fixture/analytics')) data = { ...beamPage, views:3, sessions:1, total_dwell_ms:60000, median_dwell_ms:60000, avg_dwell_ms:60000, last_viewed_at:last };
  else if (url === '/pages/fixture') data = beamPage;
  else if (url.includes('/devices')) data = { devices:[], browsers:[] };
  else if (url.includes('/overview')) data = { total_tracked_links:1, total_clicks:3, unique_clicks:1, overall_click_rate:100, total_projects:0, total_campaigns:0, recent_clicks:0 };
  else if (url.includes('/performance')) data = { data:[], period:'day' };
  return { data, status:200, statusText:'OK', headers:{}, config };
};
const routes = { link:'/links/fixture', file:'/files/fixture', page:'/pages/fixture', top:'/analytics' };
createRoot(document.getElementById('root')!).render(<QueryClientProvider client={new QueryClient({ defaultOptions:{ queries:{retry:false} } })}>
  <MemoryRouter initialEntries={[routes[surface as keyof typeof routes]]}>
    <main><Routes>
      <Route path="/links/:linkId" element={<LinkAnalyticsPage />} />
      <Route path="/files/:fileId" element={<FileAnalyticsPage />} />
      <Route path="/pages/:pageId" element={<PageAnalyticsPage />} />
      <Route path="/analytics" element={<AnalyticsPage />} />
    </Routes></main>
  </MemoryRouter>
  <aside style={{ padding:16 }}><DropdownMenu><DropdownMenuTrigger style={{ minHeight:44, padding:12, border:'1px solid var(--cb-border)' }}>Fixture actions</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>View analytics</DropdownMenuItem><DropdownMenuItem>Copy address</DropdownMenuItem></DropdownMenuContent></DropdownMenu></aside>
</QueryClientProvider>);
