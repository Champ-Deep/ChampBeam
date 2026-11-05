"""Live Better Auth flow against local `wrangler dev` behind Vite (t_92e28dcb).

Run: worker on 127.0.0.1:8799 (.dev.vars with throwaway values, BETTER_AUTH_URL=http://127.0.0.1:3121),
Vite on 127.0.0.1:3121 with VITE_API_URL=/api/v1, and a local org with slug champions-group.
Writes screenshots to qa/screenshots/ and prints one line per assertion.
"""
import json, sys, time
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:3121"
OUT = Path(__file__).parent / "screenshots"
OUT.mkdir(exist_ok=True)
EMAIL = f"qa-{int(time.time())}@example.invalid"
PASSWORD = "throwaway-pass-123"
results, errors, bad = [], [], []
# Known and not this card: the Worker has no /api/v1/assistant/config route (404 on the base branch too).
EXPECTED = {("GET", "/api/v1/assistant/config", 404), ("POST", "/api/auth/sign-in/email", 401)}


def check(name, ok, detail=""):
    results.append((name, bool(ok)))
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""))


def session(page):
    return page.evaluate("fetch('/api/auth/get-session').then(r => r.json())")


def watch(page):
    page.on("console", lambda m: m.type == "error" and errors.append(f"{page.url} {m.text}"))
    page.on("pageerror", lambda e: errors.append(f"{page.url} {e}"))
    page.on("response", lambda r: r.status >= 400 and bad.append((r.request.method, r.url.replace(BASE, "").split("?")[0], r.status)))


def open_switcher(page):
    page.get_by_role("button", name="Switch workspace", exact=False).click()
    page.get_by_role("menuitem", name="Personal").wait_for()


with sync_playwright() as p:
    browser = p.chromium.launch()

    # Signed-out: protected route bounces to /sign-in and stays there.
    for w, h in [(375, 812), (768, 1024), (1440, 900)]:
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=w < 700, has_touch=w < 700)
        page = ctx.new_page(); watch(page)
        page.goto(f"{BASE}/links", wait_until="networkidle")
        page.wait_for_timeout(800)
        check(f"{w}: /links redirects to /sign-in", page.url.endswith("/sign-in"), page.url)
        check(f"{w}: no Google button without VITE_GOOGLE_CLIENT_ID", page.get_by_role("button", name="Continue with Google").count() == 0)
        check(f"{w}: no forgot-password or magic-link link (D2 = B)", page.get_by_text("forgot", exact=False).count() == 0 and page.get_by_text("magic", exact=False).count() == 0)
        page.screenshot(path=str(OUT / f"sign-in-{w}.png"), full_page=True)
        if w == 375:
            page.get_by_role("button", name="Sign in").click()
            check("375: inline errors on empty submit", page.get_by_text("Enter a valid email address.").is_visible() and page.get_by_text("Enter your password.").is_visible())
            heights = page.evaluate("[...document.querySelectorAll('input, button')].map(e => Math.round(e.getBoundingClientRect().height))")
            check("375: inputs and buttons are at least 44px tall", min(heights) >= 44, str(heights))
            page.screenshot(path=str(OUT / "sign-in-375-errors.png"), full_page=True)
        ctx.close()

    # Tab focus refetches the session (Better Auth rate limit 5 s); a guest's typed form must survive it.
    for path in ("/sign-in", "/sign-up"):
        for w in (375, 1440):
            ctx = browser.new_context(viewport={"width": w, "height": 900})
            page = ctx.new_page(); watch(page)
            refetch = []
            page.on("request", lambda r: "/get-session" in r.url and refetch.append(r.url))
            page.goto(BASE + path, wait_until="networkidle")
            page.get_by_label("Email").fill("half-typed@example.invalid")
            n = len(refetch)
            page.wait_for_timeout(6000)
            page.evaluate("""() => { for (const v of ['hidden', 'visible']) {
              Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
              document.dispatchEvent(new Event('visibilitychange')); } }""")
            page.wait_for_timeout(1500)
            check(f"{w}: {path} keeps the typed email after a focus refetch",
                  len(refetch) > n and page.get_by_label("Email").input_value() == "half-typed@example.invalid",
                  f"refetches={len(refetch) - n} value={page.get_by_label('Email').input_value()!r}")
            ctx.close()

    # Sign up, org switch and back, sign out, sign in. Desktop rail at 1440.
    ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
    page = ctx.new_page(); watch(page)
    api_calls = []
    page.on("request", lambda r: "/api/v1/" in r.url and api_calls.append(r.url.split("/api/v1")[1].split("?")[0]))
    page.goto(f"{BASE}/sign-up", wait_until="networkidle")
    page.get_by_label("Name").fill("QA Member")
    page.get_by_label("Email").fill(EMAIL)
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Create account").click()
    page.wait_for_url(f"{BASE}/", timeout=15000)
    page.get_by_role("button", name="Account menu for", exact=False).wait_for(timeout=15000)
    s = session(page)
    check("sign up lands signed in on /", s and s["user"]["email"] == EMAIL, s and s["user"]["email"])
    check("session starts in Personal (activeOrganizationId null)", s and s["session"].get("activeOrganizationId") is None)

    page.wait_for_load_state("networkidle")
    open_switcher(page)
    items = page.get_by_role("menuitem").all_inner_texts()
    check("switcher lists Personal first", items and items[0].strip() == "Personal", str(items))
    check("Champions Group listed", any("Champions Group" in i for i in items), str(items))
    active = page.locator("[role=menuitem][aria-current=true]").all_inner_texts()
    check("check mark on Personal", active == ["Personal"] and page.locator("[role=menuitem][aria-current=true] [aria-label=Active]").count() == 1, str(active))
    page.screenshot(path=str(OUT / "org-switcher-1440.png"))

    before = len(api_calls)
    page.get_by_role("menuitem", name="Champions Group").click()
    page.wait_for_function("fetch('/api/auth/get-session').then(r => r.json()).then(s => !!s.session.activeOrganizationId)", timeout=10000)
    page.get_by_role("link", name="Library").wait_for(timeout=10000)
    page.wait_for_load_state("networkidle")
    after_switch = api_calls[before:]
    s = session(page)
    check("switch sets activeOrganizationId to the org", s["session"]["activeOrganizationId"] == "11111111-1111-4111-8111-111111111111")
    check("cache cleared on switch: profile and lists refetched", "/org/profile" in after_switch and "/files" in after_switch, str(sorted(set(after_switch))))
    check("org-only nav (Library) appears in the org", page.get_by_role("link", name="Library").is_visible())
    open_switcher(page)
    active = page.locator("[role=menuitem][aria-current=true]").all_inner_texts()
    check("check mark moves to Champions Group", active == ["Champions Group"], str(active))
    page.screenshot(path=str(OUT / "org-switcher-1440-org-active.png"))

    before = len(api_calls)
    page.get_by_role("menuitem", name="Personal").click()
    page.wait_for_function("fetch('/api/auth/get-session').then(r => r.json()).then(s => s.session.activeOrganizationId === null)", timeout=10000)
    page.wait_for_load_state("networkidle")
    page.wait_for_timeout(500)
    back = api_calls[before:]
    check("back to Personal clears activeOrganizationId", session(page)["session"]["activeOrganizationId"] is None)
    check("cache cleared on switch back: profile refetched", "/org/profile" in back and "/files" in back, str(sorted(set(back))))
    check("Library hidden in Personal", page.get_by_role("link", name="Library").count() == 0)

    page.get_by_role("button", name="Account menu for", exact=False).click()
    check("account menu shows the email", page.get_by_text(EMAIL).is_visible())
    page.screenshot(path=str(OUT / "account-menu-1440.png"))
    page.get_by_role("menuitem", name="Sign out").click()
    page.get_by_role("button", name="Sign In").first.wait_for(timeout=10000)
    check("sign out ends the session", session(page) is None)

    page.goto(f"{BASE}/sign-in", wait_until="networkidle")
    page.get_by_label("Email").fill(EMAIL)
    page.get_by_label("Password").fill("wrong-password-1")
    page.get_by_role("button", name="Sign in").click()
    page.get_by_text("Email or password is incorrect.").wait_for(timeout=10000)
    check("wrong password shows inline error", page.get_by_label("Password").get_attribute("aria-invalid") == "true")
    page.get_by_label("Password").fill(PASSWORD)
    page.get_by_role("button", name="Sign in").click()
    page.wait_for_url(f"{BASE}/", timeout=15000)
    page.get_by_role("button", name="Account menu for", exact=False).wait_for(timeout=15000)
    check("sign in with the right password", session(page)["user"]["email"] == EMAIL)
    state = ctx.storage_state()
    cookie = [c for c in state["cookies"] if "session_token" in c["name"]]
    check("session cookie is HttpOnly champbeam.session_token", cookie and cookie[0]["name"] == "champbeam.session_token" and cookie[0]["httpOnly"], cookie and cookie[0]["name"])
    ctx.close()

    # Open switcher at 768 (desktop rail) and 375 (mobile drawer), signed in from the same storage state.
    for w, h in [(768, 1024), (375, 812)]:
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2, is_mobile=w < 700, has_touch=w < 700, storage_state=state)
        page = ctx.new_page(); watch(page)
        page.goto(f"{BASE}/", wait_until="networkidle")
        if w < 768:
            page.get_by_role("button", name="Open menu").click()
            page.locator("dialog.cb-mobile-menu").wait_for()
        open_switcher(page)
        page.wait_for_timeout(300)
        box = page.locator("[role=menu]").bounding_box()
        check(f"{w}: switcher menu inside viewport", box and box["x"] >= 0 and box["x"] + box["width"] <= w + 1, str(box))
        sizes = page.evaluate("[...document.querySelectorAll('[role=menuitem]')].map(e => Math.round(e.getBoundingClientRect().height))")
        check(f"{w}: switcher items at least 44px", sizes and min(sizes) >= 44, str(sizes))
        # A body portal sits under a modal <dialog>'s top layer: the box exists but nothing is painted or clickable.
        hit = "(() => { const r = document.querySelector('[role=menu]').getBoundingClientRect(); return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('[role=menu]'); })()"
        check(f"{w}: switcher menu is on top (hit test)", page.evaluate(hit))
        page.get_by_role("menuitem", name="Champions Group").click()
        page.wait_for_function("fetch('/api/auth/get-session').then(r => r.json()).then(s => !!s.session.activeOrganizationId)", timeout=10000)
        check(f"{w}: tapping Champions Group switches the workspace", True)
        page.evaluate("fetch('/api/auth/organization/set-active', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({organizationId: null})})")
        page.goto(f"{BASE}/", wait_until="networkidle")
        if w < 768:
            page.get_by_role("button", name="Open menu").click()
            page.locator("dialog.cb-mobile-menu").wait_for()
        open_switcher(page)
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / f"org-switcher-{w}.png"))
        ctx.close()
    browser.close()

real = [e for e in errors if "Failed to load resource" not in e]
check("console free of script errors", not real, json.dumps(real[:5]))
unexpected = [r for r in bad if r not in EXPECTED]
check("no failed requests except the known ones", not unexpected, json.dumps(unexpected[:5]) + f" expected-only: {sorted(set(bad))}")
failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
