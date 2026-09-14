import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Bot, Save } from 'lucide-react';
import { assistantApi } from '../api/assistant';
import type { AssistantConfig } from '../api/assistant';
import { apiErrorDetail, apiErrorStatus } from '../api/_shared';
import { Button, Card, CardHeader, CardTitle } from './ui';

const PROVIDER_LABEL: Record<string, string> = {
  openrouter: 'OpenRouter',
  vercel: 'Vercel AI Gateway',
  mock: 'Mock (local testing)',
};

/** Settings > Assistant: admin picks the provider and model behind the
 * guided feature assistant. Keys live in the backend environment, this only
 * switches which provider/model the chat uses. */
export function AssistantSettings() {
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery<AssistantConfig>({
    queryKey: ['assistant', 'config'],
    queryFn: () => assistantApi.config(),
  });
  const [provider, setProvider] = useState('openrouter');
  const [model, setModel] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!config) return;
    setProvider(config.provider);
    setModel(config.model);
    setEnabled(config.enabled);
  }, [config]);

  const suggested = config?.providers.find((p) => p.id === provider)?.free_models ?? [];

  if (isLoading || !config) {
    return (
      <Card>
        <div className="p-6 text-sm text-slate-500">Loading assistant settings…</div>
      </Card>
    );
  }

  const save = async () => {
    setSaving(true);
    try {
      const next = await assistantApi.updateConfig({ provider, model: model.trim() || undefined, enabled });
      queryClient.setQueryData(['assistant', 'config'], next);
      toast.success('Assistant settings saved.');
    } catch (err: unknown) {
      if (apiErrorStatus(err) === 403) {
        toast.error('Only organization admins can change the assistant provider.');
      } else {
        toast.error(apiErrorDetail(err) ?? 'Could not save settings.');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bot className="h-5 w-5" />
            Assistant
          </CardTitle>
        </CardHeader>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            The guided assistant helps anyone on the team understand a feature, see why it is
            useful for them, and find the exact button to use it. Pick the provider and model
            behind it. API keys stay in the backend environment.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Provider</label>
              <select
                value={provider}
                onChange={(e) => {
                  setProvider(e.target.value);
                  const nextProvider = config.providers.find((p) => p.id === e.target.value);
                  const firstFree = nextProvider?.free_models?.[0];
                  if (firstFree) setModel(firstFree);
                }}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
              >
                {config.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PROVIDER_LABEL[p.id] ?? p.id}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 mt-1.5">
                Key status:{' '}
                {config.providers.find((p) => p.id === provider)?.configured
                  ? 'configured in the backend'
                  : 'NOT configured in the backend yet'}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Model</label>
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                list="assistant-free-models"
                placeholder="meta-llama/llama-3.3-70b-instruct:free"
                maxLength={160}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-sm font-mono outline-none transition-colors focus:border-brand-purple focus:ring-2 focus:ring-brand-purple/20"
              />
              <datalist id="assistant-free-models">
                {suggested.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-xs text-slate-500 mt-1.5">
                Free models to test with:{' '}
                {suggested.length > 0 ? suggested.join(', ') : '(none listed for this provider)'}
              </p>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-brand-purple focus:ring-brand-purple"
            />
            Assistant is on (off hides the chat button for everyone)
          </label>

          <div className="flex items-center justify-end gap-2">
            <Button onClick={save} disabled={saving} leftIcon={<Save className="h-4 w-4" />}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}