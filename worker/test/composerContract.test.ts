import { describe, expect, it } from 'vitest';
import { api, json } from './helpers';
import { member, newOrgId, useRouteTestHooks } from './orgTestUtils';
import { setSettings } from './serveSeed';

useRouteTestHooks();

// These are acceptance probes for the frontend handoff, not production assets.
// The D1 fixture is shared across tests and slugs are one namespace, so each test names its own slug.
async function hostPdf(slug: string | null = 'quarterly-brief', filename = 'Quarterly Brief.pdf') {
  const user = await member(newOrgId(), 'member');
  const init = await api('/api/v1/files', {
    method: 'POST', headers: user.headers,
    json: { filename, content_type: 'application/pdf', size_bytes: 1, intent: 'host', ...(slug ? { slug } : {}) },
  });
  expect(init.status).toBe(201);
  const upload = await json(init);
  const put = await api(upload.presigned_put_url, { method: 'PUT', headers: upload.headers, body: 'x' });
  expect(put.status).toBe(204);
  const finalized = await api(`/api/v1/files/${upload.file_id}/finalize`, { method: 'POST', headers: user.headers, json: {} });
  expect(finalized.status).toBe(200);
  return { user, asset: await json(finalized) };
}

describe('composer handoff acceptance', () => {
  it('persists the selected slug for a hosted PDF', async () => {
    const { asset } = await hostPdf();
    expect(asset.output_kind).toBe('page');
    expect(asset.slug).toBe('quarterly-brief');
    expect(asset.public_url).toMatch(/\/quarterly-brief$/);
  });

  it('includes a hosted PDF in Pages', async () => {
    const { user, asset } = await hostPdf('pages-list-brief');
    const list = await api('/api/v1/pages', { headers: user.headers });
    expect(list.status).toBe(200);
    expect((await json(list)).map((page: { page_id: string }) => page.page_id)).toContain(asset.id);
  });

  it('can update the slug of a hosted PDF through the Pages contract', async () => {
    const { user, asset } = await hostPdf('old-brief');
    const changed = await api(`/api/v1/pages/${asset.id}`, { method: 'PATCH', headers: user.headers, json: { slug: 'revised-brief' } });
    expect(changed.status).toBe(200);
    expect((await json(changed)).slug).toBe('revised-brief');
    setSettings({ shareHosts: ['share.example.com'], resolvedShareHost: 'share.example.com' } as any);
    expect((await api('/revised-brief')).status).toBe(200);
    expect((await api('/old-brief')).status).toBeLessThan(400); // old alias keeps working
  });

  it('derives a collision-suffixed slug from the filename when none is chosen', async () => {
    const first = await hostPdf(null, 'Roadmap Deck.pdf');
    const second = await hostPdf(null, 'Roadmap Deck.pdf');
    expect(first.asset.slug).toBe('roadmap-deck');
    expect(second.asset.slug).toBe('roadmap-deck-2');
  });

  it('denies a viewer create request on the server', async () => {
    const viewer = await member(newOrgId(), 'viewer');
    const profile = await json(await api('/api/v1/org/profile', { headers: viewer.headers }));
    expect(profile.permissions).not.toContain('share.create');
    const result = await api('/api/v1/files', {
      method: 'POST', headers: viewer.headers,
      json: { filename: 'brief.pdf', content_type: 'application/pdf', size_bytes: 1, intent: 'host' },
    });
    expect(result.status).toBe(403);
  });
});
