import api from './client';
import type { BeamPage } from './pages';

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

/** Agent jobs with a per-job model override; null means the job uses the global `model`. */
export interface AssistantJobModels {
  forward_followup: string | null;
  page_from_brief: string | null;
}

export interface AssistantConfig {
  provider: string;
  model: string;
  enabled: boolean;
  providers: AssistantProviderInfo[];
  job_models: AssistantJobModels;
}

/** POST /assistant/pages body. `dry_run` defaults to true on the server. */
export interface GeneratePageInput {
  company: string;
  brief: string;
  brand: 'champions-group';
  cta_url?: string;
  title?: string;
  slug?: string;
  domain_id?: string;
  dry_run?: boolean;
}

/** The copy the model wrote; the server renders it into `html`. */
export interface GeneratedPageContent {
  headline: string;
  subhead: string;
  pains: string[];
  how_we_help: { title: string; body: string }[];
  proof: string[];
  cta_label: string;
}

export interface GeneratePageDraft {
  html: string;
  content: GeneratedPageContent;
  model: string;
  usage: AssistantUsage;
  checks: { figures_ok: true; bytes: number };
}

export interface GeneratePagePublished {
  page: BeamPage;
  url: string;
  model: string;
  usage: AssistantUsage;
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
    /** Per key: a string sets the override, null clears it, an absent key leaves it. */
    job_models?: Partial<AssistantJobModels>;
  }): Promise<AssistantConfig> {
    const response = await api.put<AssistantConfig>('/assistant/config', data);
    return response.data;
  },

  async chat(messages: AssistantMessage[]): Promise<AssistantChatResponse> {
    const response = await api.post<AssistantChatResponse>('/assistant/chat', { messages });
    return response.data;
  },

  /** A2: brief to a branded one-pager. Dry run (the default) returns the HTML; dry_run false publishes it. */
  async generatePage(input: GeneratePageInput): Promise<GeneratePageDraft | GeneratePagePublished> {
    const response = await api.post<GeneratePageDraft | GeneratePagePublished>('/assistant/pages', input);
    return response.data;
  },
};