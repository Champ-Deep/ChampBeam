import { act, cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountLoading } from './AccountLoading';

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('AccountLoading', () => {
  it('names the operation without offering a premature recovery', () => {
    render(<AccountLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading account');
    expect(screen.getByRole('status')).toHaveClass('sr-only');
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    expect(screen.queryByText('Opening your workspace')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offers recovery after twelve seconds without granting access', () => {
    vi.useFakeTimers();
    render(<AccountLoading />);
    act(() => vi.advanceTimersByTime(12_000));
    expect(screen.getByRole('status')).toHaveTextContent('Taking longer than expected');
    expect(screen.getByRole('button', { name: 'Reload page' })).toBeEnabled();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/sign-in');
  });

  it('cleans up the recovery timer on unmount', () => {
    vi.useFakeTimers();
    const { unmount } = render(<AccountLoading />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
