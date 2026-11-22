"""End-to-end tests: drives the real app in Chrome with a fake microphone.

Chrome can replace the microphone with a WAV file, so we generate drum hits at
known pitches and check the app reports them. Also checks security: no CSP
violations, Trusted Types enforced, tampered storage and URLs are harmless,
and the app works offline.

    pip install playwright numpy
    python tests/test_app.py           (screenshots go to tests/screenshots/)
"""
import json
import os
import re
import sys
import tempfile

from server import serve, browser
from synth import drum_hit, sequence, to_wav_bytes

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "screenshots")
PHONE = {"viewport": {"width": 412, "height": 915}, "device_scale_factor": 2,
         "is_mobile": True, "has_touch": True}

failures = []


def check(cond, name, detail=""):
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail else ""))
    if not cond:
        failures.append(name)


# Recorded in every page before any app code runs.
WATCH = """
window.__violations = [];
document.addEventListener('securitypolicyviolation', e =>
  window.__violations.push(e.violatedDirective + ' ' + e.blockedURI));
"""


def new_context(b, **kw):
    ctx = b.new_context(**PHONE, **kw)
    ctx.add_init_script(WATCH)
    return ctx


def watch_errors(page, sink):
    page.on("pageerror", lambda e: sink.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and sink.append(f"console: {m.text}"))


def make_wav(path, f0, strike="center", n=12):
    hits = [drum_hit(f0, strike=strike, seed=i) for i in range(n)]
    with open(path, "wb") as fh:
        fh.write(to_wav_bytes(sequence(hits, gap=1.2, lead=0.5, gain=0.4)))


def poll(fn, timeout=20.0, interval=0.25):
    """Wait until fn() is truthy (Playwright's wait_for_function needs eval,
    which our CSP correctly forbids)."""
    import time
    end = time.time() + timeout
    while time.time() < end:
        v = fn()
        if v:
            return v
        time.sleep(interval)
    raise TimeoutError("condition not met")


def run_flow(base, b, tmp):
    os.makedirs(SHOTS, exist_ok=True)
    errors = []
    ctx = new_context(b)
    page = ctx.new_page()
    watch_errors(page, errors)
    app = base + "/app/"
    page.goto(app)

    # --- first run lands on setup -----------------------------------------
    page.wait_for_selector("text=Your kit")
    check("#/setup" in page.url, "first launch opens kit setup")
    page.screenshot(path=os.path.join(SHOTS, "1-setup.png"), full_page=True)

    # Configure: 4 toms (add one: 10,12,16 + 18? -> we set sizes 8,10,12,16)
    page.click("text=+ Add tom")
    tom_selects = page.locator(".tom-row select").all()
    check(len(tom_selects) == 8, "4 toms shown after adding one", str(len(tom_selects)))
    page.locator(".tom-row").nth(3).locator("select").first.select_option("8")
    # Tom 2 (12") single-headed
    page.locator(".tom-row").nth(1).locator("text=Has a bottom (resonant) head").click()
    page.click("text=Save kit")
    page.wait_for_selector(".drum-list")
    cards = page.locator(".drum-card")
    names = [c.locator(".drum-name").inner_text() for c in cards.all()]
    check(names == ["Snare", "Rack tom 1", "Rack tom 2", "Rack tom 3", "Floor tom", "Kick"],
          "kit list in order", str(names))
    page.screenshot(path=os.path.join(SHOTS, "2-kit.png"), full_page=True)

    # Toms descend in pitch
    hz = [float(re.sub(r"[^\d.]", "", c.locator(".target-hz").inner_text())) for c in cards.all()[1:5]]
    check(all(a > b2 for a, b2 in zip(hz, hz[1:])), "tom targets descend", str(hz))

    # Persistence across reload
    page.reload()
    page.wait_for_selector(".drum-list")
    check(page.locator(".drum-card").count() == 6, "kit persists after reload")

    # Single-headed tom has 2 steps only
    page.locator(".drum-card", has_text="Rack tom 3").click()   # the 12" we made single-headed
    page.wait_for_selector(".steps")
    steps = page.locator(".step").all_inner_texts()
    check(len(steps) == 2, "single-head tom has 2 steps", str(steps))
    page.click("text=‹ Kit")
    page.wait_for_selector(".drum-list")

    # Setting a custom target
    page.locator(".drum-card", has_text="Floor tom").click()
    page.locator(".step", has_text="Whole drum").click()
    page.click("text=Set my own target")
    page.fill(".num-input", "99999")
    page.click("button:has-text('Save')")
    check(page.locator("text=Enter a number between").is_visible(), "rejects out-of-range target")
    page.fill(".num-input", "92.5")
    page.click("button:has-text('Save')")
    page.wait_for_selector("text=92 Hz", timeout=3000) if page.locator("text=93 Hz").count() == 0 else None
    tgt = page.locator(".target-big").inner_text()
    check(tgt in ("92 Hz", "93 Hz"), "custom target saved", tgt)
    page.screenshot(path=os.path.join(SHOTS, "3-target.png"), full_page=True)

    violations = page.evaluate("window.__violations")
    check(not violations, "no CSP violations during UI flow", str(violations))
    check(not errors, "no JS errors during UI flow", "; ".join(errors[:5]))
    ctx.close()


def run_mic(base, tmp, wav, f0, step_label, strike, expect_lugs=False):
    """Launch Chrome with a fake mic playing `wav`, open a drum, check reading."""
    args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={wav}", "--autoplay-policy=no-user-gesture-required"]
    errors = []
    with browser(args) as b:
        ctx = new_context(b, permissions=["microphone"])
        page = ctx.new_page()
        watch_errors(page, errors)
        page.goto(base + "/app/")
        page.wait_for_selector("text=Save kit")
        page.click("text=Save kit")
        page.locator(".drum-card", has_text="Rack tom 2").click()   # 12" tom
        page.locator(".step", has_text=step_label).click()
        page.click("text=Start listening")
        page.wait_for_selector("text=Stop listening")
        if expect_lugs:
            poll(lambda: page.locator(".lug-row .lug-action.good, .lug-row .lug-action.ok, .lug-row .lug-action.bad").count() >= 4)
            vals = [float(v.split()[0]) for v in page.locator(".lug-row span:nth-child(2)").all_inner_texts() if v != "—"]
            page.screenshot(path=os.path.join(SHOTS, "5-lugs.png"), full_page=True)
            spread = max(vals) / min(vals)
            check(len(vals) >= 4 and spread < 1.01, "lug readings consistent with fake mic",
                  ", ".join(f"{v:.1f}" for v in vals))
            check(page.locator("text=Lugs are even").count() + page.locator("text=Spread:").count() > 0,
                  "lug summary shown")
        else:
            poll(lambda: page.locator(".big-hz").count() and re.search(r"\d", page.locator(".big-hz").inner_text()))
            page.wait_for_timeout(2500)  # let a couple more hits arrive
            got = float(page.locator(".big-hz").inner_text().split()[0])
            page.screenshot(path=os.path.join(SHOTS, "4-whole-drum.png"), full_page=True)
            cents = 1200 * abs(__import__("math").log2(got / f0))
            check(cents < 15, f"fake mic {f0} Hz read correctly", f"{got} Hz, {cents:.1f} cents")
            check(page.locator(".advice").count() >= 1, "tighten/loosen advice shown")
        page.click("text=Stop listening")
        page.wait_for_selector("text=Start listening")
        violations = page.evaluate("window.__violations")
        check(not violations, "no CSP violations with mic running", str(violations))
        check(not errors, "no JS errors with mic running", "; ".join(errors[:5]))
        ctx.close()


def run_security(base, b):
    errors = []
    ctx = new_context(b)
    page = ctx.new_page()
    watch_errors(page, errors)
    app = base + "/app/"
    page.goto(app)
    page.wait_for_selector("text=Your kit")

    # Trusted Types should make HTML-injection sinks throw.
    tt = page.evaluate("""() => { try { document.body.insertAdjacentHTML('beforeend', '<b>x</b>'); return 'allowed'; }
                               catch (e) { return 'blocked'; } }""")
    check(tt == "blocked", "Trusted Types blocks HTML injection sinks", tt)
    # (Code run by the test driver itself bypasses CSP, so test via a string
    # timer, which the page compiles later under its own policy.)
    page.evaluate("() => { try { setTimeout('window.__evalRan = 1', 0); } catch (e) {} }")
    page.wait_for_timeout(300)
    ev = page.evaluate("() => window.__evalRan ? 'ran' : 'blocked'")
    check(ev == "blocked", "CSP blocks eval / string timers", ev)
    inline = page.evaluate("""() => new Promise(r => { const s = document.createElement('script');
        try { s.src = 'data:text/javascript,window.__pwned=1'; } catch (e) { return r('blocked'); }
        s.onerror = () => r('blocked'); s.onload = () => r(window.__pwned ? 'ran' : 'blocked');
        document.head.append(s); })""")
    check(inline == "blocked", "foreign script URL refused", inline)

    # Tampered storage: XSS strings, prototype pollution, absurd values.
    evil = '"><img src=x onerror="window.__pwned=1">'
    payload_kit = {
        "__proto__": {"polluted": True},
        "constructor": {"prototype": {"polluted": True}},
        "tension": evil, "style": evil, "interval": evil,
        "snare": {"id": evil, "diameter": 1e308, "depth": -5, "lugs": "10", "override": evil},
        "toms": [{"id": evil, "diameter": evil, "reso": "yes", "lugs": 1e9, "override": -1}] * 50
                + [{"id": "tom-a", "diameter": 12}, {"id": "tom-a", "diameter": 13}],
        "kick": {"enabled": evil, "diameter": 23, "override": 1e12},
    }
    readings = {"snare": {"batterLugs": [evil, 1e9, -3, None, 200], "batter": evil},
                "__proto__": {"polluted": True}, evil: {"drum": 100}}
    page.evaluate("""([k, r]) => {
        localStorage.setItem('drumTuner.kit.v1', k);
        localStorage.setItem('drumTuner.readings.v1', r);
        localStorage.setItem('drumTuner.settings.v1', '{"sensitivity": "<script>", "autoAdvance": "x"}');
    }""", [json.dumps(payload_kit).replace('"__proto__"', '"__proto__"'), json.dumps(readings)])
    page.goto("about:blank")
    page.goto(app + "#/")
    page.wait_for_selector(".drum-list")
    pwned = page.evaluate("() => !!window.__pwned || ({}).polluted === true || Object.prototype.polluted === true")
    check(not pwned, "tampered storage: no script ran, no prototype pollution")
    n = page.locator(".drum-card").count()
    check(n == 1 + 8 + 1, "tampered storage: toms capped at 8, app still renders", str(n))
    html = page.content()
    check("onerror" not in html and "<img" not in html, "tampered strings never reach the DOM as markup")
    page.locator(".drum-card").first.click()
    page.wait_for_selector(".steps")
    check(not page.evaluate("!!window.__pwned"), "tune screen with tampered readings is safe")

    # Same corrupted JSON / non-JSON
    page.evaluate("localStorage.setItem('drumTuner.kit.v1', '{not json')")
    page.goto("about:blank")
    page.goto(app + "#/")
    page.wait_for_selector("text=Your kit")
    check(True, "corrupt JSON in storage falls back to defaults")

    # Hostile URL fragments
    for frag in ["#/tune/<img src=x onerror=window.__pwned=1>", "#/tune/javascript:alert(1)",
                 "#/tune/__proto__", "#/tune/" + "a" * 5000, "#\"><svg onload=window.__pwned=1>"]:
        page.goto(app + frag)
        page.wait_for_timeout(200)
    check(not page.evaluate("!!window.__pwned"), "hostile URL fragments are harmless")

    violations = [v for v in page.evaluate("window.__violations")]
    # The deliberate probes above (eval, data: script) are expected violations.
    unexpected = [v for v in violations if not (v.startswith("script-src") and ("eval" in v or "data" in v))
                  and not v.startswith("require-trusted-types-for")]
    check(not unexpected, "no unexpected CSP violations", str(violations))
    ctx.close()


def run_offline(base, b):
    ctx = new_context(b)
    page = ctx.new_page()
    page.goto(base + "/app/")
    page.wait_for_selector("text=Your kit")
    page.click("text=Save kit")
    page.evaluate("() => navigator.serviceWorker.ready.then(() => true)")
    page.reload()  # now controlled by the service worker
    page.wait_for_selector(".drum-list")
    ctx.set_offline(True)
    page.reload()
    ok = page.locator(".drum-list").count() == 1 or page.wait_for_selector(".drum-list", timeout=5000)
    check(bool(ok), "app loads offline after first visit")
    page.locator(".drum-card").nth(1).click()
    page.wait_for_selector(".steps", timeout=5000)
    check(True, "tune screen loads offline")
    ctx.set_offline(False)

    # Manifest is valid & icons exist
    man = page.evaluate("fetch('manifest.webmanifest').then(r => r.json())")
    icons_ok = all(page.evaluate(f"fetch('{i['src']}').then(r => r.ok)") for i in man["icons"])
    check(man["display"] == "standalone" and icons_ok and any(i["sizes"] == "512x512" for i in man["icons"]),
          "manifest valid with installable icons")
    ctx.close()


def main():
    tmp = tempfile.mkdtemp(prefix="drumtest-")
    with serve() as base:
        with browser() as b:
            run_flow(base, b, tmp)
            run_security(base, b)
            run_offline(base, b)
        # 12" tom default target ~128 Hz. Feed whole-drum hits at 131 Hz.
        wav = os.path.join(tmp, "tom131.wav")
        make_wav(wav, 131.0)
        run_mic(base, tmp, wav, 131.0, "Whole drum", "center")
        wav2 = os.path.join(tmp, "lug.wav")
        make_wav(wav2, 128.0, strike="lug", n=14)
        run_mic(base, tmp, wav2, 128.0, "Top lugs", "lug", expect_lugs=True)

    print("\nFAILURES:", len(failures), failures)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
