import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, ChevronsUpDown } from 'lucide-react';
import { authClient, useAuth } from '../lib/authClient';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from './ui/dropdown-menu';

const item = 'min-h-11 cursor-pointer gap-3 rounded-lg px-3 text-[14px] text-[var(--cb-ink)] focus:bg-[var(--cb-bg)] focus:text-[var(--cb-ink)]';

/** Personal first, then the user's orgs. Switching remounts SessionScope, which drops the query cache. */
export function OrgSwitcher() {
  const { orgId } = useAuth();
  const { data: orgs, isPending, error } = authClient.useListOrganizations();
  const navigate = useNavigate();
  const [switchError, setSwitchError] = useState('');
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const entries = [{ id: null as string | null, name: 'Personal' }, ...(orgs ?? []).map((o) => ({ id: o.id as string | null, name: o.name }))];
  const active = entries.find((e) => e.id === orgId) ?? { id: orgId, name: orgId ? 'Organization workspace' : 'Personal' };

  async function select(id: string | null) {
    if (id === orgId) return;
    setSwitchError('');
    void navigate('/');
    const { error: err } = await authClient.organization.setActive({ organizationId: id });
    if (err) setSwitchError('Could not switch workspace. Try again.');
  }

  return <div className="cb-org-switcher" ref={(el) => setDialog(el?.closest('dialog') ?? null)}>
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] text-white hover:bg-white/5" aria-label={`Workspace: ${active.name}. Switch workspace`}>
        <span className="min-w-0 flex-1 truncate">{active.name}</span>
        <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-white/70" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent container={dialog} align="start" className="w-64 rounded-xl border-[var(--cb-border-strong)] bg-white p-1 text-[var(--cb-ink)]">
        <DropdownMenuLabel className="px-3 text-[12px] font-medium text-[var(--cb-muted)]">Switch workspace</DropdownMenuLabel>
        {entries.map((e) => <DropdownMenuItem key={e.id ?? 'personal'} className={item} onSelect={() => void select(e.id)} aria-current={e.id === orgId ? 'true' : undefined}>
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {e.id === orgId && <Check className="h-4 w-4 text-[var(--cb-accent)]" aria-label="Active" />}
        </DropdownMenuItem>)}
        {isPending && <p role="status" className="px-3 py-2 text-[13px] text-[var(--cb-muted)]">Loading workspaces…</p>}
        {error && <p role="alert" className="px-3 py-2 text-[13px] text-[var(--cb-ink)]">Workspaces could not load.</p>}
      </DropdownMenuContent>
    </DropdownMenu>
    {switchError && <p role="alert">{switchError}</p>}
  </div>;
}
