import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { toast } from 'sonner';
import { utmApi, type RecentClick } from '../api/utm';
import { useClickNotifications } from './useClickNotifications';

const item = (id: string): RecentClick => ({
  id, type: 'file', filename: 'Brief.pdf', original_url: null,
  clicked_at: new Date().toISOString(), country: null, region: null,
  device_type: null, browser: null, short_code: null, utm_campaign: null, utm_source: null,
});

afterEach(() => vi.restoreAllMocks());

describe('recent opens', () => {
  it('hydrates from the server without replaying old toasts and clears across remounts', async () => {
    let rows = [item('old')];
    vi.spyOn(utmApi, 'getRecentClicks').mockImplementation(async () => rows);
    vi.spyOn(utmApi, 'clearRecentClicks').mockImplementation(async () => { rows = []; });
    const toastSpy = vi.spyOn(toast, 'info').mockImplementation(() => 'toast-id');
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    const first = renderHook(() => useClickNotifications(true, 'user_1'), { wrapper });
    await waitFor(() => expect(first.result.current.recentClicks).toHaveLength(1));
    expect(toastSpy).not.toHaveBeenCalled();
    first.unmount();
    const second = renderHook(() => useClickNotifications(true, 'user_1'), { wrapper });
    expect(second.result.current.recentClicks).toHaveLength(1);
    expect(toastSpy).not.toHaveBeenCalled();
    const mobile = renderHook(() => useClickNotifications(true, 'user_1'), { wrapper });
    rows = [item('new'), item('old')];
    await act(async () => { await client.invalidateQueries({ queryKey: ['recent-clicks', 'user_1'] }); });
    await waitFor(() => expect(second.result.current.recentClicks).toHaveLength(2));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    await act(async () => { await second.result.current.clearAll(); });
    await waitFor(() => expect(second.result.current.recentClicks).toHaveLength(0));
    second.unmount();
    mobile.unmount();
    client.clear();
  });
});
