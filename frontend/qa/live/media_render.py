"""Upload real decodable media through the composer to the local Worker only.
Requires running qa-live Vite on 3300 and Wrangler on 8799, Playwright and ffmpeg.
Creates labelled local test assets; never deletes existing state or uses production.
"""
import json
import subprocess
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / '.verify' / 'final' / 'media'
OUT.mkdir(parents=True, exist_ok=True)
APP = 'http://127.0.0.1:3300'
SHARE = 'http://localhost:8799'
run = uuid.uuid4().hex[:8]
results = []
errors = []
with sync_playwright() as pw:
    # Chrome's full headless mode includes the PDF viewer; headless-shell downloads PDFs.
    browser = pw.chromium.launch(channel='chrome')
    source = browser.new_page(viewport={'width': 640, 'height': 360})
    html = '<!doctype html><html><title>Local QA media</title><body style="background:#fbf8f2;color:#241c14;font:24px sans-serif;padding:32px"><h1>Local QA media</h1><p>Generated test asset. Not recovered customer content.</p></body></html>'
    source.set_content(html)
    source.screenshot(path=str(OUT / 'image.png'))
    source.pdf(path=str(OUT / 'document.pdf'))
    (OUT / 'document.html').write_text(html)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '2', '-an', '-c:v', 'libvpx-vp9', str(OUT / 'video.webm')], check=True)
    source.close()
    page = browser.new_page()
    page.on('pageerror', lambda e: errors.append(str(e)))
    resources = []
    page.on('response', lambda r: resources.append({'status': r.status, 'path': urlsplit(r.url).path}) if r.status >= 400 else None)
    for name, kind in [('image.png', 'image'), ('video.webm', 'video'), ('document.pdf', 'pdf'), ('document.html', 'html')]:
        page.goto(APP + '/?role=member')
        page.get_by_label('Choose file', exact=True).set_input_files(str(OUT / name))
        page.get_by_role('tab', name='Host for viewing').click()
        page.get_by_role('button', name='Edit address', exact=True).click()
        page.get_by_label('Page address').fill(f'qa-render-{run}-{kind}')
        page.get_by_role('button', name='Publish page', exact=True).click()
        expect(page.locator('.cb-result')).to_be_visible(timeout=20000)
        url = SHARE + urlsplit(page.locator('.cb-result > a').get_attribute('href')).path
        response = page.request.get(url)
        assert response.status == 200, (kind, response.status)
        body = response.body()
        if kind != 'html':
            assert body == (OUT / name).read_bytes(), kind
        viewer = browser.new_page(viewport={'width': 800, 'height': 600})
        viewer.goto(url)
        if kind == 'image':
            viewer.wait_for_function('document.images[0] && document.images[0].naturalWidth === 640')
            detail = viewer.evaluate('({width:document.images[0].naturalWidth,height:document.images[0].naturalHeight})')
        elif kind == 'video':
            viewer.wait_for_function('document.querySelector("video")?.readyState >= 2')
            viewer.evaluate('async () => { const v=document.querySelector("video"); v.muted=true; await v.play(); }')
            viewer.wait_for_function('document.querySelector("video").currentTime > 0.2')
            detail = viewer.evaluate('({width:document.querySelector("video").videoWidth,duration:document.querySelector("video").duration,time:document.querySelector("video").currentTime})')
            assert detail['width'] == 320 and detail['duration'] >= 1.9
        elif kind == 'html':
            expect(viewer.get_by_role('heading', name='Local QA media')).to_be_visible()
            detail = {'heading': viewer.locator('h1').inner_text()}
        else:
            viewer.wait_for_timeout(1500)
            detail = {'content_type': response.headers['content-type'], 'bytes_equal': True, 'native_pdf_embed': sum(frame.locator('embed').count() for frame in viewer.frames)}
            assert detail['native_pdf_embed'] >= 1
        viewer.screenshot(path=str(OUT / f'render-{kind}.png'))
        viewer.close()
        results.append({'kind': kind, 'url': url, 'status': response.status, 'detail': detail})
    assert not errors, errors
    (OUT / 'results.json').write_text(json.dumps({'checks': results, 'pageerrors': errors, 'failed_resources': resources}, indent=2))
    print(json.dumps({'checks': results, 'pageerrors': errors, 'failed_resources': resources}, indent=2))
    browser.close()
