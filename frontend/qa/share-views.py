"""Explicit local response fixtures. No production access or recovery claims."""
import importlib.util
import json
import re
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.verify' / 't_e3120ef6'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'http://127.0.0.1:3198'
spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
# Normalize browser color spaces and exclude closed details in the local audit.
probe = audit.PROBE.replace("const r = el.getBoundingClientRect();\n    if", "if (!el.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return false;\n    const r = el.getBoundingClientRect();\n    if", 1)
probe = re.sub(r"  const parse = \(c\) => \{.*?\n  \};", """  const ctx = document.createElement('canvas').getContext('2d', {willReadFrequently:true});
  const parse = (c) => {
    ctx.clearRect(0,0,1,1); ctx.fillStyle = c; ctx.fillRect(0,0,1,1);
    const [r,g,b,a] = ctx.getImageData(0,0,1,1).data;
    return {r,g,b,a:a/255};
  };""", probe, count=1, flags=re.S)
checks, shots, errors, console_errors, availability_requests, pending, theme_audits = [], [], [], [], [], [], []
state = {'pages': 'populated', 'links_error': False, 'presets': [], 'availability': 'loading'}
stamp = '2026-10-24T00:00:00Z'
assets = [{'id': f'fixture-{kind}', 'kind': kind, 'filename': f'Fixture {kind}', 'intent': 'host', 'output_kind': 'page', 'status': 'active', 'created_at': stamp} for kind in ['html', 'pdf', 'image', 'video']]
assets += [{'id': 'fixture-download', 'filename': 'Fixture download.pdf', 'kind': 'pdf', 'intent': 'download', 'output_kind': 'file', 'status': 'active', 'created_at': stamp, 'size_bytes': 10, 'serve_url': 'https://example.invalid/f/fixture-download'}]
pages = [{'page_id': a['id'], 'title': a['filename'], 'short_code': a['id'], 'url': f"https://example.invalid/p/{a['id']}", 'legacy_url': f"https://example.invalid/f/{a['id']}", 'slug': a['id'], 'enabled': True, 'size_bytes': 10, 'view_count': 0, 'unique_visitors': 0, 'revisits': 0, 'total_dwell_ms': 0, 'updated_at': stamp, 'current_version': 0} for a in assets if a['intent'] == 'host']
links = [{'link_id': f'fixture-link-{i}', 'original_url': f'https://example.invalid/fixture-{i}', 'redirect_url': f'https://example.invalid/r/fixture-{i}', 'created_at': stamp, 'click_count': 0, 'unique_clicks': 0} for i in range(3)]

def snapshot(page, name):
    page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
    page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
    findings = page.evaluate(probe)
    raw_findings = page.evaluate(audit.PROBE)
    overflow = page.evaluate("""() => [...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return e.checkVisibility() && r.width>0 && r.right>innerWidth+1 && !e.closest('.overflow-x-auto')}).map(e=>e.tagName+':'+e.className)""")
    shots.append({'name': name, 'audit': findings, 'raw_audit': raw_findings, 'overflow': overflow})
    save()

def save():
    (OUT / 'results.json').write_text(json.dumps({'fixture_only': True, 'checks': checks, 'pageerrors': errors, 'console_errors': console_errors, 'availability_requests': availability_requests, 'shots': shots, 'theme_audits': theme_audits}, indent=2))

with sync_playwright() as pw:
    browser = pw.chromium.launch()
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, reduced_motion='reduce')
    page.set_content('<body style="background:white"><p style="color:oklch(0 0 0)">Readable control</p><p style="color:oklch(1 0 0)">Invisible control</p><details><summary>Closed details</summary><button style="width:44px;height:44px"></button></details></body>')
    self_check = page.evaluate(probe)
    contrast = [f for f in self_check if f['rule'] == 'contrast']
    assert len(contrast) == 1 and 'Invisible control' in contrast[0]['where']
    assert not any(f['rule'] == 'a11y-name' for f in self_check)
    page.locator('summary').click()
    assert any(f['rule'] == 'a11y-name' for f in page.evaluate(probe))
    page.add_init_script("window.Clerk = { session: { id: 'explicit-local-fixture-session' } }")
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    def route(req):
        path = req.request.url.split('/api/v1')[-1].split('?')[0]
        data, status = None, 200
        if path.endswith('/availability'):
            availability_requests.append(path)
            mode = state['availability']
            if mode == 'loading':
                pending.append(req)
                return
            if isinstance(mode, int): data, status = {'detail': 'Explicit fixture availability error'}, mode
            elif mode == 'available': data = {'status': 'available', 'size': 10, 'etag': 'fixture-etag'}
            else: data = {'status': 'missing'}
        elif path == '/pages':
            if state['pages'] == 'error': data, status = {'detail': 'Explicit fixture storage outage'}, 503
            elif state['pages'] == 'auth': data, status = {'detail': 'Explicit fixture authorization failure'}, 403
            else: data = [] if state['pages'] == 'empty' else pages
        elif path == '/files': data = assets
        elif path == '/utm/analytics/links':
            data = {'detail': 'Explicit fixture link outage'} if state['links_error'] else links
            status = 503 if state['links_error'] else 200
        elif path == '/utm/presets':
            if req.request.method == 'POST': state['presets'].append({'id': 'fixture-preset', **req.request.post_data_json})
            data = state['presets'][-1] if req.request.method == 'POST' else state['presets']
        if data is None: req.continue_()
        else: req.fulfill(status=status, json=data)
    page.route('**/api/v1/**', route)
    for width in [375, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        page.goto(BASE + '/pages')
        expect(page.get_by_text('Fixture video', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Replace', exact=True)).to_have_count(1)
        expect(page.get_by_text('Fixture download.pdf', exact=True)).to_have_count(0)
        expect(page.get_by_text('Enabled', exact=True)).to_have_count(4)
        snapshot(page, f'pages-{width}')
    checks.append('Four hosted media kinds, HTML-only actions, no download rows at 375/768/1440')
    for mode, text in [('empty', 'No pages yet'), ('error', 'Pages could not load'), ('auth', 'Page access failed')]:
        state['pages'] = mode
        page.set_viewport_size({'width': 375, 'height': 1000})
        page.goto(BASE + '/pages')
        expect(page.get_by_text(text, exact=True)).to_be_visible()
        snapshot(page, f'pages-{mode}')
    state['pages'] = 'populated'
    page.get_by_role('button', name='Retry pages').click()
    expect(page.get_by_text('Fixture video', exact=True)).to_be_visible()
    checks.append('Pages empty, request-error, authorization-error and successful retry')
    assert not availability_requests, 'Availability must not fan out with the list'
    page.get_by_role('button', name='Check storage', exact=True).first.click()
    expect(page.get_by_text('Checking stored content...', exact=True)).to_be_visible()
    snapshot(page, 'storage-loading')
    assert availability_requests == ['/pages/fixture-html/availability']
    pending.pop().fulfill(json={'status': 'missing'})
    expect(page.get_by_text('Stored content missing', exact=True)).to_be_visible()
    snapshot(page, 'storage-missing')
    for mode, text in [(401, 'Storage access failed'), (403, 'Storage access failed'), (404, 'Page record unavailable'), (503, 'Storage check unavailable'), ('available', 'Stored content available')]:
        state['availability'] = mode
        page.get_by_role('button', name='Retry storage check').click()
        expect(page.get_by_text(text, exact=True)).to_be_visible()
        expect(page.get_by_text('Stored content missing', exact=True)).to_have_count(0)
        snapshot(page, f'storage-{mode}')
    expect(page.get_by_role('link', name='Open page', exact=True)).to_have_attribute('href', pages[0]['url'])
    checks.append('Storage is lazy per item; loading, missing, 401, 403, 404, 503 and available are distinct; retries recover')
    page.goto(BASE + '/files')
    expect(page.get_by_text('Fixture download.pdf', exact=True)).to_be_visible()
    expect(page.get_by_text('Fixture html', exact=True)).to_have_count(0)
    checks.append('Files excludes hosted HTML and includes explicit PDF download')
    for width in [375, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        snapshot(page, f'files-{width}')
        assert page.locator('code').evaluate('(e) => [...e.parentElement.children].every(c => c.getBoundingClientRect().right <= e.parentElement.getBoundingClientRect().right)')
    page.get_by_label('Select all visible files').check()
    expect(page.get_by_label('Select all visible files')).to_be_checked()
    page.get_by_label('Select all visible files').uncheck()
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.goto(BASE + '/')
    expect(page.locator('.cb-recents')).to_contain_text('Links (3)')
    expect(page.locator('.cb-sidebar nav a[href="/links"]')).to_contain_text('3')
    expect(page.locator('.cb-recents a[href="/links"]')).to_have_count(4)
    checks.append('Sidebar Links 3 and recent Links (3) share three response rows')
    page.goto(BASE + '/links')
    expect(page.locator('tbody tr')).to_have_count(3)
    for width in [375, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        snapshot(page, f'links-{width}')
    page.get_by_label('Select all visible links').focus()
    page.keyboard.press('Space')
    expect(page.get_by_label('Select all visible links')).to_be_checked()
    page.keyboard.press('Space')
    page.get_by_label('Search links').fill('fixture-1')
    expect(page.locator('tbody tr')).to_have_count(1)
    checks.append('Links lists the same three rows and search filters to one')
    state['links_error'] = True
    page.reload()
    expect(page.get_by_role('button', name='Retry links')).to_be_visible()
    expect(page.get_by_text('No Links Found')).to_have_count(0)
    state['links_error'] = False
    page.get_by_role('button', name='Retry links').click()
    expect(page.locator('tbody tr')).to_have_count(3)
    checks.append('Links error is not empty, retry recovers rows')
    page.goto(BASE + '/settings?tab=presets')
    expect(page).to_have_url(BASE + '/links?tab=utm&panel=presets')
    expect(page.get_by_role('heading', name='UTM Presets')).to_be_visible()
    page.get_by_role('button', name='Create Preset', exact=True).click()
    page.get_by_label('Preset Name', exact=True).fill('Fixture saved preset')
    page.get_by_label('UTM Source', exact=True).fill('fixture-source')
    page.get_by_role('button', name='Save Preset', exact=True).click()
    expect(page.get_by_role('combobox', name=re.compile('^Preset')).locator('option')).to_have_count(2)
    page.get_by_role('combobox', name=re.compile('^Preset')).select_option('fixture-preset')
    expect(page.get_by_label('utm_source', exact=True)).to_have_value('fixture-source')
    page.get_by_text('Bulk CSV', exact=True).click()
    expect(page.get_by_role('button', name='Download template')).to_be_visible()
    checks.append('Settings deep link, preset save/select cache sync and bulk controls')
    expect(page.locator('[data-sonner-toast]')).to_have_count(0, timeout=10000)
    for width in [375, 768, 1440]:
        page.set_viewport_size({'width': width, 'height': 1000})
        snapshot(page, f'utm-{width}')
    checks.append('File selection and keyboard link selection still toggle; file URL controls remain inside their container')
    for path in ['/pages', '/files', '/links', '/links?tab=utm&panel=presets']:
        page.goto(BASE + path)
        expect(page.locator('main h1').first).to_be_visible()
        page.wait_for_load_state('networkidle')
        for theme in ['paper', 'graphite', 'lagoon', 'merlot', 'slate']:
            page.evaluate('(theme) => document.documentElement.setAttribute("data-cb-theme",theme)', theme)
            for width in [375, 768, 1440]:
                page.set_viewport_size({'width': width, 'height': 1000})
                theme_audits.append({'path': path, 'theme': theme, 'width': width, 'audit': page.evaluate(probe)})
        if path in ['/pages', '/links?tab=utm&panel=presets']:
            page.evaluate('document.documentElement.setAttribute("data-cb-theme","graphite")')
            page.set_viewport_size({'width': 375, 'height': 1000})
            snapshot(page, 'pages-graphite' if path == '/pages' else 'utm-graphite')
    checks.append('Five theme audit matrix at 375/768/1440 for Pages, Files, Links and UTM')
    save()
    browser.close()
print(json.dumps({'checks': len(checks), 'shots': len(shots), 'pageerrors': errors, 'overflow': [s['name'] for s in shots if s['overflow']], 'audit_failures': sum(f['severity'] == 'FAIL' for s in shots for f in s['audit'])}))
assert not errors
assert not any(s['overflow'] for s in shots)
assert not any(f['severity'] == 'FAIL' for s in shots + theme_audits for f in s['audit'])
