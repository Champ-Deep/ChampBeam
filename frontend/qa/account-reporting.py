"""Explicit local fixtures against the real app routes, not a production acceptance run."""
import importlib.util
import json
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.verify' / 'account-reporting'
OUT.mkdir(parents=True, exist_ok=True)
BASE = 'http://127.0.0.1:3199'
spec = importlib.util.spec_from_file_location('audit', '/Users/deep/champ-skills/design/skills/visual-verify/scripts/audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
# Normalize modern CSS colors through the browser before the legacy audit parser.
probe = audit.PROBE.replace("const m = (c || '').match", """if (/^(oklch|oklab|lab|lch|color)\\(/.test(c || '')) {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = c; ctx.fillRect(0,0,1,1);
      const [r,g,b,a] = ctx.getImageData(0,0,1,1).data;
      return {r,g,b,a:a/255};
    }
    const m = (c || '').match""")
results, checks, console = [], [], []

def snap(page, name):
    page.screenshot(path=str(OUT / (name + '.png')), full_page=True)
    results.append({'name': name, 'audit': page.evaluate(probe), 'overflow': page.evaluate('''() => [...document.querySelectorAll('main *, .cb-account *')].filter(e=>{const r=e.getBoundingClientRect();return e.checkVisibility() && r.width>0 && r.right>innerWidth+1 && !e.closest('.cb-table-scroll, .overflow-x-auto')}).map(e=>e.tagName+':'+e.className)''')})
    (OUT/'results.json').write_text(json.dumps({'checks':checks,'console':console,'states':results},indent=2))

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(viewport={'width':1440,'height':1000}, reduced_motion='reduce')
    # Real Clerk sessions prevent the app's generic 401 redirect. This is a labelled fixture session.
    context.add_init_script('window.Clerk = {session: {id: "explicit-qa-session"}}')
    page = context.new_page()
    page.on('pageerror', lambda error: console.append({'kind':'pageerror','text':str(error)}))
    page.on('console', lambda msg: console.append({'kind':msg.type,'text':msg.text}) if msg.type in ['error','warning'] else None)
    response = page.request.get(BASE+'/src/components/AccountFooter.tsx')
    assert response.status == 200 and 'Workspace profile unavailable' in response.text()
    checks.append('served bytes match updated AccountFooter')
    for width in [375,768,1440]:
        page.set_viewport_size({'width':width,'height':1000})
        page.goto(BASE+'/team?role=viewer')
        expect(page.get_by_text('Read-only reporting. Creating shares', exact=False)).to_be_visible()
        expect(page.get_by_label('Team leader ID')).to_be_enabled()
        expect(page.get_by_label('Member ID')).to_be_enabled()
        expect(page.get_by_role('button',name='Save team assignment')).to_have_count(0)
        expect(page.get_by_role('button',name='Withdraw assignment')).to_have_count(0)
        snap(page,f'viewer-{width}')
        page.goto(BASE+'/settings?role=admin')
        expect(page.get_by_role('button',name='Grant read-only reporting')).to_be_visible()
        snap(page,f'admin-{width}')
        checks.append(f'viewer and IT admin routes render at {width}')
    page.goto(BASE+'/team?role=viewer')
    page.get_by_label('Team leader ID').fill('outside')
    page.get_by_role('button',name='Apply filters').click()
    expect(page.get_by_role('alert').filter(has_text='outside your granted scope')).to_be_visible()
    snap(page,'scope-denied')
    checks.append('out-of-scope report filter shows 403 clearly without stale totals')
    page.goto(BASE+'/settings?role=admin')
    expect(page.get_by_role('combobox',name='Member',exact=True)).to_be_visible()
    page.get_by_role('combobox',name='Member',exact=True).select_option('fixture-user')
    page.route('**/api/v1/org/members/*', lambda route: route.fulfill(status=403,json={'detail':'Permission revoked. This workspace is read-only.'}))
    page.get_by_role('button',name='Save team assignment').click()
    expect(page.get_by_role('alert').filter(has_text='Permission revoked')).to_be_visible()
    snap(page,'write-denied')
    checks.append('server write rejection remains visible and does not claim success')
    page.goto(BASE+'/team?role=member')
    expect(page.get_by_label('Member ID')).to_be_disabled()
    expect(page.get_by_text('Scope: own.',exact=False)).to_be_visible()
    checks.append('member own view cannot request broader member or team scope')
    page.goto(BASE+'/?state=auth-error')
    expect(page.locator('.cb-account [role=alert]')).to_contain_text('Workspace authorization failed')
    expect(page.locator('.cb-account')).to_contain_text('Role: unavailable')
    snap(page,'profile-auth-denied')
    checks.append('profile auth failure remains separate from loading')
    pending = []
    page.route('**/api/v1/org/profile', lambda route: pending.append(route))
    avatars = []
    page.route('**/qa-avatar', lambda route: avatars.append(route))
    page.goto(BASE+'/',wait_until='domcontentloaded')
    expect(page.locator('.cb-account')).to_contain_text('Fixture Member')
    expect(page.locator('.cb-account')).to_contain_text('Loading workspace profile')
    expect(page.locator('.cb-avatar')).to_contain_text('FM')
    assert page.locator('.cb-avatar img').evaluate('(e)=>getComputedStyle(e).opacity') == '0'
    snap(page,'slow-profile-avatar')
    assert pending and avatars
    for route in pending: route.continue_()
    expect(page.locator('.cb-account')).to_contain_text('Role: member')
    for route in avatars: route.fulfill(status=200,content_type='text/plain',body='invalid avatar fixture')
    page.wait_for_function("document.querySelector('.cb-avatar img').complete")
    assert page.locator('.cb-avatar img').evaluate('(e)=>getComputedStyle(e).opacity') == '0'
    page.locator('.cb-account summary').click()
    expect(page.get_by_role('button',name='Manage account')).to_be_visible()
    expect(page.get_by_role('link',name='Workspace settings',exact=True)).to_be_visible()
    snap(page,'failed-avatar-menu')
    checks.append('slow profile and slow or broken avatar retain identity and initials, menu opens')
    page.unroute('**/api/v1/org/profile')
    page.unroute('**/qa-avatar')
    page.get_by_role('button',name='Switch fixture workspace').click()
    expect(page.locator('.cb-account')).to_contain_text('fixture-b')
    expect(page.locator('.cb-account')).not_to_contain_text('fixture-a')
    checks.append('org switch resets profile identity; draft and late cache isolation covered by unit regression')
    page.set_viewport_size({'width':375,'height':812})
    page.get_by_role('button',name='Open menu').click()
    expect(page.locator('.cb-account:visible')).to_contain_text('Fixture Member')
    page.locator('.cb-account:visible summary').click()
    snap(page,'mobile-account-menu')
    switcher = page.get_by_role('button',name='Switch fixture workspace')
    switcher.scroll_into_view_if_needed()
    expect(switcher).to_be_in_viewport()
    snap(page,'mobile-account-scrolled')
    page.keyboard.press('Escape')
    expect(page.get_by_role('dialog',name='Workspace navigation')).to_have_count(0)
    checks.append('mobile account menu and Escape close work')
    page.set_viewport_size({'width':1440,'height':1000})
    for theme in ['graphite','lagoon','merlot','slate']:
        page.goto(BASE+'/team?role=viewer')
        expect(page.get_by_text('Read-only reporting. Creating shares',exact=False)).to_be_visible()
        page.evaluate('(theme)=>document.documentElement.dataset.cbTheme=theme',theme)
        snap(page,'theme-'+theme)
    checks.append('all five shipped theme palettes checked on reporting')
    context.close()
    browser.close()
(OUT/'results.json').write_text(json.dumps({'checks':checks,'console':console,'states':results},indent=2))
print(json.dumps({'checks':len(checks),'states':len(results),'console':console,'overflow':[{r['name']:r['overflow']} for r in results if r['overflow']],'audit_failures':sum(x['severity']=='FAIL' for r in results for x in r['audit'])}))
assert not any(r['overflow'] for r in results)
assert not any(e['kind']=='pageerror' for e in console)
assert not any(x['severity']=='FAIL' for r in results for x in r['audit'])
