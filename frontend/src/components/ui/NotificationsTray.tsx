import { useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { Bell, FileText, Link2, X } from 'lucide-react';
import type { RecentClick } from '../../api/utm';
import { formatRelative } from '../../lib/format';
import { IllosInboxArt } from './illos-inbox-art';
import './notifications-tray.css';

// Adapted from navedux Illos Notifications Popover, 21st.dev 44490, MIT.
export function NotificationsTray({ recentClicks, clearAll, clearing = false }: {
  recentClicks: RecentClick[];
  clearAll: () => Promise<unknown>;
  clearing?: boolean;
}) {
  const [read, setRead] = useState<Set<string>>(() => new Set());
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState('');
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 768);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const items = recentClicks.slice(0, 10);
  const unread = items.filter((item) => !read.has(item.id)).length;
  const clear = async () => {
    setError('');
    try { await clearAll(); } catch { setError('Recent opens could not be cleared. Try again.'); }
  };
  return <Popover.Root onOpenChange={(open) => { if (open) setFresh(new Set(items.filter((item) => !read.has(item.id)).map((item) => item.id))); }}>
    <Popover.Trigger className="beam-notifications-trigger" aria-label={`Recent opens${unread ? `, ${unread} unread` : ''}`}>
      <Bell aria-hidden="true" size={18} /><span>Recent opens</span>{unread > 0 && <i aria-hidden="true" />}
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="beam-notifications" side={mobile ? 'top' : 'right'} align="end" sideOffset={12} collisionPadding={8} aria-label="Recent opens">
        <header><h2>Recent opens</h2><div>{items.length > 0 && <button type="button" onClick={() => void clear()} disabled={clearing}>{clearing ? 'Clearing...' : 'Clear all'}</button>}<Popover.Close aria-label="Close recent opens"><X size={18} aria-hidden="true" /></Popover.Close></div></header>
        {error && <p role="alert" className="beam-notifications-error">{error}</p>}
        <div className="beam-notifications-scroll">
          {['New', 'Earlier'].map((group) => {
            const rows = items.filter((item) => fresh.has(item.id) === (group === 'New'));
            return rows.length > 0 && <section key={group} aria-label={group}><h3>{group}</h3><ul>{rows.map((item) => {
              const Icon = item.type === 'file' ? FileText : Link2;
              return <li key={item.id}><button type="button" className="beam-notification-row" onClick={() => setRead((prev) => new Set(prev).add(item.id))}>
                <Icon size={20} aria-hidden="true" /><span className="beam-notification-copy"><strong>{item.filename || item.original_url || 'Link open'}</strong>
                  <span className="beam-notification-meta">{(item.company_name || item.ip_address) && <span>{[item.company_name, item.ip_address].filter(Boolean).join(' · ')}</span>}<span>{[item.country, item.region].filter(Boolean).join(', ') || 'Unknown location'}</span><span>{item.device_type || 'Unknown device'}</span></span>
                  {item.clicked_at && <span className="beam-notification-time">{formatRelative(item.clicked_at)}</span>}
                </span><span className="beam-unread-dot" data-unread={!read.has(item.id)} role="img" aria-label={!read.has(item.id) ? 'Unread' : 'Read'} />
              </button></li>;
            })}</ul></section>;
          })}
          {unread === 0 && <div className="beam-notifications-empty"><IllosInboxArt /><p>You're all caught up</p><span>New file and link opens will appear here.</span></div>}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
