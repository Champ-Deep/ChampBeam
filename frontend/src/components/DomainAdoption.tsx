import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { orgApi } from '../api/org';
import type { AdoptionReport, OrgDomain } from '../api/org';
import { apiErrorDetail } from '../api/_shared';
import { Button, useConfirm } from './ui';

export function AdoptionSummary({ report }: { report: AdoptionReport }) {
  const { collisions } = report;
  return <div className="cb-domain-adoption">
    <p>{report.adopted.links} links, {report.adopted.files} files and {report.adopted.aliases} aliases {report.dry_run ? 'can move.' : 'moved.'}</p>
    {Object.values(collisions).some((rows) => rows.length > 0) && <div role="alert">
      <p>Some addresses already exist on this domain. These items were skipped, not overwritten. Rename the conflicting addresses before retrying. Each list shows up to 200 conflicts.</p>
      <ul>{collisions.files.map((r) => <li key={`file:${r.short_code}`}>File: <code>{r.slug ?? r.short_code}</code></li>)}
        {collisions.links.map((r) => <li key={`link:${r.short_code}`}>Link: <code>{r.short_code}</code></li>)}
        {collisions.aliases.map((r) => <li key={`alias:${r.slug}`}>Alias: <code>{r.slug}</code></li>)}</ul>
    </div>}
  </div>;
}

export function DomainAdoption({ domain, orgId }: { domain: OrgDomain; orgId: string | null }) {
  const confirm = useConfirm();
  const client = useQueryClient();
  const [result, setResult] = useState<AdoptionReport | null>(null);
  const preview = useQuery({
    queryKey: ['domain-adoption', orgId, domain.id],
    queryFn: () => orgApi.adoptExisting(domain.id),
  });
  const apply = useMutation({
    mutationFn: () => orgApi.adoptExisting(domain.id, false),
    onSuccess: (report) => {
      setResult(report);
      void client.invalidateQueries({ queryKey: ['domain-adoption', orgId, domain.id] });
      for (const key of ['files', 'pages', 'utm', 'org-profile']) void client.invalidateQueries({ queryKey: [key] });
    },
  });
  async function review() {
    try {
      // Refresh the dry run at the point of confirmation, not from a stale cached count.
      const report = await preview.refetch({ throwOnError: true });
      if (!report.data) return;
      const { links, files } = report.data.adopted;
      if (await confirm({ title: 'Move existing content?', message: `${links} links, ${files} files will move to ${domain.hostname}. Conflicting addresses are skipped, never overwritten.`, confirmLabel: 'Move existing content', destructive: false })) apply.mutate();
    } catch { /* The query renders the error and retry action. */ }
  }
  return <section className="cb-domain-adoption" aria-label="Move existing content">
    <h4>Existing content on your default domain</h4>
    <p>Default: <code>{domain.hostname}</code>. Setting the default also attempts an automatic move. Review what remains below.</p>
    {preview.isLoading && <p role="status">Checking existing links and files…</p>}
    {preview.isError && <p role="alert">Could not count existing content. Retry before moving anything.</p>}
    {preview.data && <><p>{preview.data.adopted.links} links, {preview.data.adopted.files} files will move to <code>{domain.hostname}</code>.</p><AdoptionSummary report={preview.data} /></>}
    <Button variant="secondary" onClick={() => void review()} isLoading={preview.isFetching || apply.isPending}>Review and move existing content</Button>
    {apply.isError && <p role="alert">{apiErrorDetail(apply.error) ?? 'Could not move existing content. Review the counts and retry.'}</p>}
    {result && <div role="status"><AdoptionSummary report={result} /></div>}
  </section>;
}
