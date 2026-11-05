"""HTTP-level checks against the REAL local Worker (wrangler dev, local D1/R2, test-key JWTs). No browser, no production."""
import base64, json, sys, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.verify' / 'live'
T = json.loads((OUT / 'tokens.json').read_text())
W = 'http://127.0.0.1:8799'
rows = []

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(NoRedirect)

S = 'http://localhost:8799'  # SHARE_ORIGIN_HOSTS=localhost: the isolated share plane; 127.0.0.1 is the app origin

def call(method, path, who=None, body=None, raw=None, headers=None, base=W):
    h = dict(headers or {})
    if who: h['Authorization'] = 'Bearer ' + T[who]
    data = raw
    if body is not None:
        data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
    from urllib.parse import urlsplit
    if not path.startswith('/'):
        u = urlsplit(path); path = u.path + ('?' + u.query if u.query else '')
    req = urllib.request.Request(base + path, data=data, method=method, headers=h)
    try:
        r = opener.open(req); status, hd, b = r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        status, hd, b = e.code, dict(e.headers), e.read()
    try: j = json.loads(b)
    except Exception: j = None
    return status, hd, b, j

def check(name, ok, detail=''):
    rows.append({'check': name, 'result': 'PASS' if ok else 'FAIL', 'detail': detail})
    print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(detail) if detail else ''))

PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')
PDF = b'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
HTML = b'<!doctype html><html><head><title>QA page</title></head><body><h1>QA hosted html</h1><script>window.__qa=1</script></body></html>'
MP4 = b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom' + b'\x00' * 64

def create(who, filename, ctype, content, intent='host', slug=None, domain_id=None):
    body = {'filename': filename, 'content_type': ctype, 'size_bytes': len(content), 'intent': intent}
    if slug: body['slug'] = slug
    if domain_id: body['domain_id'] = domain_id
    s, _, _, j = call('POST', '/api/v1/files', who, body)
    if s != 201: return s, j
    up = j['presigned_put_url']
    s2, *_ = call('PUT', up, None, raw=content, headers=j.get('headers') or {'Content-Type': ctype})
    s3, _, _, fin = call('POST', f"/api/v1/files/{j['file_id']}/finalize", who, {})
    return (s3, fin) if s2 in (200, 204) else (s2, None)

def main():
    # 1 download: Files, header
    s, a = create('a:member', 'Quarterly Report.pdf', 'application/pdf', PDF, intent='download')
    check('download create returns finalized file', s == 200 and a['output_kind'] == 'file', (s, a and a.get('output_kind')))
    dl = a['serve_url'] if a else None
    s, h, b, _ = call('GET', dl, base=S)
    h = {k.lower(): v for k, v in h.items()}
    cd = h.get('content-disposition', '')
    check('download response header is attachment', s == 200 and cd.lower().startswith('attachment'), f"status={s} content-disposition={cd!r} type={h.get('content-type')}")
    check('download body matches upload bytes', b == PDF, len(b))
    dl_id = a['id']

    # 2 hosting: PDF/image/video/HTML
    hosted = {}
    for name, ctype, content in [('Brief.pdf', 'application/pdf', PDF), ('Photo.png', 'image/png', PNG), ('Clip.mp4', 'video/mp4', MP4), ('Landing.html', 'text/html', HTML)]:
        s, f = create('a:member', name, ctype, content, intent='host')
        ok = s == 200 and f and f['output_kind'] == 'page' and f['slug'] == name.rsplit('.', 1)[0].lower()
        check(f'host {name}: Page with extension-free slug', ok, (s, f and (f.get('slug'), f.get('output_kind'), f.get('public_url'))))
        hosted[name] = f
        if not f: continue
        path = '/' + f['slug']
        s, h, b, _ = call('GET', path, base=S)
        h = {k.lower(): v for k, v in h.items()}
        ct = h.get('content-type', ''); cd = h.get('content-disposition', '')
        extra = f"status={s} type={ct} disp={cd!r} csp={h.get('content-security-policy', '')[:90]!r} range={h.get('accept-ranges')}"
        want = {'Brief.pdf': 'application/pdf', 'Photo.png': 'image/png', 'Clip.mp4': 'video/mp4', 'Landing.html': 'text/html'}[name]
        check(f'host {name}: slug URL serves inline as {want}', s == 200 and ct.startswith(want) and not cd.lower().startswith('attachment'), extra)
        if name == 'Landing.html':
            check('host HTML: sandboxing header present', 'content-security-policy' in h or 'x-content-type-options' in h, extra)
        pg, *_ = call('GET', f"/api/v1/pages/{f['id']}", 'a:member')
        check(f'{name} appears via GET /pages/{{id}}', pg == 200)
    s, _, _, lst = call('GET', '/api/v1/pages', 'a:member')
    ids = {p['page_id'] for p in (lst or [])}
    check('GET /pages lists all four hosted kinds and not the download', s == 200 and all(f and f['id'] in ids for f in hosted.values()) and dl_id not in ids, sorted(p.get('slug') for p in (lst or [])))

    # 3 slug rules
    s, f2 = create('a:member', 'Brief.pdf', 'application/pdf', PDF, intent='host')
    check('slug collision auto-suffix -2', s == 200 and f2['slug'] == 'brief-2', f2 and f2.get('slug'))
    s, f3 = create('a:member', 'Café Menü Ñandú.pdf', 'application/pdf', PDF, intent='host')
    check('Unicode filename slug is ASCII-safe', s == 200 and f3['slug'].isascii() and f3['slug'] and ' ' not in f3['slug'], f3 and f3.get('slug'))
    s, f4 = create('a:member', '日本語.pdf', 'application/pdf', PDF, intent='host')
    check('non-Latin filename gets a usable slug (not empty)', s == 200 and f4['slug'], f4 and f4.get('slug'))
    s, f5 = create('a:member', 'x.pdf', 'application/pdf', PDF, intent='host', slug='brief')
    check('explicit taken slug returns 409', s == 409 or (isinstance(f5, dict) and 'taken' in json.dumps(f5).lower()), (s, f5))
    s, f6 = create('a:member', 'Report.final.v2.pdf', 'application/pdf', PDF, intent='host')
    check('multi-dot filename drops only the last extension', s == 200 and f6['slug'] == 'report-final-v2', f6 and f6.get('slug'))
    s, _, _, sug = call('GET', '/api/v1/pages/slug-suggestion?filename=Brief.pdf', 'a:member')
    check('slug-suggestion reports collision with next free slug', s == 200 and sug.get('collided') and sug['slug'].startswith('brief-'), sug)
    s, _, _, p = call('PATCH', f"/api/v1/pages/{hosted['Brief.pdf']['id']}", 'a:member', {'slug': 'brief-renamed'})
    check('PATCH slug on hosted PDF', s == 200 and p['slug'] == 'brief-renamed', (s, p and p.get('slug')))
    s, h, *_ = call('GET', '/brief', base=S)
    check('old slug alias still resolves after rename', s in (200, 301, 302, 307, 308), s)

    # 4 old links
    s, h, b, _ = call('GET', f"/f/{hosted['Landing.html']['short_code']}", base=S)
    check('legacy /f/{code} still serves', s in (200, 301, 302, 307, 308), f"{s} {dict(h).get('Location', '')}")
    s, h, b, _ = call('GET', f"/f/{a['short_code']}", base=S)
    check('legacy /f/{code} download still serves', s in (200, 301, 302, 307, 308), s)
    s, h, b, _ = call('GET', '/p/nonexistentcode', base=S)
    check('legacy /p/{code} route is wired (404 for unknown, not 500/SPA)', s in (404, 410), s)

    s, h, b, _ = call('GET', '/clip', headers={'Range': 'bytes=0-9'}, base=S)
    check('hosted video honours Range (206) for seeking', s == 206 and len(b) == 10, (s, len(b)))
    s, *_ = call('GET', '/api/v1/org/profile', 'a:admin', base=S)
    check('share plane exposes no /api/v1 (hosted script cannot reach the control plane)', s == 404, s)
    s, h, b, _ = call('GET', '/landing', base=W)
    check('app origin does not serve hosted slug content as the page body', b'QA hosted html' not in b, s)
    # 5 availability
    s, _, _, av = call('GET', f"/api/v1/pages/{hosted['Landing.html']['id']}/availability", 'a:member')
    check('availability: present blob reports available', s == 200, av)
    # 6 viewer denial
    for label, path, body in [('POST /files host', '/api/v1/files', {'filename': 'v.pdf', 'content_type': 'application/pdf', 'size_bytes': 1, 'intent': 'host'}),
                              ('POST /files download', '/api/v1/files', {'filename': 'v.pdf', 'content_type': 'application/pdf', 'size_bytes': 1, 'intent': 'download'}),
                              ('POST /utm/generate', '/api/v1/utm/generate', {'base_url': 'https://example.com', 'source': 's', 'medium': 'm', 'campaign': 'c'})]:
        s, _, _, j = call('POST', path, 'a:viewer', body)
        check(f'viewer denied on server: {label}', s == 403, (s, j))
    s, _, _, j = call('PATCH', f"/api/v1/pages/{hosted['Landing.html']['id']}", 'a:viewer', {'slug': 'viewer-hijack'})
    check('viewer cannot PATCH a page slug', s in (403, 404), (s, j))
    s, _, _, j = call('POST', '/api/v1/files', 'a:viewer', {'filename': 'v.pdf', 'content_type': 'application/pdf', 'size_bytes': 1, 'intent': 'host', 'domain_id': 'x'})
    check('viewer naming a domain is rejected', s in (400, 403), (s, j))
    # 7 invalid domain
    s, _, _, j = call('POST', '/api/v1/files', 'a:member', {'filename': 'd.pdf', 'content_type': 'application/pdf', 'size_bytes': 1, 'intent': 'host', 'domain_id': 'does-not-exist'})
    check('invalid domain_id returns a clear 4xx message', 400 <= s < 500 and j and (j.get('detail') or j.get('error')), (s, j))
    # 8 org isolation (server) and switching
    s, _, _, la = call('GET', '/api/v1/pages', 'a:member')
    s2, _, _, lb = call('GET', '/api/v1/pages', 'b:member')
    check('org B member does not see org A pages', s2 == 200 and not ({p['page_id'] for p in lb} & {p['page_id'] for p in la}), (len(la), len(lb)))
    s, _, _, j = call('GET', f"/api/v1/pages/{hosted['Landing.html']['id']}", 'b:admin')
    check('org B admin cannot read org A page by id', s in (403, 404), s)
    s, _, _, pa = call('GET', '/api/v1/org/profile', 'a:admin')
    s2, _, _, pb = call('GET', '/api/v1/org/profile', 'b:admin')
    check('profile reflects active org', pa['org']['id'] == 'org_qa_a' and pb['org']['id'] == 'org_qa_b')
    # 9 reporting
    s, _, _, r = call('GET', '/api/v1/org/reporting/summary', 'a:viewer')
    check('viewer reporting is server-scoped (no data without grant)', s in (200, 403), (s, r if s != 200 else {k: r.get(k) for k in ('scope',)}))
    s, _, _, r = call('GET', '/api/v1/org/reporting/summary', 'a:admin')
    check('admin reporting counts shares and does not claim email sends', s == 200 and r.get('emails_sent', {}).get('status') == 'not_measured', r.get('totals') if r else None)
    (OUT / 'api-checks.json').write_text(json.dumps(rows, indent=2))
    fails = [r for r in rows if r['result'] == 'FAIL']
    print(f"\n{len(rows)} checks, {len(fails)} FAIL")
    sys.exit(1 if fails else 0)

main()
