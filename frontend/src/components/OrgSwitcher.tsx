import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { Building2, Check, ChevronsUpDown, Plus } from 'lucide-react';
import { authClient, useAuth } from '../lib/authClient';
import { useAppConfig } from '../hooks/useAppConfig';
import { ROLE_LABEL } from '../api/selfServe';
import { CreateOrgDialog } from './org/CreateOrgDialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

const item = 'min-h-11 cursor-pointer gap-3 rounded-lg px-3 text-[14px] text-[var(--cb-ink)] focus:bg-[var(--cb-bg)] focus:text-[var(--cb-ink)]';

/**
 * Personal first, then the user's orgs with the caller's role in each. Switching remounts SessionScope,
 * which drops the query cache. Pattern from 21st.dev "Workspaces" (id 4511, efferd/workspaces): list,
 * search past five entries, actions under a divider; built on the repo's own dropdown menu.
 */
export function OrgSwitcher() {
  const { orgId } = useAuth();
  const { data: orgs, isPending, error } = authClient.useListOrganizations();
  const { data: config } = useAppConfig();
  const navigate = useNavigate();
  const [switchError, setSwitchError] = useState('');
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const roles = useQueries({
    queries: (orgs ?? []).map((o) => ({
      queryKey: ['org-role', o.id],
      staleTime: 60_000,
      queryFn: async () => (await authClient.organization.getActiveMemberRole({ query: { organizationId: o.id } })).data?.role ?? null,
    })),
  });
  const entries = [{ id: null as string | null, name: 'Personal', role: null as string | null }, ...(orgs ?? []).map((o, i) => ({ id: o.id as string | null, name: o.name, role: roles[i]?.data ?? null }))];
  const active = entries.find((e) => e.id === orgId) ?? { id: orgId, name: orgId ? 'Organization workspace' : 'Personal', role: null };
  const shown = query ? entries.filter((e) => e.name.toLowerCase().includes(query.toLowerCase())) : entries;

  async function select(id: string | null) {
    if (id === orgId) return;
    setSwitchError('');
    void navigate('/');
    const { error: err } = await authClient.organization.setActive({ organizationId: id });
    if (err) setSwitchError('Could not switch workspace. Try again.');
  }

  return <div className="cb-org-switcher" ref={(el) => setDialog(el?.closest('dialog') ?? null)}>
    <DropdownMenu onOpenChange={(o) => { if (!o) setQuery(''); }}>
      <DropdownMenuTrigger className="flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-left text-[14px] text-white hover:bg-white/5" aria-label={`Workspace: ${active.name}. Switch workspace`}>
        <span className="min-w-0 flex-1 truncate text-white">{active.name}</span>
        {active.role && <span className="cb-role-badge cb-role-badge-dark">{ROLE_LABEL[active.role] ?? active.role}</span>}
        <ChevronsUpDown className="h-4 w-4 flex-shrink-0 text-white/70" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent container={dialog} align="start" className="w-72 rounded-xl border-[var(--cb-border-strong)] bg-white p-1 text-[var(--cb-ink)]">
        <DropdownMenuLabel className="px-3 text-[12px] font-medium text-[var(--cb-muted)]">Switch workspace</DropdownMenuLabel>
        {entries.length > 5 && <div className="px-2 pb-1"><input aria-label="Search workspaces" placeholder="Search workspaces" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} className="cb-menu-search" /></div>}
        {shown.map((e) => <DropdownMenuItem key={e.id ?? 'personal'} className={item} onSelect={() => void select(e.id)} aria-current={e.id === orgId ? 'true' : undefined}>
          <span className="min-w-0 flex-1 truncate">{e.name}</span>
          {e.role && <span className="cb-role-badge">{ROLE_LABEL[e.role] ?? e.role}</span>}
          {e.id === orgId && <Check className="h-4 w-4 text-[var(--cb-accent)]" aria-label="Active" />}
        </DropdownMenuItem>)}
        {query && shown.length === 0 && <p className="px-3 py-2 text-[13px] text-[var(--cb-muted)]">No workspace matches.</p>}
        {isPending && <p role="status" className="px-3 py-2 text-[13px] text-[var(--cb-muted)]">Loading workspaces</p>}
        {error && <p role="alert" className="px-3 py-2 text-[13px] text-[var(--cb-ink)]">Workspaces could not load.</p>}
        {(config?.can_create_org || config?.is_super_admin) && <DropdownMenuSeparator className="bg-[var(--cb-divider)]" />}
        {config?.can_create_org && <DropdownMenuItem className={item} onSelect={() => setCreating(true)}><Plus className="h-4 w-4" aria-hidden="true" />Create organization</DropdownMenuItem>}
        {config?.is_super_admin && <DropdownMenuItem asChild className={item}><Link to="/admin/orgs"><Building2 className="h-4 w-4" aria-hidden="true" />All organizations</Link></DropdownMenuItem>}
      </DropdownMenuContent>
    </DropdownMenu>
    {switchError && <p role="alert">{switchError}</p>}
    {config?.can_create_org && <CreateOrgDialog open={creating} onOpenChange={setCreating} platformHost={config.platform_host} />}
  </div>;
}
