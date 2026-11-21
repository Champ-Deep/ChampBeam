import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import { orgApi } from '../api/org';
import { apiErrorDetail } from '../api/_shared';
import { useOrgContext } from '../hooks/useOrgContext';
import { Badge, Button, Card, CardHeader, CardTitle, Input, useConfirm } from './ui';

/** Admin list of company email domains: a verified sign-in on one auto-joins the org. */
export function EmailDomainsSettings() {
  const { orgId } = useOrgContext();
  const client = useQueryClient();
  const confirm = useConfirm();
  const [domain, setDomain] = useState('');
  const key = ['org-email-domains', orgId];
  const list = useQuery({ queryKey: key, queryFn: () => orgApi.emailDomains() });
  const refresh = () => client.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: (d: string) => orgApi.addEmailDomain(d),
    onSuccess: () => { setDomain(''); toast.success('Company email domain added.'); return refresh(); },
    onError: (err: unknown) => toast.error(apiErrorDetail(err) ?? 'Could not add the domain.'),
  });
  const remove = useMutation({
    mutationFn: (d: string) => orgApi.removeEmailDomain(d),
    onSuccess: () => { toast.success('Domain removed. Existing members keep their access.'); return refresh(); },
    onError: (err: unknown) => toast.error(apiErrorDetail(err) ?? 'Could not remove the domain.'),
  });
  const rows = list.data ?? [];

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Company email domains</CardTitle>
      </CardHeader>
      <p className="mb-4 text-sm" style={{ color: 'var(--cb-text-mid)' }}>
        People who sign in with a verified email on one of these domains join the organization as members and can share on its domains.
        Everyone else gets a personal account. Removing a domain does not remove anyone already in.
      </p>
      <form
        className="flex flex-col sm:flex-row items-start gap-3"
        onSubmit={(e) => { e.preventDefault(); const d = domain.trim(); if (d) add.mutate(d); }}
      >
        <div className="w-full min-w-0 flex-1">
          <Input label="Email domain" placeholder="acme.com" value={domain} onChange={(e) => setDomain(e.target.value)} className="font-mono" />
        </div>
        <Button type="submit" isLoading={add.isPending} disabled={!domain.trim()} leftIcon={<Plus className="h-4 w-4" />} className="sm:mt-7 whitespace-nowrap">
          Add domain
        </Button>
      </form>
      {list.isError && <p role="alert" className="mt-4 text-sm text-red-700">Could not load the list. Reload before making changes.</p>}
      {list.isLoading ? (
        <p role="status" className="mt-4 text-sm" style={{ color: 'var(--cb-muted)' }}>Loading.</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm" style={{ color: 'var(--cb-muted)' }}>No domains yet. Nobody joins automatically.</p>
      ) : (
        <ul className="mt-4" style={{ borderTop: '1px solid var(--cb-divider)' }}>
          {rows.map((r) => (
            <li key={r.domain} className="flex items-center justify-between gap-3 py-3" style={{ borderBottom: '1px solid var(--cb-divider)' }}>
              <span className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-sm break-all" style={{ color: 'var(--cb-ink)' }}>{r.domain}</span>
                <Badge variant="success" size="sm">Auto-join</Badge>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${r.domain}`}
                leftIcon={<Trash2 className="h-4 w-4" />}
                disabled={remove.isPending}
                onClick={() => { void (async () => { if (await confirm({ message: `Stop auto-joining ${r.domain}? Existing members stay.`, confirmLabel: 'Remove' })) remove.mutate(r.domain); })(); }}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
