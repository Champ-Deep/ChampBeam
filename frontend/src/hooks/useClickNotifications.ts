import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { utmApi } from '../api/utm';
import type { RecentClick } from '../api/utm';

const POLL_INTERVAL = 10_000;
// Sidebar and mobile navigation both subscribe to this feed. Share toast
// bookkeeping so one event produces one toast, not one toast per subscriber.
const seenByUser = new Map<string, Set<string>>();

export function useClickNotifications(enabled: boolean = true, userId?: string | null) {
  const queryClient = useQueryClient();
  const queryKey = ['recent-clicks', userId];

  const { data: clicks } = useQuery<RecentClick[]>({
    queryKey,
    queryFn: () => utmApi.getRecentClicks(),
    enabled: enabled && !!userId,
    refetchInterval: POLL_INTERVAL,
  });

  useEffect(() => {
    if (!enabled || !userId || !clicks) return;
    const ids = new Set(clicks.map((click) => click.id));
    const seen = seenByUser.get(userId);
    if (seen) {
      clicks.filter((click) => !seen.has(click.id)).forEach((click) => {
        const label = click.filename || click.original_url || 'link';
        toast.info(`New open on ${label.length > 40 ? label.slice(0, 40) + '...' : label}`, {
          description: [click.country, click.region, click.device_type].filter(Boolean).join(' · ') || 'Unknown location',
          duration: 8000,
        });
      });
    }
    seenByUser.set(userId, ids);
  }, [enabled, userId, clicks]);

  const clearMutation = useMutation({
    mutationFn: () => utmApi.clearRecentClicks(),
    onSuccess: () => {
      if (userId) seenByUser.set(userId, new Set());
      queryClient.setQueryData(queryKey, []);
      void queryClient.invalidateQueries({ queryKey });
    },
  });
  return { recentClicks: clicks ?? [], clearAll: () => clearMutation.mutateAsync(), clearing: clearMutation.isPending };
}
