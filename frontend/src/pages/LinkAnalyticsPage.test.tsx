import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClickEvent, LinkPerformanceItem } from '../api/utm';
import { utmApi } from '../api/utm';
import { LinkAnalyticsPage } from './LinkAnalyticsPage';

vi.mock('../components/ui/GeoChart', () => ({ GeoChart: () => <div>geo</div> }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
}));
vi.mock('../api/utm', () => ({
  utmApi: {
    getLinkPerformance: vi.fn(),
    getLinkClickEvents: vi.fn(),
    getLinkGeoBreakdown: vi.fn(),
    getLinkDeviceBreakdown: vi.fn(),
    exportClickEvents: vi.fn(),
  },
}));

const link: LinkPerformanceItem = {
  link_id: 'link-1',
  original_url: 'https://example.com/offer',
  tracked_url: 'https://example.com/offer?utm_source=x',
  redirect_url: 'https://champbeam.test/r/abc',
  short_code: 'abc',
  anchor_text: null,
  utm_source: null,
  utm_medium: null,
  utm_campaign: null,
  utm_content: null,
  utm_term: null,
  project_name: null,
  project_id: null,
  click_count: 2,
  unique_clicks: 2,
  first_clicked_at: '2026-11-01T00:00:00.000Z',
  created_at: '2026-11-01T00:00:00.000Z',
};

function event(over: Partial<ClickEvent>): ClickEvent {
  return {
    id: 'e1',
    ip_address: null,
    device_type: 'desktop',
    browser: 'Chrome',
    os: 'macOS',
    country: 'India',
    country_code: 'IN',
    region: 'KA',
    city: 'Bengaluru',
    referrer: null,
    is_vpn: false,
    asn_org: 'Example ISP',
    company_name: null,
    company_domain: null,
    company_type: null,
    clicked_at: '2026-11-12T12:00:00.000Z',
    ...over,
  };
}

afterEach(cleanup);

describe('link click events', () => {
  it('shows each visitor IP and the company stored for that IP', async () => {
    vi.mocked(utmApi.getLinkPerformance).mockResolvedValue([link]);
    vi.mocked(utmApi.getLinkGeoBreakdown).mockResolvedValue([]);
    vi.mocked(utmApi.getLinkDeviceBreakdown).mockResolvedValue({ devices: [], browsers: [] });
    vi.mocked(utmApi.getLinkClickEvents).mockResolvedValue([
      event({ id: 'a', ip_address: '203.0.113.10', company_name: 'Initech', company_domain: 'initech.example' }),
      event({ id: 'b', ip_address: '203.0.113.11', company_name: null, city: 'Mumbai', region: 'MH' }),
    ]);

    render(
      <MemoryRouter initialEntries={['/analytics/links/link-1']}>
        <Routes>
          <Route path="/analytics/links/:linkId" element={<LinkAnalyticsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText('203.0.113.10')).toBeInTheDocument();
    expect(screen.getByText('203.0.113.11')).toBeInTheDocument();
    expect(screen.getByText('Initech')).toHaveAttribute('title', 'initech.example');
    expect(screen.getAllByRole('columnheader', { name: 'IP' })).toHaveLength(1);
    expect(screen.getByRole('columnheader', { name: 'Company' })).toBeInTheDocument();
  });
});
