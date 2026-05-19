import { useState, useEffect, useCallback } from 'react';
import { authApi, type User } from '../api/auth';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
  });

  // Check for existing token on mount — verify with backend
  useEffect(() => {
    const token = localStorage.getItem('access_token');

    if (!token) {
      setState({ user: null, isAuthenticated: false, isLoading: false });
      return;
    }

    // We have a token — verify it by calling /auth/me
    authApi.me()
      .then((meUser) => {
        // Token is valid, build user object from /auth/me response
        const user: User = {
          id: meUser.user_id,
          email: meUser.email,
          full_name: meUser.full_name ?? null,
          is_active: true,
          created_at: '',
        };
        localStorage.setItem('user', JSON.stringify(user));
        setState({ user, isAuthenticated: true, isLoading: false });
      })
      .catch(() => {
        // Token expired or invalid — clean up
        localStorage.removeItem('access_token');
        localStorage.removeItem('user');
        setState({ user: null, isAuthenticated: false, isLoading: false });
      });
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await authApi.login({ email, password });
    localStorage.setItem('access_token', response.access_token);
    localStorage.setItem('user', JSON.stringify(response.user));
    setState({ user: response.user, isAuthenticated: true, isLoading: false });
    return response;
  }, []);

  const register = useCallback(async (email: string, password: string, fullName?: string) => {
    const response = await authApi.register({ email, password, full_name: fullName });
    localStorage.setItem('access_token', response.access_token);
    localStorage.setItem('user', JSON.stringify(response.user));
    setState({ user: response.user, isAuthenticated: true, isLoading: false });
    return response;
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('access_token');
    localStorage.removeItem('user');
    setState({ user: null, isAuthenticated: false, isLoading: false });
  }, []);

  return {
    ...state,
    login,
    register,
    logout,
  };
}
