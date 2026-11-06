from pathlib import Path
import json, importlib.util, os
from playwright.sync_api import sync_playwright
repo=Path(__file__).resolve().parents[2]
out=repo/'docs/journeys-evidence';out.mkdir(parents=True,exist_ok=True)
spec=importlib.util.spec_from_file_location('audit',str(Path.home()/'champ-skills/design/skills/visual-verify/scripts/audit.py'));audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
# Hidden legacy filters are outside the new region and are not part of its form audit.
audit.PROBE=audit.PROBE.replace("document.querySelectorAll('input, textarea, select')", "document.querySelector('.cb-journeys').querySelectorAll('input, textarea, select')")
base=os.environ.get('JOURNEYS_FIXTURE_URL', 'http://127.0.0.1:3189/e2e/journeys.html')
results=[]
with sync_playwright() as pw:
 browser=pw.chromium.launch()
 for width in [375,768,1440]:
  for theme in ['paper','graphite']:
   for scenario in ['two','one']:
    context=browser.new_context(viewport={'width':width,'height':1000},is_mobile=width<700,has_touch=width<700)
    page=context.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    page.goto(f'{base}?region=1&theme={theme}&scenario={scenario}',wait_until='networkidle')
    section=page.locator('.cb-journeys');section.scroll_into_view_if_needed()
    page.get_by_role('button',name='Visitor ab12',exact=False).click()
    page.wait_for_function("document.querySelector('[data-slot=geo-traceroute]')?.innerText.includes('+2d 4h')")
    page.wait_for_function("[...document.querySelectorAll('[data-slot=geo-traceroute] tbody tr')].every(r=>r.dataset.state==='done')")
    page.wait_for_timeout(1700)
    name=f'{theme}-{width}-{scenario}'
    section.screenshot(path=str(out/f'{name}.png'))
    pixels=page.locator('[data-slot=geo-traceroute] canvas').evaluate_all('els => els.slice(0,2).map(c=>{const d=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let painted=0;for(let i=3;i<d.length;i+=4)if(d[i])painted++;return {width:c.width,height:c.height,painted}})')
    geometry=page.locator('.cb-journeys').evaluate('(root)=>[...root.querySelectorAll("*")].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.left < -1 || r.right>innerWidth+1)&&e.tagName!=="CANVAS"}).map(e=>e.tagName+"."+e.className)')
    findings=page.evaluate(audit.PROBE)
    assert pixels[0]['painted']>100,pixels
    assert pixels[1]['painted']>0 if scenario=='two' else pixels[1]['painted']==0,pixels
    assert not geometry,geometry
    assert not errors,errors
    assert not [f for f in findings if f['severity']=='FAIL'],findings
    assert page.locator('body').inner_text().count(chr(8211))==0
    assert page.locator('body').inner_text().count(chr(8212))==0
    # Real touch and keyboard select the actual hop, not a visual proxy.
    row=page.locator('[data-slot=geo-traceroute] tbody button').first
    if width<700: row.tap()
    else: row.click()
    assert row.get_attribute('aria-pressed')=='true'
    row.press('ArrowDown');page.keyboard.press('Enter')
    assert page.locator('[data-slot=geo-traceroute] tbody button').nth(1).get_attribute('aria-pressed')=='true'
    page.locator('[data-slot=geo-traceroute]').press('Escape')
    assert page.locator('[data-selected]').count()==0
    page.get_by_role('button',name='Replay',exact=True).click()
    page.get_by_role('button',name='Pause',exact=True).click()
    assert page.get_by_role('button',name='Play',exact=True).count()==1
    page.get_by_role('button',name='Play',exact=True).click()
    page.wait_for_function("[...document.querySelectorAll('[data-slot=geo-traceroute] tbody tr')].every(r=>r.dataset.state==='done')")
    results.append({'case':name,'pixels':pixels,'overflow':geometry,'errors':errors,'audit':findings,'controls':'touch or click, keyboard selection, Escape, Replay, Pause, Play passed'})
    print(name,pixels,[(f['severity'],f['rule'],f['message']) for f in findings],flush=True)
    context.close()
 # The other real analytics callers must issue the expected scoped API request.
 for surface in ['file','page','top']:
  page=browser.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(f'{base}?surface={surface}&region=1',wait_until='networkidle');page.locator('.cb-journeys').wait_for();page.wait_for_timeout(1000)
  requests=page.evaluate('window.fixtureRequests')
  print('SURFACE',surface,'ERRORS',errors,'REQUESTS',requests,flush=True)
  assert not errors,errors
  assert any('/analytics/journeys'+('/top' if surface=='top' else '') in r for r in requests)
  if surface=='page':assert any('"asset_type":"file"' in r and '"asset_id":"fixture"' in r for r in requests)
  results.append({'surface':surface,'errors':errors,'requests':requests})
  page.close()
 for theme in ['paper','graphite']:
  context=browser.new_context(viewport={'width':375,'height':1000},reduced_motion='reduce');page=context.new_page()
  page.goto(f'{base}?region=1&theme={theme}',wait_until='networkidle')
  page.locator('.cb-journeys').scroll_into_view_if_needed();page.wait_for_timeout(200)
  assert page.locator('[data-slot=geo-traceroute] tbody tr[data-state=done]').count()==3
  before=page.locator('[data-slot=geo-traceroute] canvas').nth(1).evaluate('(c)=>c.toDataURL()');page.wait_for_timeout(300)
  after=page.locator('[data-slot=geo-traceroute] canvas').nth(1).evaluate('(c)=>c.toDataURL()');assert before==after
  page.locator('.cb-journeys').screenshot(path=str(out/f'{theme}-375-reduced.png'))
  page.get_by_role('button',name='Fixture actions').click();page.locator('[data-slot=dropdown-menu-content]').screenshot(path=str(out/f'{theme}-dropdown.png'))
  color=page.locator('[data-slot=dropdown-menu-content]').evaluate('(e)=>({bg:getComputedStyle(e).backgroundColor,ink:getComputedStyle(e).color})')
  assert color['bg']!='rgba(0, 0, 0, 0)',color
  page.keyboard.press('ArrowDown');page.keyboard.press('Enter');assert page.locator('[data-slot=dropdown-menu-content]').count()==0
  results.append({'case':theme+' reduced','finished':True,'stablePixels':True,'dropdown':color})
  context.close()
 for scenario in ['empty','loading','error']:
  page=browser.new_page(viewport={'width':375,'height':1000});page.goto(f'{base}?region=1&surface=top&scenario={scenario}',wait_until='domcontentloaded');page.locator('.cb-journeys').wait_for();page.wait_for_timeout(500)
  if scenario=='empty':
   assert page.locator('.cb-journeys details').get_attribute('open') is None
   page.locator('.cb-journeys summary').click()
  if scenario=='error':
   page.get_by_role('button',name='Try again').wait_for()
   error_findings=page.evaluate(audit.PROBE)
   assert not [f for f in error_findings if f['severity']=='FAIL'],error_findings
   (out/'error-audit.json').write_text(json.dumps(error_findings,indent=2))
   page.locator('.cb-journeys').screenshot(path=str(out/f'{scenario}-375.png'))
   page.get_by_role('button',name='Try again').click();page.get_by_text('Forwarded',exact=True).wait_for();assert page.get_by_text('Journeys could not load').count()==0
  else:page.locator('.cb-journeys').screenshot(path=str(out/f'{scenario}-375.png'))
  findings=page.evaluate(audit.PROBE)
  assert not [f for f in findings if f['severity']=='FAIL'],findings
  results.append({'state':scenario,'audit':findings,'recovery':scenario=='error'})
  page.close()
 # Long elapsed time, an intentional mid-flight frame, and live theme changes.
 page=browser.new_page(viewport={'width':768,'height':1000})
 page.goto(f'{base}?region=1&scenario=long',wait_until='networkidle')
 page.locator('.cb-journeys').scroll_into_view_if_needed()
 page.wait_for_function("[...document.querySelectorAll('[data-slot=geo-traceroute] tbody tr')].every(r=>r.dataset.state==='done')")
 page.get_by_role('button',name='Replay',exact=True).click()
 start=page.evaluate('performance.now()')
 page.wait_for_function("document.querySelector('[data-state=active]') !== null")
 pending=page.locator('[data-slot=geo-traceroute] tbody tr[data-state=pending] td:last-child').all_text_contents()
 assert pending and all(cell.strip()=='-' for cell in pending),f'Pending elapsed cells must be placeholders: {pending}'
 page.locator('.cb-journeys').screenshot(path=str(out/'paper-768-midflight.png'))
 page.wait_for_function("[...document.querySelectorAll('[data-slot=geo-traceroute] tbody tr')].every(r=>r.dataset.state==='done')")
 elapsed=page.evaluate('performance.now()')-start
 assert elapsed<8000,elapsed
 page.wait_for_timeout(1700)
 palettes=[]
 for theme in ['paper','graphite','lagoon','merlot','slate']:
  before=page.locator('[data-slot=geo-traceroute] canvas').nth(1).evaluate('(c)=>c.toDataURL()')
  page.evaluate('(theme)=>document.documentElement.dataset.cbTheme=theme',theme)
  page.wait_for_timeout(200)
  after=page.locator('[data-slot=geo-traceroute] canvas').nth(1).evaluate('(c)=>c.toDataURL()')
  colors=page.locator('[data-slot=geo-traceroute]').evaluate('(e)=>{const s=getComputedStyle(e);return Object.fromEntries(["--foreground","--card","--border","--muted","--muted-foreground","--lumesec","--cb-accent"].map(k=>[k,s.getPropertyValue(k).trim()]))}')
  assert all(colors.values()),colors
  assert colors['--lumesec']==colors['--cb-accent'],colors
  if theme!='paper':assert before!=after,theme
  palettes.append({'theme':theme,'colors':colors,'repainted':theme=='paper' or before!=after})
 results.append({'longJourneyMs':elapsed,'livePalettes':palettes})
 print('LONG JOURNEY MS',elapsed,'ALL FIVE THEME REPAINTS PASSED',flush=True)
 page.close()
 browser.close()
(out/'results.json').write_text(json.dumps(results,indent=2))
print('Completed',len(results),'cases',flush=True)
