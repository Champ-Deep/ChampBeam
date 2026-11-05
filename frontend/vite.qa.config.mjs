import { defineConfig, mergeConfig } from 'vite';
import base from './vite.config.ts';
import { fileURLToPath } from 'node:url';

// Isolated visual QA server. This config is never used by npm run build.
const assets = new Map();
const links = new Map();
const origin = 'http://127.0.0.1:3198';
const fixturePage = (a) => ({ page_id:a.id, short_code:a.short_code, slug:a.slug, public_url:a.public_url, url:a.public_url, legacy_url:`${origin}/f/${a.short_code}`, title:a.filename, size_bytes:a.size_bytes, view_count:0, unique_visitors:0, revisits:0, total_dwell_ms:0, enabled:true, has_access_code:false, domain_id:null, created_at:a.created_at, updated_at:a.created_at, current_version:1 });
export default mergeConfig(base, defineConfig({
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('/api/v1') },
  resolve: { alias: { '@clerk/react': fileURLToPath(new URL('./qa/clerk.jsx', import.meta.url)) } },
  server: { host:'127.0.0.1', port:3198, strictPort:true },
  plugins: [{ name:'explicit-qa-fixtures', configureServer(server) {
    server.middlewares.use(async (req,res,next) => {
      const url = new URL(req.url, origin);
      if (url.pathname === '/qa-avatar') { res.setHeader('Content-Type','text/plain'); res.end('intentionally invalid avatar fixture'); return; }
      if (!url.pathname.startsWith('/api/v1/')) return next();
      const [,role='member',org='fixture-a',state=''] = (req.headers.authorization || 'fixture:member:fixture-a:').replace('Bearer ','').split(':');
      const path = url.pathname.replace('/api/v1','');
      const rows = assets.get(org) || [];
      let body = '';
      for await (const chunk of req) body += chunk;
      let input = {}; try { input = JSON.parse(body || '{}'); } catch { /* Multipart and raw upload fixtures. */ }
      const send = (value,status=200) => { res.statusCode=status; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value)); };
      if (path === '/qa-reset') { assets.clear(); links.clear(); return send({ reset:true }); }
      if (path === '/org/profile') {
        if (state === 'auth-error') return send({detail:'Fixture session rejected'},401);
        return send({user_id:'fixture-user', full_name:'Fixture Member', email:'fixture@example.invalid', org:{id:org,name:`Fixture workspace ${org}`,slug:org}, role, permissions:role === 'viewer' ? [] : role === 'admin' ? ['share.create','report.org','team.manage','org.members.manage','org.domains.manage','org.viewers.grant'] : ['share.create','report.own'], report_scope:role === 'member' ? 'own' : 'org', share_host:{default:'verified-fixture.example',default_domain_id:'fixture-domain'}, available_hosts:[{id:'fixture-domain',hostname:'verified-fixture.example',org_default:true}]});
      }
      if (path === '/pages/slug-suggestion') {
        if(url.searchParams.get('domain_id') === 'invalid') return send({detail:'Invalid domain'},400);
        const base=(url.searchParams.get('filename') || 'page.html').replace(/\.[^.]+$/,'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'') || 'page';
        const collided=rows.some((a)=>a.slug===base); const slug=collided?`${base}-2`:base;
        return send({slug,base,collided,host:'verified-fixture.example',public_url:`${origin}/${slug}`});
      }
      if(path === '/files' && req.method === 'GET') return send(rows);
      if(path === '/pages' && req.method === 'GET') {
        if(state === 'pages-error') return send({detail:'Fixture storage service unavailable'},503);
        if(state === 'pages-auth') return send({detail:'Fixture page permission denied'},403);
        return send(rows.filter((a)=>a.intent==='host').map(fixturePage));
      }
      if((path === '/files' || path === '/pages') && req.method === 'POST') {
        if(role === 'viewer') return send({detail:'Fixture viewer cannot create'},403);
        if(input.slug === 'taken' || rows.some((a)=>input.slug && a.slug === input.slug)) return send({detail:'That slug is taken.'},409);
        const id=`fixture-${rows.length+1}`; const host=input.intent==='host'||path==='/pages'; const stamp='2026-10-24T00:00:00.000Z';
        const a={id,short_code:id,filename:input.filename||'Fixture HTML',kind:path==='/pages'?'html':input.content_type?.includes('pdf')?'pdf':input.content_type?.startsWith('image/')?'image':input.content_type?.startsWith('video/')?'video':'other',mime_type:input.content_type||'text/html',intent:host?'host':'download',output_kind:host?'page':'file',slug:input.slug,size_bytes:input.size_bytes||50,created_at:stamp,status:'active',view_count:0,serve_url:`${origin}/f/${id}`,public_url:host?`${origin}/${input.slug}`:`${origin}/f/${id}`,domain_id:'fixture-domain'};
        assets.set(org,[a,...rows]);
        return send(path==='/pages'?fixturePage(a):{file_id:id,short_code:id,presigned_put_url:`${origin}/api/v1/qa-upload`,headers:{},upload_via_backend:true,serve_mode:'stream'},201);
      }
      if(path === '/qa-upload') return send({},204);
      if(path.match(/^\/files\/[^/]+\/finalize$/)) return send(rows.find((a)=>a.id===path.split('/')[2]));
      if(path.match(/^\/pages\/[^/]+$/) && req.method==='PATCH') { const a=rows.find((a)=>a.id===path.split('/')[2]); if(input.slug==='taken')return send({detail:'That slug is taken.'},409); Object.assign(a,input); if(input.slug)a.public_url=`${origin}/${input.slug}`; return send(fixturePage(a)); }
      if(path === '/utm/generate') { const item={link_id:`fixture-link-${(links.get(org)||[]).length}`,original_url:input.base_url,redirect_url:`${origin}/r/fixture`,created_at:'2026-10-24T00:00:00Z',click_count:0,...input}; links.set(org,[item,...(links.get(org)||[])]);return send({...item,tracked_url:input.base_url,short_code:'fixture',utm_params:{}}); }
      if(path === '/utm/analytics/links') return send(links.get(org)||[]);
      if(path === '/org/reporting/summary') { if(url.searchParams.get('team')==='outside')return send({detail:'That team is outside your reporting scope.'},403); const totals={shares_created:rows.length,opens:0,clicks:0}; return send({scope:role==='member'?'own':'org',totals,by_kind:{file:totals,page:totals,link:totals},by_member:[],emails_sent:{status:'not_measured',count:null,note:'Fixture report. Beam does not send email.'}}); }
      if(path === '/org/domains') return send([{id:'fixture-domain',hostname:'verified-fixture.example',status:'active',is_org_default:true}]);
      if(path === '/domains') return send([{id:'fixture-domain',hostname:'verified-fixture.example',status:'active'}]);
      if(path === '/org/members') return send([{user_id:'fixture-user',full_name:'Fixture Member',role:'member',leader_user_id:null,shares:0,opens:0,unique_opens:0}]);
      if(path === '/org/context') return send({name:'Fixture workspace',member_count:1});
      if(path === '/org/analytics/content') return send({items:[],total_content:0,total_shares:0,total_opens:0});
      if(path === '/domains/config') return send({});
      if(path === '/system/access') return send({is_admin:false});
      if(path.endsWith('/config')) return send({configured:false,enabled:false});
      return send([]);
    });
  } }],
}));
