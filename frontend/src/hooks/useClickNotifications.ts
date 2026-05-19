import { useEffect, useRef, useCallback, useState } from 'react';
import { toast } from 'sonner';
import { utmApi } from '../api/utm';
import type { RecentClick } from '../api/utm';

const POLL_INTERVAL = 10_000; // 10 seconds

export function useClickNotifications(enabled: boolean = true) {
  const lastCheckRef = useRef<string>(new Date().toISOString());
  const seenIdsRef = useRef<Set<string>>(new Set());
  const [recentClicks, setRecentClicks] = useState<RecentClick[]>([]);

  const poll = useCallback(async () => {
    if (!enabled) return;
    try {
      const clicks = await utmApi.getRecentClicks(lastCheckRef.current);
      const newClicks = clicks.filter((c) => !seenIdsRef.current.has(c.id));

      if (newClicks.length > 0) {
        newClicks.forEach((click) => {
          seenIdsRef.current.add(click.id);
          const urlLabel = click.original_url.length > 40
            ? click.original_url.slice(0, 40) + '...'
            : click.original_url;
          const location = [click.country, click.region].filter(Boolean).join(', ');
          toast.info(`New click on ${urlLabel}`, {
            description: `${location || 'Unknown location'} \u2022 ${click.device_type || 'Unknown device'}`,
            duration: 8000,
          });
        });
        setRecentClicks((prev) => [...newClicks, ...prev].slice(0, 50));
      }

      lastCheckRef.current = new Date().toISOString();
    } catch {
      // silent fail
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [poll, enabled]);

  return { recentClicks };
}
