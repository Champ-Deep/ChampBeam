import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AnnouncementBanner } from './AnnouncementBanner';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('AnnouncementBanner', () => {
  it.each([undefined, '', '   '])('renders nothing for empty copy (%s)', (text) => {
    vi.stubEnv('VITE_ANNOUNCEMENT', text);
    const { container } = render(<AnnouncementBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders plain text, remembers dismissal, and shows new copy', () => {
    const text = 'Maintenance <strong>notice</strong>';
    vi.stubEnv('VITE_ANNOUNCEMENT', text);
    const first = render(<AnnouncementBanner />);
    expect(screen.getByRole('region', { name: 'Announcement' })).toHaveTextContent(text);
    expect(first.container.querySelector('strong')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss announcement' }));
    expect(first.container).toBeEmptyDOMElement();
    const key = localStorage.key(0) ?? '';
    expect(key).toMatch(/^cb-announcement:[0-9a-f]+$/);
    expect(localStorage.getItem(key)).toBe(text);
    first.unmount();

    const second = render(<AnnouncementBanner />);
    expect(second.container).toBeEmptyDOMElement();
    second.unmount();

    vi.stubEnv('VITE_ANNOUNCEMENT', 'New notice');
    render(<AnnouncementBanner />);
    expect(screen.getByText('New notice')).toBeVisible();
  });

  it('still renders and dismisses when storage reads and writes fail', () => {
    vi.stubEnv('VITE_ANNOUNCEMENT', 'Maintenance notice');
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Blocked'); });
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Full'); });
    const { container } = render(<AnnouncementBanner />);
    expect(screen.getByText('Maintenance notice')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss announcement' }));
    expect(container).toBeEmptyDOMElement();
  });
});
