"""Real application route, explicit QA backend and identity fixtures only."""
import importlib.util
import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.verify' / 'composer'
OUT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
assert spec and spec.loader
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
BASE = 'http://127.0.0.1:3198'
results, errors, checks, console_errors = [], [], [], []

def snap(page, name, image=True):
    page.evaluate("document.documentElement.style.scrollBehavior='auto'")
    page.evaluate('window.scrollTo(0,0)')
    if image:
        page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
    results.append({'name': name, 'audit': page.evaluate(audit.PROBE), 'overflow': page.evaluate('''() => [...document.querySelectorAll('.cb-composer *')].filter(e => {
      const r=e.getBoundingClientRect();
      return r.width>0 && (r.right>innerWidth+1 || r.left< -1) && !e.closest('[role=tabpanel]') && !e.classList.contains('will-change-transform');
    }).map(e=>e.tagName+':'+e.className)''')})
    (OUT / 'results.json').write_text(json.dumps({'checks': checks, 'errors': errors, 'console_errors': console_errors, 'states': results}, indent=2))

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width':1440,'height':1000}, permissions=['clipboard-read','clipboard-write'], has_touch=True)
    page = context.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('console', lambda message: console_errors.append(message.text) if message.type == 'error' else None)
    page.goto(BASE+f'/?org=composer-qa-{time.time_ns()}')
    expect(page.get_by_label('Paste content or drop one file')).to_be_visible()
    assert page.locator('.cb-composer-prompt').count()==1
    assert page.locator('.cb-composer input[type=file]').count()==1
    expect(page.get_by_role('tab')).to_have_count(0)
    checks.append('actual registry prompt and one file input mounted on home; intent absent until content')
    for width in [375,768,1440]:
        page.set_viewport_size({'width':width,'height':1000})
        snap(page,f'empty-{width}')
    page.get_by_label('Choose file',exact=True).set_input_files({'name':'Café.final.pdf','mimeType':'application/pdf','buffer':b'Explicit UI fixture, not media rendering evidence'})
    download = page.get_by_role('tab',name='Send as file',exact=True)
    download.focus()
    page.keyboard.press('ArrowRight')
    expect(page.get_by_role('tab',name='Host for viewing')).to_have_attribute('aria-selected','true')
    expect(page.locator('.cb-host-preview')).to_contain_text('cafe-final')
    expect(page.get_by_label('Page address')).to_have_count(0)
    page.get_by_role('button',name='Edit address',exact=True).click()
    expect(page.get_by_label('Page address')).to_have_value('cafe-final')
    expect(page.get_by_label('Share domain')).to_have_value('fixture-domain')
    checks.append('keyboard arrow selection; compact disclosure; backend basename and verified domain')
    for width in [1440,375]:
        page.set_viewport_size({'width':width,'height':1000})
        snap(page,f'host-{width}')
    page.get_by_label('Page address').fill('taken')
    page.get_by_role('button',name='Publish page',exact=True).tap()
    expect(page.get_by_role('alert')).to_contain_text('That slug is taken.')
    expect(page.get_by_label('Page address')).to_have_value('taken')
    snap(page,'collision-375')
    checks.append('tap publish conflict retains file and edited slug')
    page.get_by_label('Page address').fill('composer-qa-final')
    page.get_by_role('button',name='Publish page',exact=True).tap()
    expect(page.get_by_role('heading',name='Page published',exact=True)).to_be_visible()
    page.get_by_role('button',name='Copy address',exact=True).tap()
    expect(page.get_by_role('button',name='Address copied',exact=True)).to_be_visible()
    assert page.evaluate('navigator.clipboard.readText()')==BASE+'/composer-qa-final'
    expect(page.get_by_role('link',name='Open Pages',exact=True)).to_have_attribute('href','/pages')
    assert '/pages/' in page.get_by_role('link',name='View analytics',exact=True).get_attribute('href')
    snap(page,'result-375')
    checks.append('host result, real clipboard bytes, Pages and analytics destinations')
    page.get_by_role('button',name='Remove file',exact=True).tap()
    page.get_by_label('Paste content or drop one file').fill('https://example.invalid/external')
    snap(page,'external-375')
    expect(page.get_by_role('link',name='Track external URL')).to_have_attribute('href','/links?tab=utm&url=https%3A%2F%2Fexample.invalid%2Fexternal')
    checks.append('external URL offers only tracking, not fake import')
    page.get_by_label('Paste content or drop one file').fill('')
    page.emulate_media(reduced_motion='reduce')
    page.get_by_label('Choose file',exact=True).set_input_files({'name':'motion.zip','mimeType':'application/zip','buffer':b'fixture'})
    expect(page.get_by_role('tab',name='Host for viewing')).to_have_count(0)
    page.get_by_role('button',name='Create download link',exact=True).tap()
    expect(page.get_by_role('heading',name='Download ready',exact=True)).to_be_visible()
    expect(page.get_by_role('link',name='Open Files',exact=True)).to_have_attribute('href','/files')
    snap(page,'download-reduced-375')
    checks.append('reduced-motion download and unsupported-host explanation')
    pending = []
    def delay_create(route):
        if route.request.method == 'POST': pending.append(route)
        else: route.continue_()
    page.route('**/api/v1/files', delay_create)
    page.get_by_label('Choose file',exact=True).set_input_files({'name':'loading.png','mimeType':'image/png','buffer':b'explicit fixture'})
    page.get_by_role('tab',name='Host for viewing').tap()
    page.get_by_role('button',name='Publish page',exact=True).tap()
    expect(page.get_by_text('Uploading and publishing…',exact=True)).to_be_visible()
    expect(page.get_by_role('button',name='Publish page',exact=True)).to_be_disabled()
    snap(page,'loading-375')
    assert len(pending)==1
    pending[0].continue_()
    page.unroute('**/api/v1/files',delay_create)
    expect(page.get_by_role('heading',name='Page published',exact=True)).to_be_visible()
    checks.append('delayed upload named status and disabled controls; settles to success')
    for name,mime,content in [('sample.mp4','video/mp4',b'explicit video fixture'),('sample.html','text/html',b'<!doctype html><html><body>Explicit QA fixture</body></html>')]:
        page.get_by_label('Choose file',exact=True).set_input_files({'name':name,'mimeType':mime,'buffer':content})
        page.get_by_role('tab',name='Host for viewing').tap()
        page.get_by_role('button',name='Publish page',exact=True).tap()
        expect(page.get_by_role('heading',name='Page published',exact=True)).to_be_visible()
    checks.append('HTML and video creation routes settle to Pages with synthetic UI fixtures')
    page.get_by_role('button',name='Show QR code',exact=True).tap()
    final_url = page.locator('.cb-result > a').get_attribute('href')
    expect(page.get_by_role('img',name='QR code for '+final_url)).to_be_visible()
    page.locator('.cb-result .fixed').tap(position={'x':5,'y':5})
    expect(page.get_by_role('button',name='Show QR code')).to_have_attribute('aria-expanded','false')
    checks.append('existing QR popover opens and closes; QR encoding not served by fixture backend')
    for theme in ['paper','graphite','lagoon','merlot','slate']:
        page.evaluate('(theme)=>document.documentElement.dataset.cbTheme=theme',theme)
        snap(page,f'theme-{theme}',image=False)
    checks.append('five shipped themes audited in result state')
    def invalid_domain(route):
        response = route.fetch()
        profile = response.json()
        profile['share_host']['default_domain_id'] = 'unavailable-fixture'
        route.fulfill(response=response, json=profile)
    page.route('**/api/v1/org/profile', invalid_domain)
    page.reload()
    page.get_by_label('Choose file',exact=True).set_input_files({'name':'invalid-domain.pdf','mimeType':'application/pdf','buffer':b'fixture'})
    expect(page.get_by_role('alert')).to_contain_text('domain is unavailable or invalid')
    expect(page.get_by_role('button',name='Create download link',exact=True)).to_be_disabled()
    snap(page,'invalid-domain-375')
    page.get_by_label('Share domain').select_option('fixture-domain')
    expect(page.get_by_role('button',name='Create download link',exact=True)).to_be_enabled()
    checks.append('missing selected host is not silently replaced; choosing active host recovers')
    assert not errors, errors
    assert not any(state['overflow'] for state in results), results
    assert not any(finding['severity']=='FAIL' for state in results for finding in state['audit']), results
    (OUT/'results.json').write_text(json.dumps({'checks':checks,'errors':errors,'console_errors':console_errors,'states':results},indent=2))
    print(json.dumps({'checks':len(checks),'screenshots':len(list(OUT.glob('*.png'))),'page_errors':errors,'console_errors':console_errors,'states':len(results)}))
    browser.close()
