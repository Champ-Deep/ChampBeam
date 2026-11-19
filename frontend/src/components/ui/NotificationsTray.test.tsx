import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { NotificationsTray } from './NotificationsTray';
import type { RecentClick } from '../../api/utm';

const item: RecentClick = { id: 'sample-1', type: 'file', filename: 'Synthetic brief.pdf', clicked_at: null, country: 'India', region: 'Karnataka', device_type: 'Desktop', browser: 'Firefox', original_url: null, short_code: null, utm_campaign: null, utm_source: null };

it('portals the tray into document.body, outside the clipping sidebar', async () => {
  const clearAll = vi.fn().mockResolvedValue(undefined);
  const { container, rerender } = render(<aside style={{ overflowY: 'auto' }}><NotificationsTray recentClicks={[item]} clearAll={clearAll} /></aside>);
  fireEvent.click(screen.getByRole('button', { name: 'Recent opens, 1 unread' }));
  const tray = await screen.findByRole('dialog', { name: 'Recent opens' });
  expect(document.body).toContainElement(tray);
  expect(container).not.toContainElement(tray);
  expect(screen.getByRole('region', { name: 'New' })).toBeVisible();
  expect(screen.getByText('India, Karnataka')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  await waitFor(() => expect(clearAll).toHaveBeenCalledOnce());
  rerender(<aside><NotificationsTray recentClicks={[]} clearAll={clearAll} /></aside>);
  expect(screen.getByText("You're all caught up")).toBeVisible();
});

it('marks a row read, keeps it in place, then groups it as Earlier on reopen', async () => {
  render(<NotificationsTray recentClicks={[item]} clearAll={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Recent opens/ }));
  fireEvent.click(await screen.findByRole('button', { name: /Synthetic brief/ }));
  expect(screen.getByRole('region', { name: 'New' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Close recent opens' }));
  fireEvent.click(screen.getByRole('button', { name: 'Recent opens' }));
  expect(await screen.findByRole('region', { name: 'Earlier' })).toBeVisible();
});

it('keeps opens visible and reports a clear failure without swallowing recovery', async () => {
  const clearAll = vi.fn().mockRejectedValue(new Error('offline'));
  render(<NotificationsTray recentClicks={[item]} clearAll={clearAll} />);
  fireEvent.click(screen.getByRole('button', { name: /Recent opens/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Clear all' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be cleared');
  expect(screen.getByText('Synthetic brief.pdf')).toBeVisible();
  clearAll.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
