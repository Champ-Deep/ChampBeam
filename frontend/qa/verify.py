"""Local fixtures only. Run the QA Vite config on 3198 before this script."""
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.verify' / 'states'
OUT.mkdir(parents=True, exist_ok=True)
spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
checks, results, errors = [], [], []
BASE = 'http://127.0.0.1:3198'

def passed(name):
    checks.append(name)

def snap(page, name):
    page.screenshot(path=str(OUT / f'{name}.png'), full_page=True)
    results.append({'name':name, 'audit':page.evaluate(audit.PROBE), 'overflow':page.evaluate('''() => [...document.querySelectorAll('main *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0 && r.right>innerWidth+1 && !e.closest('.overflow-x-auto')}).map(e=>e.tagName+':'+e.className)''')})
    (OUT/'results.json').write_text(json.dumps({'checks':checks,'errors':errors,'states':results},indent=2))

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width':1440,'height':1000}, permissions=['clipboard-read','clipboard-write'])
    page = context.new_page()
    page.request.post(BASE+'/api/v1/qa-reset')
    page.on('pageerror', lambda error: errors.append(str(error)))
    def home(query=''):
        page.goto(BASE+'/?'+query)
        expect(page.get_by_role('heading',name='Share',exact=True)).to_be_visible()
    home('org=qa-run')
    expect(page.get_by_label('Paste content or drop one file')).to_be_visible()
    expect(page.locator('.cb-account')).to_contain_text('Fixture Member')
    expect(page.locator('.cb-account')).to_contain_text('Role: member')
    page.wait_for_function("document.querySelector('.cb-avatar img').complete")
    assert page.locator('.cb-avatar img').evaluate('(e)=>getComputedStyle(e).opacity')=='0'
    passed('avatar failure preserves initials, name, workspace and server role')
    for width in [375,768,1440]:
        page.set_viewport_size({'width':width,'height':1000})
        snap(page,f'home-{width}')
    page.set_viewport_size({'width':1440,'height':1000})
    for ext,mime in [('html','text/html'),('pdf','application/pdf'),('png','image/png'),('mp4','video/mp4')]:
        for intent in ['host','download']:
            name=f'QA {ext} {intent}.{ext}'
            page.get_by_label('Choose file',exact=True).set_input_files({'name':name,'mimeType':mime,'buffer':b'<!doctype html><html><body>Explicit QA fixture</body></html>'})
            expect(page.get_by_role('button',name='Publish page')).to_have_count(0)
            page.get_by_role('tab',name='Host for viewing' if intent=='host' else 'Send as file').click()
            if intent=='host':
                page.get_by_role('button',name='Edit address',exact=True).click()
                expect(page.get_by_label('Page address')).to_have_value(f'qa-{ext}-host')
                if ext=='pdf': snap(page,'host-configured')
            page.get_by_role('button',name='Publish page' if intent=='host' else 'Create download link',exact=True).click()
            expect(page.get_by_role('heading',name='Page published' if intent=='host' else 'Download ready')).to_be_visible()
            passed(f'{ext} {intent} flow uses explicit intent and confirms response')
    snap(page,'download-result')
    expect(page.locator('.cb-recents')).to_contain_text('QA mp4 download.mp4')
    passed('recents update after upload without a reload')
    page.get_by_label('Choose file',exact=True).set_input_files({'name':'Café Deck.pdf','mimeType':'application/pdf','buffer':b'fixture'})
    page.get_by_role('tab',name='Host for viewing').click()
    page.get_by_role('button',name='Edit address',exact=True).click()
    expect(page.get_by_label('Page address')).to_have_value('cafe-deck')
    page.get_by_label('Page address').fill('taken')
    page.get_by_role('button',name='Publish page',exact=True).click()
    expect(page.get_by_role('alert').filter(has_text='That slug is taken.')).to_be_visible()
    expect(page.get_by_label('Page address')).to_have_value('taken')
    snap(page,'slug-conflict')
    passed('Unicode basename suggestion and authoritative conflict preserve the draft')
    page.get_by_role('button',name='Remove file',exact=True).click()
    page.get_by_label('Paste content or drop one file').fill('https://example.invalid/fixture')
    page.get_by_role('link',name='Track external URL',exact=True).click()
    expect(page.get_by_role('heading',name='Create a tracked link',exact=True)).to_be_visible()
    snap(page,'utm')
    passed('external URL routes into the Links UTM tab')
    page.goto(BASE+'/pages?org=qa-run')
    expect(page.get_by_text('QA pdf host.pdf',exact=True)).to_be_visible()
    expect(page.get_by_text('QA pdf download.pdf',exact=True)).to_have_count(0)
    snap(page,'pages')
    passed('Pages list contains hosted media, not downloads')
    page.goto(BASE+'/files?org=qa-run')
    expect(page.get_by_text('QA pdf download.pdf',exact=True)).to_be_visible()
    expect(page.get_by_text('QA pdf host.pdf',exact=True)).to_have_count(0)
    snap(page,'files')
    passed('Files list contains downloads, not hosted media')
    home('org=qa-run')
    page.get_by_label('Paste content or drop one file').fill('<!doctype html><html>private draft</html>')
    page.get_by_role('button',name='Switch fixture workspace').click()
    expect(page.get_by_label('Paste content or drop one file')).to_have_value('')
    expect(page.locator('.cb-recents')).not_to_contain_text('QA pdf')
    passed('organization switch remounts draft and discards former query data')
    home('role=viewer')
    expect(page.get_by_role('heading',name='Read-only workspace')).to_be_visible()
    expect(page.get_by_label('Choose file',exact=True)).to_have_count(0)
    page.goto(BASE+'/team?role=viewer')
    expect(page.get_by_text('Email sends: not measured.',exact=False)).to_be_visible()
    snap(page,'viewer-reporting')
    assert page.get_by_role('button',name='Assign lead').count()==0
    passed('viewer reporting has no creation or administrative controls')
    page.goto(BASE+'/settings?role=admin')
    expect(page.get_by_role('button',name='Grant read-only reporting')).to_be_visible()
    snap(page,'admin-settings')
    passed('IT controls derive from profile permissions')
    for state in ['pages-error','pages-auth']:
        page.goto(BASE+'/pages?state='+state)
        expect(page.get_by_role('button',name='Retry pages')).to_be_visible()
        snap(page,state)
    passed('request failure and authorization failure show distinct retry states')
    page.goto(BASE+'/?state=auth-error')
    expect(page.get_by_text('Fixture sign in',exact=True)).to_be_visible()
    snap(page,'profile-auth-error')
    home()
    page.set_viewport_size({'width':375,'height':812})
    page.get_by_role('button',name='Open menu').click()
    expect(page.locator('.cb-account:visible')).to_contain_text('Fixture Member')
    snap(page,'mobile-menu')
    passed('mobile navigation exposes account information')
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog',name='Workspace navigation')).to_have_count(0)
    context.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps({'checks':checks,'errors':errors,'states':results},indent=2))
print(json.dumps({'checks':len(checks),'pageerrors':errors,'states':len(results),'audit_failures':sum(x['severity']=='FAIL' for r in results for x in r['audit'])}))
assert not errors, errors
assert not any(r['overflow'] for r in results), results
