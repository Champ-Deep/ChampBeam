import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, X } from 'lucide-react';
import { authClient, useAuth } from '../../lib/authClient';
import { useAppConfig } from '../../hooks/useAppConfig';
import { useOrgContext } from '../../hooks/useOrgContext';
import { useShareLists } from '../../hooks/useShareLists';
import { utmApi } from '../../api/utm';
import { selfServeApi } from '../../api/selfServe';
import { orgApi } from '../../api/org';
import { CreateOrgDialog } from './CreateOrgDialog';

type Step = { id: string; title: string; body: string; done: boolean; action: React.ReactNode };

/**
 * First-run checklist. Each step is optional, dismissible, and marked done from real data, never from a click.
 * Layout after 21st.dev "Onboarding Workspace Setup" (id 29449, ephraimduncan/onboarding-02).
 */
export function OnboardingChecklist() {
  const { userId } = useAuth();
  const { data: config } = useAppConfig();
  const { inOrg, isAdmin } = useOrgContext();
  const { files, pages, links } = useShareLists(true);
  const { data: orgs } = authClient.useListOrganizations();
  const domains = useQuery({ queryKey: ['domains'], queryFn: () => utmApi.listDomains(), enabled: !!config?.custom_domains_enabled });
  const invites = useQuery({ queryKey: ['org-invitations'], queryFn: () => selfServeApi.pendingInvitations(), enabled: inOrg && isAdmin });
  const context = useQuery({ queryKey: ['org-context', userId], queryFn: () => orgApi.getContext(), enabled: inOrg && isAdmin });
  const key = `cb-onboarding-dismissed:${userId}`;
  const [dismissed, setDismissed] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; } catch { return []; } });
  const [creating, setCreating] = useState(false);
  const dismiss = (ids: string[]) => { const next = [...new Set([...dismissed, ...ids])]; setDismissed(next); localStorage.setItem(key, JSON.stringify(next)); };

  if (!config) return null;
  const steps: Step[] = [
    { id: 'share', title: 'Share your first link', body: 'Drop a file, a page or a URL above. Every open is tracked.', done: [files, pages, links].some((q) => (q.data?.length ?? 0) > 0), action: <a href="#main-content" className="cb-text-btn">Start above</a> },
  ];
  if (config.can_create_org) steps.push({ id: 'org', title: 'Create an organization', body: 'A shared workspace with its own members, roles and domain.', done: (orgs?.length ?? 0) > 0, action: <button type="button" className="cb-text-btn" onClick={() => setCreating(true)}>Create organization</button> });
  if (inOrg && isAdmin) steps.push({ id: 'invite', title: 'Invite your team', body: 'Send each person a link to join with the right role.', done: (invites.data?.length ?? 0) > 0 || (context.data?.member_count ?? 0) > 1, action: <Link className="cb-text-btn" to="/settings">Invite people</Link> });
  if (config.custom_domains_enabled) steps.push({ id: 'domain', title: 'Add your domain', body: 'Share from your own address, such as share.yourcompany.com.', done: (domains.data?.length ?? 0) > 0, action: <Link className="cb-text-btn" to="/settings?tab=domains">Add a domain</Link> });

  const open = steps.filter((s) => !dismissed.includes(s.id));
  const doneCount = steps.filter((s) => s.done).length;
  if (!open.length || doneCount === steps.length) return null;
  return <section className="cb-checklist" aria-labelledby="checklist-h">
    <div className="cb-section-head">
      <div><h2 id="checklist-h">Get set up</h2><p className="cb-hint">{doneCount} of {steps.length} done. Every step is optional.</p></div>
      <button type="button" className="cb-text-btn" onClick={() => dismiss(steps.map((s) => s.id))}>Hide this</button>
    </div>
    <div className="cb-progress" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount}><i style={{ ['--w' as string]: doneCount / steps.length }} /></div>
    <ol className="cb-steps">{open.map((s) => <li key={s.id} data-done={s.done || undefined}>
      <span className="cb-step-mark" aria-hidden="true">{s.done ? <Check className="h-4 w-4" /> : steps.indexOf(s) + 1}</span>
      <span className="cb-step-text"><strong>{s.title}</strong>{s.done ? <span className="sr-only"> (done)</span> : null}<span className="cb-hint">{s.body}</span></span>
      <span className="cb-row-actions">{!s.done && s.action}<button type="button" className="cb-icon-btn" aria-label={`Dismiss ${s.title}`} onClick={() => dismiss([s.id])}><X className="h-4 w-4" aria-hidden="true" /></button></span>
    </li>)}</ol>
    {config.can_create_org && <CreateOrgDialog open={creating} onOpenChange={setCreating} platformHost={config.platform_host} />}
  </section>;
}
