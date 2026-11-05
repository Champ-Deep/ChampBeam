import api from './client';

// ============================================================
// Types (mirror backend/app/api/v1/assistant.py)
// ============================================================

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface AssistantChatResponse {
  reply: string;
  provider: string;
  model: string;
  usage: AssistantUsage | Record<string, never>;
}

export interface AssistantProviderInfo {
  id: string;
  configured: boolean;
  free_models: string[];
}

export interface AssistantConfig {
  provider: string;
  model: string;
  enabled: boolean;
  providers: AssistantProviderInfo[];
}

// ============================================================
// API
// ============================================================

export const assistantApi = {
  async config(): Promise<AssistantConfig> {
    const response = await api.get<AssistantConfig>('/assistant/config');
    return response.data;
  },

  async updateConfig(data: {
    provider: string;
    model?: string;
    enabled?: boolean;
  }): Promise<AssistantConfig> {
    const response = await api.put<AssistantConfig>('/assistant/config', data);
    return response.data;
  },

  async chat(messages: AssistantMessage[]): Promise<AssistantChatResponse> {
    const response = await api.post<AssistantChatResponse>('/assistant/chat', { messages });
    return response.data;
  },
};