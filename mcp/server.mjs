import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const base = new URL(process.env.CHAMPBEAM_BASE_URL || 'https://champbeam.com');
if (base.username || base.password || base.pathname !== '/' || base.search || base.hash ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname)))) {
  throw new Error('CHAMPBEAM_BASE_URL must be an HTTPS origin or a loopback HTTP origin.');
}
const key = process.env.CHAMPBEAM_API_KEY;
if (!key?.startsWith('cb_live_')) throw new Error('Supply CHAMPBEAM_API_KEY through your client secret store.');
const server = new McpServer({ name: 'champbeam', version: '0.1.0' });
const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

async function api(path, method = 'GET', body) {
  const response = await fetch(new URL(`/api/v1${path}`, base), {
    method, headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  // Do not echo error bodies that may contain a signed upload target or internal details.
  if (!response.ok) throw new Error(`Champbeam returned HTTP ${response.status}. Check access and input, then retry.`);
  return response.status === 204 ? null : response.json();
}
function register(name, description, inputSchema, readOnly, handler) {
  server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: !readOnly } }, async args => {
    try { return result(await handler(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error instanceof Error && error.message.startsWith('Champbeam returned HTTP') ? error.message : 'Champbeam operation failed. Check configuration, file size and connectivity. No automatic retry was made.' }] }; }
  });
}
const confirm = z.literal(true).describe('Set only after the user approves creating this share.');
register('list_shares', 'List the authenticated key owner\'s files or pages. API keys do not assume an interactive organization session.', {
  kind: z.enum(['files', 'pages']),
}, true, ({kind}) => api(`/${kind}`));
register('create_link', 'Create a trackable share URL, optionally with UTM fields. Requires explicit user confirmation.', {
  url: z.url().refine(v => ['https:', 'http:'].includes(new URL(v).protocol)),
  utm_source: z.string().max(200).optional(), utm_medium: z.string().max(200).optional(), utm_campaign: z.string().max(200).optional(), confirm,
}, false, ({url, confirm: _confirm, ...utm}) => api('/utm/generate', 'POST', { base_url: url, ...utm }));
register('publish_page', 'Publish a self-contained HTML page and return its permanent share URL. Requires user confirmation. No organization impersonation.', {
  html: z.string().min(1).max(20 * 1024 * 1024), title: z.string().min(1).max(200), confirm,
}, false, ({confirm: _confirm, ...body}) => api('/pages', 'POST', body));
register('upload_file', 'Upload a small file from base64 and return a download share. Adapter limit 5 MB; use the REST upload API for larger files. Requires user confirmation.', {
  filename: z.string().min(1).max(200), content_type: z.string().min(1).max(100),
  base64: z.string().min(4).max(7 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/), confirm,
}, false, async ({filename, content_type, base64}) => {
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('File exceeds adapter limit.');
  const upload = await api('/files', 'POST', { filename, content_type, size_bytes: bytes.length, intent: 'download' });
  const id = z.uuid().parse(upload.file_id);
  const target = new URL(upload.presigned_put_url, base);
  const own = target.origin === base.origin;
  const r2 = target.protocol === 'https:' && target.hostname.endsWith('.r2.cloudflarestorage.com');
  if ((!own && !r2) || target.username || target.password) throw new Error('Unexpected upload origin.');
  const headers = Object.fromEntries(Object.entries(upload.headers || {}).filter(([k]) => ['content-type', 'content-md5'].includes(k.toLowerCase())));
  // Signed uploads authenticate themselves. Never forward the API key to another origin.
  const response = await fetch(target, { method: 'PUT', body: bytes, headers,
    redirect: 'error', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Champbeam returned HTTP ${response.status}. Upload failed; the file was not finalized.`);
  return api(`/files/${id}/finalize`, 'POST', {});
});
register('content_analytics', 'Read file/page engagement in Personal scope. Estimates are not person identities.', {
  days: z.number().int().min(1).max(365).default(30),
}, true, ({days}) => api(`/analytics/assets?days=${days}&scope=own`));
await server.connect(new StdioServerTransport());
