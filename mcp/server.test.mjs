// Run against a disposable local Worker only: CHAMPBEAM_TEST_URL=http://127.0.0.1:3187 npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const base = process.env.CHAMPBEAM_TEST_URL;
test('real MCP protocol: confirmed writes, list, analytics, validation and key revocation', { skip: !base }, async () => {
  const origin = new URL(base);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname), 'Tests may only write to loopback');
  const email = `mcp-${crypto.randomUUID()}@example.invalid`;
  const signup = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({name:'MCP test',email,password:crypto.randomUUID()}) });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.getSetCookie().map(s=>s.split(';')[0]).join('; ');
  const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' };
  const created = await fetch(`${base}/api/v1/api-keys`, { method:'POST',headers,body:JSON.stringify({name:'Disposable MCP test'}) });
  assert.equal(created.status, 201);
  const key = await created.json();
  const transport = new StdioClientTransport({ command: process.execPath, args: [new URL('./server.mjs',import.meta.url).pathname], env: { CHAMPBEAM_BASE_URL:base, CHAMPBEAM_API_KEY:key.api_key }, stderr:'pipe' });
  const client = new Client({name:'champbeam-protocol-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length,5);
    const call = async (name,args) => { const r = await client.callTool({name,arguments:args}); assert.ok(!r.isError, r.content?.[0]?.text); return JSON.parse(r.content[0].text); };
    const refused = await client.callTool({name:'publish_page',arguments:{html:'<h1>not confirmed</h1>',title:'Not allowed'}});
    assert.equal(refused.isError,true);
    const page = await call('publish_page',{html:'<!doctype html><html><body><h1>MCP protocol page</h1></body></html>',title:'MCP protocol page',confirm:true});
    assert.ok(page.page_id && page.url);
    const link = await call('create_link',{url:'https://example.com/mcp-test',utm_source:'protocol-test',confirm:true});
    assert.ok(link.link_id && link.short_url);
    const file = await call('upload_file',{filename:'protocol.txt',content_type:'text/plain',base64:Buffer.from('Real protocol test').toString('base64'),confirm:true});
    assert.ok(file.id && file.serve_url);
    const pages = await call('list_shares',{kind:'pages'});
    assert.ok(pages.some(p=>p.page_id===page.page_id));
    const report = await call('content_analytics',{days:30});
    assert.equal(report.summary.asset_count,2);
    assert.equal(report.summary.opens,0);
    const revoke = await fetch(`${base}/api/v1/api-keys/${key.id}/revoke`, {method:'POST',headers,body:'{}'});
    assert.equal(revoke.status,200);
    const denied = await client.callTool({name:'list_shares',arguments:{kind:'files'}});
    assert.equal(denied.isError,true);
    assert.match(denied.content[0].text,/401/);
  } finally {
    await client.close();
    await fetch(`${base}/api/v1/api-keys/${key.id}/revoke`,{method:'POST',headers,body:'{}'});
  }
});
