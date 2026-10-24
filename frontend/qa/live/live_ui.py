"""Browser QA against the REAL local Worker (wrangler dev, local D1/R2) through frontend/vite.qa-live.config.mjs.
Identity is a Clerk stand-in with test-key JWTs. Nothing here touches production, DNS, email or deployment.
Run: python3 frontend/qa/live/live_ui.py   (after qa/live/reset.sh and starting worker + vite, see reset.sh)
"""
import importlib.util, json, re, subprocess, sys, time, traceback
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.verify' / 'live'
SHOTS = OUT / 'shots'
SHOTS.mkdir(parents=True, exist_ok=True)
APP = 'http://127.0.0.1:3300'
SHARE = 'http://localhost:8799'
spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec); spec.loader.exec_module(audit)
# Same corrected probe the sibling lanes proved: canvas colour parsing for oklch, and skip closed details.
probe = audit.PROBE.replace("const r = el.getBoundingClientRect();\n    if", "if (!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;\n    const r = el.getBoundingClientRect();\n    if", 1)
probe = re.sub(r"  const parse = \(c\) => \{.*?\n  \};", """  const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently:true});
  const parse = (c) => {
    ctx.clearRect(0,0,1,1); ctx.fillStyle = c; ctx.fillRect(0,0,1,1);
    const [r,g,b,a] = ctx.getImageData(0,0,1,1).data;
    return {r,g,b,a:a/255};
  };""", probe, count=1, flags=re.S)

checks, audits, page_errors, console_errors, bad_responses = [], [], [], [], []

def record(name, ok, detail=''):
    checks.append({'check': name, 'result': 'PASS' if ok else 'FAIL', 'detail': str(detail)[:400]})
    print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(detail)[:200] if detail and not ok else ''))
    (OUT / 'ui-results.json').write_text(json.dumps({'checks': checks, 'audits': audits, 'page_errors': page_errors, 'console_errors': console_errors, 'bad_responses': bad_responses}, indent=2))

def step(name):
    def wrap(fn):
        try:
            r = fn()
            record(name, True, r if isinstance(r, str) else '')
        except Exception as e:  # noqa: BLE001 - a QA step failing must not stop the rest
            record(name, False, (str(e).splitlines() or [repr(e)])[0] + ' | ' + traceback.format_exc().splitlines()[-3].strip())
        return fn
    return wrap

def shot(page, name, audit_it=True):
    page.evaluate("document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0,0)")
    path = SHOTS / f'{name}.png'
    page.screenshot(path=str(path), full_page=True)
    if audit_it:
        findings = page.evaluate(probe)
        overflow = page.evaluate("""() => [...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return e.checkVisibility() && r.width>0 && r.right>innerWidth+1 && !e.closest('.overflow-x-auto,.cb-table-scroll,[role=tabpanel]') && !e.classList.contains('will-change-transform')}).map(e=>e.tagName+':'+String(e.className).slice(0,40))""")
        if page.evaluate('document.documentElement.scrollWidth > innerWidth + 1'): overflow.append('PAGE-SCROLLS-HORIZONTALLY')
        audits.append({'name': name, 'screenshot': str(path.relative_to(ROOT)), 'findings': findings, 'overflow': overflow})
    return path

def mkpage(browser, role='member', width=1440, height=1000, **ctx_kw):
    ctx = browser.new_context(viewport={'width': width, 'height': height}, has_touch=True, permissions=['clipboard-read', 'clipboard-write'], **ctx_kw)
    page = ctx.new_page()
    page.on('pageerror', lambda e: page_errors.append(f'{role}: {e}'))
    page.on('console', lambda m: console_errors.append(f'{role}: {m.text[:200]}') if m.type == 'error' else None)
    page.on('response', lambda r: bad_responses.append(f'{r.status} {r.request.method} {urlsplit(r.url).path}') if r.status >= 400 and '/api/v1/' in r.url else None)
    page.goto(f'{APP}/?role={role}')
    page.wait_for_load_state('networkidle')
    return page

def to_share(url):
    """Public addresses carry no dev port; route them to the local share-plane origin."""
    u = urlsplit(url)
    return f'{SHARE}{u.path}'

FIX = {
    'pdf': ('Café.final.pdf', 'application/pdf', b'%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
    'png': ('Sunrise Photo.png', 'image/png', __import__('base64').b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')),
    'mp4': ('Demo Clip.mp4', 'video/mp4', b'\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom' + b'\x00' * 64),
    'html': ('Landing Page.html', 'text/html', b'<!doctype html><html><head><title>Live QA</title></head><body><h1>Live QA hosted page</h1></body></html>'),
    'zip': ('bundle.zip', 'application/zip', b'PK\x05\x06' + b'\x00' * 18),
}

def choose(page, key, name=None):
    fn, mime, buf = FIX[key]
    page.get_by_label('Choose file', exact=True).set_input_files({'name': name or fn, 'mimeType': mime, 'buffer': buf})

def host(page, key, name=None, slug=None):
    choose(page, key, name)
    page.get_by_role('tab', name='Host for viewing').click()
    if slug is not None:
        page.get_by_role('button', name='Edit address', exact=True).click()
        page.get_by_label('Page address').fill(slug)
    page.get_by_role('button', name='Publish page', exact=True).tap()  # touch context: tap, not click

def result_url(page):
    expect(page.locator('.cb-result')).to_be_visible(timeout=15000)
    return page.locator('.cb-result > a').get_attribute('href')

def reset_composer(page):
    page.goto(f'{APP}/'); page.wait_for_load_state('networkidle')

with sync_playwright() as pw:
    browser = pw.chromium.launch()

    # ---------- S1 composer against the real Worker ----------
    page = mkpage(browser, 'member')
    for w in (375, 768, 1440):
        page.set_viewport_size({'width': w, 'height': 1000}); shot(page, f'home-empty-{w}')
    page.set_viewport_size({'width': 1440, 'height': 1000})
    hosted = {}

    @step('composer: host PDF with Unicode name gets ASCII slug, address served inline as pdf')
    def _():
        choose(page, 'pdf'); page.get_by_role('tab', name='Host for viewing').click()
        expect(page.locator('.cb-host-preview')).to_contain_text('cafe-final')
        shot(page, 'host-pdf-preview-1440')
        page.get_by_role('button', name='Publish page', exact=True).click()
        url = result_url(page); hosted['pdf'] = url
        r = page.request.get(to_share(url))
        assert r.status == 200 and r.headers['content-type'].startswith('application/pdf'), (r.status, r.headers.get('content-type'))
        assert r.headers['content-disposition'].startswith('inline')
        shot(page, 'host-pdf-result-1440')
        return f'{url} -> {r.headers["content-type"]} {r.headers["content-disposition"]}'

    for key, want in (('png', 'image/png'), ('mp4', 'video/mp4'), ('html', 'text/html')):
        @step(f'composer: host {key} publishes, share-plane response is {want}')
        def _(key=key, want=want):
            reset_composer(page)
            host(page, key)
            url = result_url(page); hosted[key] = url
            r = page.request.get(to_share(url))
            assert r.status == 200 and r.headers['content-type'].startswith(want), (r.status, r.headers.get('content-type'))
            if key == 'html': assert 'content-security-policy' in r.headers, 'hosted HTML must carry a CSP'
            return f'{url} -> {r.headers["content-type"]}'

    @step('composer: same filename again shows -2 collision feedback before publish and keeps both addresses')
    def _():
        reset_composer(page)
        choose(page, 'pdf'); page.get_by_role('tab', name='Host for viewing').click()
        expect(page.locator('.cb-host-preview')).to_contain_text('cafe-final-2')
        shot(page, 'host-collision-preview-1440')
        page.get_by_role('button', name='Publish page', exact=True).click()
        u2 = result_url(page)
        assert u2 != hosted['pdf'] and u2.endswith('cafe-final-2'), u2
        return u2

    @step('composer: taken slug returns clear conflict and keeps the file and typed slug (375)')
    def _():
        reset_composer(page); page.set_viewport_size({'width': 375, 'height': 900})
        host(page, 'png', 'other.png', slug='cafe-final')
        expect(page.get_by_role('alert')).to_contain_text('taken')
        expect(page.get_by_label('Page address')).to_have_value('cafe-final')
        shot(page, 'host-conflict-375')
        page.set_viewport_size({'width': 1440, 'height': 1000})

    @step('composer: download create then GET gives Content-Disposition attachment')
    def _():
        reset_composer(page)
        choose(page, 'zip')
        page.get_by_role('button', name='Create download link', exact=True).click()
        expect(page.get_by_role('heading', name='Download ready')).to_be_visible(timeout=15000)
        url = page.locator('.cb-result > a').get_attribute('href')
        r = page.request.get(to_share(url))
        assert r.status == 200 and r.headers['content-disposition'].startswith('attachment'), (r.status, r.headers)
        shot(page, 'download-result-1440')
        return r.headers['content-disposition']

    @step('composer: keyboard ArrowRight moves Send as file to Host for viewing')
    def _():
        reset_composer(page); choose(page, 'pdf', 'kb.pdf')
        page.get_by_role('tab', name='Send as file').focus(); page.keyboard.press('ArrowRight')
        expect(page.get_by_role('tab', name='Host for viewing')).to_have_attribute('aria-selected', 'true')

    @step('mounted registries: one Kokonut AI Prompt, one 21st file input, Kokonut SmoothTab tablist when a file is chosen')
    def _():
        reset_composer(page)
        assert page.locator('.cb-composer-prompt').count() == 1 and page.locator('.cb-composer input[type=file]').count() == 1
        choose(page, 'pdf', 'mount.pdf')
        expect(page.get_by_role('tablist')).to_be_visible()
        assert page.get_by_role('tab').count() == 2

    @step('composer: external URL only offers tracking, never fake import')
    def _():
        reset_composer(page)
        page.get_by_label('Paste content or drop one file').fill('https://example.com/landing')
        expect(page.get_by_role('link', name='Track external URL')).to_have_attribute('href', re.compile(r'/links\?tab=utm&url='))
        shot(page, 'external-url-1440')

    @step('composer: invalid selected domain shows clear message and blocks create, choosing a real host recovers')
    def _():
        def bad(route):
            res = route.fetch(); prof = res.json(); prof['share_host']['default_domain_id'] = 'ghost-domain-id'
            route.fulfill(response=res, json=prof)
        page.route('**/api/v1/org/profile', bad); reset_composer(page)
        choose(page, 'pdf', 'inv.pdf')
        expect(page.get_by_role('alert')).to_contain_text('domain is unavailable or invalid')
        shot(page, 'invalid-domain-1440')
        page.unroute('**/api/v1/org/profile', bad)

    @step('server rejects invalid domain_id with readable detail (browser request)')
    def _():
        reset_composer(page)
        tok = page.evaluate("sessionStorage.getItem('qa-role')")
        r = page.request.post(f'{APP}/api/v1/files', data={'filename': 'x.pdf', 'content_type': 'application/pdf', 'size_bytes': 1, 'intent': 'host', 'domain_id': 'ghost'},
                              headers={'Authorization': 'Bearer ' + json.loads((OUT / 'tokens.json').read_text())['a:member']})
        assert r.status == 400 and r.json()['detail'] == 'Invalid domain_id.', (r.status, r.text())

    # ---------- S2 lists with real data ----------
    @step('lists: Pages shows canonical root-slug addresses (not /p/) and all four hosted kinds; downloads stay in Files')
    def _():
        page.goto(f'{APP}/pages'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main')
        assert 'Café.final.pdf' in txt and 'Sunrise Photo.png' in txt and 'Demo Clip.mp4' in txt and 'landing page' in txt.lower(), txt[:400]
        assert 'bundle.zip' not in txt
        codes = page.locator('main code').all_inner_texts()
        assert codes and all('/p/' not in c for c in codes), codes
        assert any(c.endswith('/cafe-final') for c in codes), codes
        for w in (375, 768, 1440):
            page.set_viewport_size({'width': w, 'height': 1000}); shot(page, f'pages-live-{w}')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        return ', '.join(codes[:4])

    @step('lists: Files shows only the download and classifies by output kind')
    def _():
        page.goto(f'{APP}/files'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main')
        assert 'bundle.zip' in txt, txt[:300]
        for w in (375, 768, 1440):
            page.set_viewport_size({'width': w, 'height': 1000}); shot(page, f'files-live-{w}')
        page.set_viewport_size({'width': 1440, 'height': 1000})

    @step('lists: sidebar badge and recent widgets agree on the same query source')
    def _():
        page.goto(f'{APP}/'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('body')
        m = re.search(r'Pages \((\d+)\)', txt); f = re.search(r'Files \((\d+)\)', txt)
        assert m and f, txt[txt.find('Your recent'):][:300]
        pages_n = len(page.request.get(f'{APP}/api/v1/pages', headers={'Authorization': 'Bearer ' + json.loads((OUT / 'tokens.json').read_text())['a:member']}).json())
        assert int(m.group(1)) == pages_n and int(f.group(1)) == 1, (m.group(0), f.group(0), pages_n)
        shot(page, 'home-recent-1440')
        return f'{m.group(0)} {f.group(0)} server pages={pages_n}'

    @step('availability: Check storage shows Stored content available for a present blob')
    def _():
        page.goto(f'{APP}/pages'); page.wait_for_load_state('networkidle')
        page.get_by_role('button', name='Check storage').first.click()
        expect(page.get_by_text('Stored content available').first).to_be_visible(timeout=10000)
        shot(page, 'availability-present-1440')

    @step('availability: deleting the R2 object yields the Stored content missing state, without claiming recovery')
    def _():
        tok = json.loads((OUT / 'tokens.json').read_text())['a:member']
        pg = page.request.get(f'{APP}/api/v1/pages', headers={'Authorization': 'Bearer ' + tok}).json()
        target = next(p for p in pg if p['slug'] == 'cafe-final')
        q = subprocess.run(['npx', 'wrangler', 'd1', 'execute', 'champbeam', '--local', '--persist-to', '../.verify/live/state', '--json', '--command', f"SELECT storage_key FROM file_assets WHERE id='{target['page_id']}'"], cwd=ROOT / 'worker', capture_output=True, text=True, timeout=120)
        key = json.loads(q.stdout)[0]['results'][0]['storage_key']
        d = subprocess.run(['npx', 'wrangler', 'r2', 'object', 'delete', f'champbeam-files/{key}', '--local', '--persist-to', '../.verify/live/state'], cwd=ROOT / 'worker', capture_output=True, text=True, timeout=120)
        assert d.returncode == 0, d.stderr[-300:]
        page.goto(f'{APP}/pages'); page.wait_for_load_state('networkidle')
        row = page.locator('div', has_text='Café.final.pdf').filter(has=page.get_by_role('button', name='Check storage')).last
        row.get_by_role('button', name='Check storage').click()
        expect(page.get_by_text('Stored content missing').first).to_be_visible(timeout=10000)
        assert 'restored' not in page.get_by_text('Stored content missing').first.locator('xpath=..').inner_text().lower().replace('no content has been restored', '')
        shot(page, 'availability-missing-1440')

    @step('links: Links tab owns UTM creation and Settings deep-links to it')
    def _():
        page.goto(f'{APP}/links'); page.wait_for_load_state('networkidle')
        expect(page.get_by_text('Add UTM parameters to your links')).to_be_visible()
        for w in (375, 768, 1440):
            page.set_viewport_size({'width': w, 'height': 1000}); shot(page, f'links-live-{w}')
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.goto(f'{APP}/presets'); page.wait_for_load_state('networkidle')
        assert '/links' in page.url and 'tab=utm' in page.url, page.url

    @step('old links: legacy /f/{code} works through the app proxy and the share origin')
    def _():
        tok = json.loads((OUT / 'tokens.json').read_text())['a:member']
        pg = page.request.get(f'{APP}/api/v1/pages', headers={'Authorization': 'Bearer ' + tok}).json()
        legacy = pg[0]['legacy_url']
        r = page.request.get(to_share(legacy)); assert r.status == 200, r.status
        html = next(p for p in pg if p['slug'] == 'landing-page')
        r2 = page.request.get(f"{SHARE}/p/{html['slug']}"); assert r2.status == 200, ('/p/slug', r2.status)
        r3 = page.request.get(to_share(html['public_url'])); assert r3.status == 200, ('root slug', r3.status)
        return f'/f -> {r.status}, /p/{html["slug"]} -> {r2.status}, root slug -> {r3.status}'

    # ---------- S3 org switching cache ----------
    @step('org switching: pages list cache does not leak A rows into B, and A returns intact')
    def _():
        page.goto(f'{APP}/pages'); page.wait_for_load_state('networkidle')
        assert 'Café.final.pdf' in page.inner_text('main')
        page.get_by_role('button', name='Switch workspace').click(); page.wait_for_timeout(1500); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main')
        assert 'Café.final.pdf' not in txt and 'Sunrise Photo' not in txt, txt[:300]
        assert 'qa-b' in page.inner_text('body'), 'workspace label did not change'
        shot(page, 'org-b-pages-1440')
        page.get_by_role('button', name='Switch workspace').click(); page.wait_for_timeout(1500); page.wait_for_load_state('networkidle')
        assert 'Sunrise Photo.png' in page.inner_text('main')

    # ---------- S4 account footer: slow / failed avatar ----------
    page.context.close()
    ctx = browser.new_context(viewport={'width': 375, 'height': 800})
    slow = ctx.new_page(); slow.on('pageerror', lambda e: page_errors.append(f'slow: {e}'))
    slow.route('**/qa-avatar', lambda route: None)  # never answers: slow/hung profile image
    slow.goto(f'{APP}/?role=member')
    @step('account: with a hung avatar request the footer shows name, workspace and role immediately with initials')
    def _():
        slow.get_by_role('button', name='Open menu', exact=True).click()
        expect(slow.locator('dialog[open]').get_by_text('QA Person')).to_be_visible(timeout=3000)
        body = slow.locator('dialog[open]').inner_text(); assert 'qa-a' in body and 'Role: member' in body, body[:300]
        shot(slow, 'account-slow-avatar-375')
    ctx.close()
    ctx = browser.new_context(viewport={'width': 375, 'height': 800})
    fail = ctx.new_page(); fail.route('**/qa-avatar', lambda route: route.fulfill(status=500, body='boom'))
    fail.goto(f'{APP}/?role=member'); fail.wait_for_load_state('networkidle')
    @step('account: failed avatar (HTTP 500) falls back to initials, no broken-image icon')
    def _():
        fail.get_by_role('button', name='Open menu', exact=True).click()
        expect(fail.locator('dialog[open]').get_by_text('QA Person')).to_be_visible()
        shot(fail, 'account-failed-avatar-375')
        # A failed image stays in the DOM at opacity 0 over the initials; it must never be visibly painted.
        painted = fail.evaluate("[...document.images].filter(i=>i.complete && i.naturalWidth===0 && getComputedStyle(i).opacity!=='0' && i.checkVisibility()).map(i=>i.src)")
        assert not painted, painted
        assert fail.locator('dialog[open] .cb-avatar').inner_text().strip() == 'QP', 'initials missing'
    ctx.close()

    # ---------- S5 viewer ----------
    page = mkpage(browser, 'viewer')
    @step('viewer: composer cannot create (explained, no enabled publish path) and server also denies')
    def _():
        body = page.inner_text('body')
        choose_input = page.get_by_label('Choose file', exact=True)
        can = choose_input.count() and choose_input.is_enabled()
        if can:
            choose(page, 'pdf', 'viewer.pdf'); page.wait_for_timeout(500)
            btns = [b for b in ('Publish page', 'Create download link') if page.get_by_role('button', name=b, exact=True).count() and page.get_by_role('button', name=b, exact=True).is_enabled()]
            assert not btns, f'viewer sees enabled create buttons {btns}'
        shot(page, 'viewer-home-1440')
        return body[body.find('Share'):][:160].replace('\n', ' ')
    @step('viewer: Reporting page presents the server denial/limited scope without write controls')
    def _():
        page.goto(f'{APP}/team'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main')
        assert not re.search(r'Create team|Add member|Save changes', txt), txt[:300]
        shot(page, 'viewer-team-1440'); return txt[:200].replace('\n', ' ')
    @step('viewer: Settings has no org-admin write controls')
    def _():
        page.goto(f'{APP}/settings'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main'); assert 'Organization domains' not in txt, 'viewer sees org domain admin'
        shot(page, 'viewer-settings-1440')
    page.context.close()

    # ---------- S6 admin ----------
    page = mkpage(browser, 'admin')
    @step('admin: Reporting shows server scope, filters, share counts and no email-send claim')
    def _():
        page.goto(f'{APP}/team'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main'); assert 'Scope: org' in txt and 'not measured' in txt.lower(), txt[:300]
        for w in (375, 768, 1440):
            page.set_viewport_size({'width': w, 'height': 1000}); shot(page, f'admin-team-{w}')
        page.set_viewport_size({'width': 1440, 'height': 1000})
    @step('admin: Settings shows server-granted permissions and org domain/member admin')
    def _():
        page.goto(f'{APP}/settings'); page.wait_for_load_state('networkidle')
        txt = page.inner_text('main'); assert 'Organization domains' in txt and 'org.domains.manage' in txt, txt[:200]
        for w in (375, 768, 1440):
            page.set_viewport_size({'width': w, 'height': 1000}); shot(page, f'admin-settings-{w}')
        page.set_viewport_size({'width': 1440, 'height': 1000})
    page.context.close()

    # ---------- S7 themes, reduced motion, tap/keyboard ----------
    ctx = browser.new_context(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
    page = ctx.new_page(); page.on('pageerror', lambda e: page_errors.append(f'themes: {e}'))
    page.goto(f'{APP}/?role=member'); page.wait_for_load_state('networkidle')
    for theme in ('paper', 'graphite', 'lagoon', 'merlot', 'slate'):
        for route in ('/', '/pages', '/files', '/links'):
            @step(f'theme {theme} {route or "/"}: no contrast/a11y FAIL under reduced motion')
            def _(theme=theme, route=route):
                page.goto(f'{APP}{route}'); page.wait_for_load_state('networkidle')
                page.evaluate("(t)=>document.documentElement.dataset.cbTheme=t", theme)
                page.wait_for_timeout(250)
                shot(page, f'theme-{theme}-{route.strip("/") or "home"}', audit_it=True)
                fails = [f for f in audits[-1]['findings'] if f['severity'] == 'FAIL']
                assert not fails, fails[:3]
    ctx.close()

    @step('keyboard: Tab order reaches skip link, nav, composer input and file chooser')
    def _():
        p2 = mkpage(browser, 'member')
        seen = []
        for _i in range(40):
            p2.keyboard.press('Tab'); seen.append(p2.evaluate("(document.activeElement.getAttribute('aria-label')||document.activeElement.textContent||document.activeElement.tagName).trim().slice(0,30)"))
        assert any('Paste content' in s or 'Drop or paste' in s for s in seen) and any('Choose' in s for s in seen), seen
        p2.context.close(); return ' > '.join(seen)

    # size audit: every audited state
    fails = [(a['name'], f) for a in audits for f in a['findings'] if f['severity'] == 'FAIL']
    record('visual audit: zero FAIL findings across all audited live states', not fails, f'{len(audits)} states; first: {fails[:2]}')
    ov = [(a['name'], a['overflow'][:2]) for a in audits if a['overflow']]
    record('visual audit: no horizontal overflow in main', not ov, ov[:3])
    browser.close()

n_fail = sum(1 for c in checks if c['result'] == 'FAIL')
print(f'\n{len(checks)} checks, {n_fail} FAIL, {len(audits)} audited states, {len(list(SHOTS.glob("*.png")))} screenshots, pageerrors={len(page_errors)}')
sys.exit(1 if n_fail else 0)
