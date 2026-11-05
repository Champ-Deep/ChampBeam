"""Local fixture QA for the real Settings route. Never calls a production API."""
import json
import os
from pathlib import Path
import subprocess
import runpy
from uuid import uuid4
from playwright.sync_api import sync_playwright

BASE = os.environ.get('CB_QA_URL', 'http://127.0.0.1:3206')
OUT = Path(os.environ.get('CB_QA_OUT', '.verify/domains')).resolve()
OUT.mkdir(parents=True, exist_ok=True)
SCRIPT = Path('/Users/deep/champ-skills/design/skills/visual-verify/scripts')
AUDIT_PROBE = runpy.run_path(str(SCRIPT/'audit.py'))['PROBE']
results = []

def component_shot(page, locator, path):
    # Element captures otherwise composite the sticky mobile header over the section's first line.
    page.locator('.sticky.z-40,.cb-skip').evaluate_all("els => els.forEach(el => el.style.visibility = 'hidden')")
    locator.screenshot(path=str(path))
    page.locator('.sticky.z-40,.cb-skip').evaluate_all("els => els.forEach(el => el.style.visibility = '')")

def probe(page):
    findings = page.evaluate(AUDIT_PROBE)
    assert not [f for f in findings if f['severity'] == 'FAIL'], findings
    result = page.evaluate('''() => ({
      overflow:[...document.querySelectorAll('main *')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0 && (r.right>innerWidth+1 || r.left < -1)}).map(el=>el.tagName+'.'+el.className),
      small:[...document.querySelectorAll('.cb-domain-settings button,.cb-domain-adoption button')].filter(el=>el.getBoundingClientRect().height<44).map(el=>el.textContent),
      dashes:(document.body.innerText.match(/[\\u2013\\u2014]/g)||[]).length,
      theme:document.documentElement.dataset.cbTheme,
      mono:[...document.querySelectorAll('.cb-dns-records code')].every(el=>getComputedStyle(el).fontFamily.includes('JetBrains Mono')),
      disabled:[...document.querySelectorAll('.cb-domain-settings button')].filter(el=>el.disabled).map(el=>el.textContent),
    })''')
    assert not result['overflow'], result
    assert not result['small'], result
    assert result['dashes'] == 0, result
    assert result['mono'], result
    return result

with sync_playwright() as p:
    browser = p.chromium.launch()
    for theme in ['paper', 'graphite']:
        url = f'{BASE}/settings?role=admin&state=dns&theme={theme}'
        # Required stock shoot script. Capture the page fold, then the actual DNS component below.
        subprocess.run(['python3', str(SCRIPT/'shoot.py'), url, '--out', str(OUT/theme), '--widths', '375,768,1440', '--themes', 'light', '--no-full'], check=True)
        for width in [375, 768, 1440]:
            ctx = browser.new_context(viewport={'width':width, 'height':900}, permissions=['clipboard-read','clipboard-write'], reduced_motion='reduce' if width == 768 else 'no-preference')
            page = ctx.new_page()
            errors=[]
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(url)
            page.get_by_role('button', name='Copy all for IT').wait_for()
            page.evaluate('document.fonts.ready')
            before=probe(page)
            assert before['theme'] == theme
            panel=page.locator('.cb-dns-records')
            component_shot(page, panel, OUT/f'{theme}-{width}-records.png')
            # Each value copies the exact displayed token, not a wrapped or reconstructed string.
            for i in range(3):
                row=panel.locator('tbody tr').nth(i)
                expected=row.locator('td').nth(2).locator('code').inner_text()
                button=row.get_by_role('button', name='value', exact=False)
                button.click()
                assert page.evaluate('navigator.clipboard.readText()') == expected
                assert 'Copied' in button.inner_text()
                probe(page)
            expected=ctx.request.get(f'{BASE}/api/v1/domains/dns-fixture/records.txt', headers={'Authorization':'Bearer fixture:admin:fixture-a:dns'}).text()
            page.get_by_role('button', name='Copy all for IT').click()
            page.get_by_text('Copied all records for IT.').wait_for()
            assert page.evaluate('navigator.clipboard.readText()') == expected
            with page.expect_download() as info:
                page.get_by_role('button', name='Download .txt').click()
            download=info.value
            assert Path(download.path()).read_text() == expected
            page.get_by_role('button', name='Refresh', exact=True).click()
            page.get_by_role('button', name='Refresh', exact=True).wait_for()
            after=probe(page)
            assert not errors, errors
            results.append({'width':width,'theme':theme,'before':before,'after':after,'console_errors':errors,'clipboard_and_download':'exact'})
            ctx.close()
            log=OUT/f'audit-{theme}-{width}.log'
            with log.open('w') as f:
                r=subprocess.run(['python3',str(SCRIPT/'audit.py'),url,'--width',str(width),'--json',str(OUT/f'audit-{theme}-{width}.json')], stdout=f,stderr=subprocess.STDOUT)
            assert r.returncode == 0, log.read_text()
    for state in ['dns-ssl', 'dns-failed', 'dns-adoption']:
        for width in [375, 1440]:
            page=browser.new_page(viewport={'width':width,'height':900})
            page.goto(f'{BASE}/settings?role=admin&state={state}&theme=paper')
            page.locator('.cb-domain-row').wait_for()
            if state == 'dns-adoption':
                page.get_by_role('button',name='Review and move existing content').click()
                dialog=page.get_by_role('alertdialog')
                dialog.wait_for()
                probe(page)
                assert '17 links, 29 files will move to share.lakeb2b.com' in dialog.inner_text()
                dialog.screenshot(path=str(OUT/f'{state}-{width}.png'))
                page.get_by_role('button',name='Cancel',exact=True).click()
                page.get_by_role('button',name='Review and move existing content').click()
                page.get_by_role('button',name='Move existing content',exact=True).click()
                page.get_by_text('17 links, 29 files and 3 aliases moved.').wait_for()
            else:
                component_shot(page, page.locator('.cb-domain-row'), OUT/f'{state}-{width}.png')
            probe(page)
            page.close()
            with (OUT/f'audit-{state}-{width}.log').open('w') as f:
                r=subprocess.run(['python3',str(SCRIPT/'audit.py'),f'{BASE}/settings?role=admin&state={state}&theme=paper','--width',str(width)],stdout=f,stderr=subprocess.STDOUT)
            assert r.returncode == 0, (OUT/f'audit-{state}-{width}.log').read_text()
    page=browser.new_page(viewport={'width':375,'height':900})
    page.goto(f'{BASE}/settings?role=admin&state=dns-live&theme=paper&org=live-poll-{uuid4()}')
    page.get_by_text('Waiting on CNAME',exact=True).wait_for()
    page.get_by_text('Active',exact=True).wait_for(timeout=25000)
    results.append({'polling':'pending to active without reload'})
    page.close()
    browser.close()
(OUT/'behavior.json').write_text(json.dumps(results,indent=2))
print(json.dumps({'result':'PASS','cases':len(results),'out':str(OUT)},indent=2))
