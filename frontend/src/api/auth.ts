import api from './client';

export interface User {
  id: string;
  email: string;
  full_name: string | null;
  is_active: boolean;
  created_at: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  full_name?: string;
}

/** Backend returns user_id (not id) in the user object */
interface BackendUser {
  user_id: string;
  email: string;
  full_name: string | null;
}

interface BackendAuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: BackendUser;
}

export interface AuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: User;
}

function mapUser(bu: BackendUser): User {
  return {
    id: bu.user_id,
    email: bu.email,
    full_name: bu.full_name,
    is_active: true,
    created_at: '',
  };
}

export interface ForgotPasswordResponse {
  message: string;
}

export interface ResetPasswordResponse {
  success: boolean;
  message: string;
}

export interface ChangePasswordResponse {
  success: boolean;
  message: string;
  access_token: string;
  token_type: string;
  expires_in: number;
}

export const authApi = {
  async login(data: LoginRequest): Promise<AuthResponse> {
    const response = await api.post<BackendAuthResponse>('/auth/login', data);
    return { ...response.data, user: mapUser(response.data.user) };
  },

  async register(data: RegisterRequest): Promise<AuthResponse> {
    const response = await api.post<BackendAuthResponse>('/auth/register', data);
    return { ...response.data, user: mapUser(response.data.user) };
  },

  async me(): Promise<BackendUser> {
    const response = await api.get<BackendUser>('/auth/me');
    return response.data;
  },

  async forgotPassword(email: string): Promise<ForgotPasswordResponse> {
    const response = await api.post<ForgotPasswordResponse>('/auth/forgot-password', { email });
    return response.data;
  },

  async resetPassword(token: string, newPassword: string): Promise<ResetPasswordResponse> {
    const response = await api.post<ResetPasswordResponse>('/auth/reset-password', {
      token,
      new_password: newPassword,
    });
    return response.data;
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<ChangePasswordResponse> {
    const response = await api.post<ChangePasswordResponse>('/auth/change-password', {
      current_password: currentPassword,
      new_password: newPassword,
    });
    return response.data;
  },
};

export default authApi;
