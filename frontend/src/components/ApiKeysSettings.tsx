import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Copy, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, CardHeader, CardTitle, Input } from './ui';
import { apiKeysApi } from '../api/apiKeys';
import type { ApiKeyCreated, ApiKeySummary } from '../api/apiKeys';

function formatDate(iso: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'Never' : d.toLocaleString();
}

export function ApiKeysSettings() {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [createdKey, setCreatedKey] = useState<ApiKeyCreated | null>(null);

  const { data: keys = [], isLoading } = useQuery<ApiKeySummary[]>({
    queryKey: ['api-keys'],
    queryFn: () => apiKeysApi.list(),
  });

  const createMutation = useMutation({
    mutationFn: (keyName: string) => apiKeysApi.create(keyName),
    onSuccess: (created) => {
      setCreatedKey(created);
      setName('');
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (err: unknown) => {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail ??
        'Could not create API key.';
      toast.error(msg);
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => apiKeysApi.revoke(id),
    onSuccess: () => {
      toast.success('API key revoked.');
      queryClient.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: () => toast.error('Could not revoke API key.'),
  });

  const handleCreate = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error('Give the key a name so you can tell it apart later.');
      return;
    }
    createMutation.mutate(trimmed);
  };

  const handleRevoke = (key: ApiKeySummary) => {
    const confirmMsg = `Revoke "${key.name}"? Applications using this key will immediately lose access.`;
    if (!window.confirm(confirmMsg)) return;
    revokeMutation.mutate(key.id);
  };

  const copyKey = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success('API key copied to clipboard.');
    } catch {
      toast.error('Could not copy. Select and copy the key manually.');
    }
  };

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <>
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Create API key</CardTitle>
        </CardHeader>
        <p className="text-sm text-slate-600 mb-4">
          API keys let your other applications create trackable links, upload files and
          read analytics through the ChampBeam API — as you, including your custom
          domains. Send the key in an <code className="text-xs bg-slate-100 px-1 py-0.5 rounded">X-API-Key</code> header.
        </p>
        <div className="flex gap-3">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            placeholder="Key name, e.g. Agent Workspace"
            maxLength={100}
            className="flex-1"
          />
          <Button onClick={handleCreate} disabled={createMutation.isPending}>
            <Plus className="h-4 w-4 mr-1.5" />
            Create key
          </Button>
        </div>

        {createdKey && (
          <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
            <div className="flex items-center gap-2 text-emerald-800 text-sm font-medium mb-2">
              <ShieldCheck className="h-4 w-4" />
              {createdKey.name} created — copy it now. You won't see it again.
            </div>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs bg-white border border-emerald-200 rounded px-3 py-2 font-mono break-all select-all">
                {createdKey.api_key}
              </code>
              <Button variant="secondary" onClick={() => copyKey(createdKey.api_key)}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your API keys</CardTitle>
        </CardHeader>
        {isLoading ? (
          <div className="py-8 text-center text-sm text-slate-500">Loading.</div>
        ) : keys.length === 0 ? (
          <div className="py-8 text-center text-sm text-slate-500">
            <KeyRound className="h-6 w-6 mx-auto mb-2 text-slate-400" />
            No API keys yet. Create one above to connect your applications.
          </div>
        ) : (
          <div className="divide-y divide-slate-100 -mx-6 -mb-6">
            {[...activeKeys, ...revokedKeys].map((key) => (
              <div key={key.id} className="flex items-center gap-4 px-6 py-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-slate-900 truncate">{key.name}</span>
                    {key.revoked_at ? (
                      <Badge variant="danger">Revoked</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 font-mono">
                    {key.key_prefix}…
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Created {formatDate(key.created_at)} · Last used {formatDate(key.last_used_at)}
                  </div>
                </div>
                {!key.revoked_at && (
                  <Button
                    variant="secondary"
                    onClick={() => handleRevoke(key)}
                    disabled={revokeMutation.isPending}
                  >
                    <Ban className="h-4 w-4 mr-1.5" />
                    Revoke
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
