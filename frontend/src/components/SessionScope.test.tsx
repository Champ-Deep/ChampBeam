import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionScope } from './SessionScope';

type Session = { data: null; isPending: boolean };
const session = vi.hoisted(() => {
  let state: Session = { data: null, isPending: true };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: Session) => { state = next; listeners.forEach((l) => l()); },
    subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
});
vi.mock('better-auth/react', async () => {
  const { useSyncExternalStore } = await import('react');
  return { createAuthClient: () => ({ useSession: () => useSyncExternalStore(session.subscribe, session.get) }) };
});
afterEach(cleanup);

describe('SessionScope', () => {
  it('keeps a guest form mounted when a focus refetch goes pending again with null data', () => {
    render(<SessionScope><label>Email<input /></label></SessionScope>);
    expect(screen.getByRole('status')).toHaveTextContent('Loading account');

    act(() => session.set({ data: null, isPending: false }));
    const input = screen.getByLabelText('Email');
    fireEvent.change(input, { target: { value: 'guest@example.invalid' } });

    // Better Auth 1.7.18 does this on visibilitychange for a signed-out visitor.
    act(() => session.set({ data: null, isPending: true }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getByLabelText('Email')).toBe(input);
    expect(input).toHaveValue('guest@example.invalid');
  });
});
