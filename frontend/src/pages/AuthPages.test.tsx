import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignInPage } from './AuthPages';

const signInEmail = vi.hoisted(() => vi.fn());
vi.mock('../lib/authClient', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: false, userId: null, orgId: null, user: null }),
  authClient: { signIn: { email: signInEmail } },
  googleSignInEnabled: false,
}));
afterEach(cleanup);

describe('sign-in page', () => {
  it('shows inline field errors, then the server error under the password', async () => {
    render(<MemoryRouter><SignInPage /></MemoryRouter>);
    expect(screen.queryByRole('button', { name: /Google/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter a valid email address.');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    expect(signInEmail).not.toHaveBeenCalled();

    signInEmail.mockResolvedValue({ data: null, error: { code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 } });
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@example.invalid' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email or password is incorrect.')).toBeVisible();
    expect(signInEmail).toHaveBeenCalledWith({ email: 'a@example.invalid', password: 'wrong-password' });
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    // The fixed returning-user line, identical for every rejected email, linking to Forgot password.
    expect(screen.getByRole('status')).toHaveTextContent('Had an account before November 2026? Set a new password and your files will be right where you left them.');
    expect(screen.getByRole('link', { name: 'Set a new password' })).toHaveAttribute('href', expect.stringContaining('/forgot-password'));
  });
});
