"""Accuracy tests for js/detector.js.

Runs the real JavaScript detector inside Chrome (via Playwright) and feeds it
synthetic drum hits with known pitches.

    pip install playwright numpy
    python tests/test_detector.py
"""
import base64
import sys

import numpy as np

from server import serve, browser
from synth import drum_hit, sequence

SR = 48000

JS = """
async ({b64, sr, opts, sens}) => {
  const m = await import('/app/js/detector.js');
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const f32 = new Float32Array(u8.buffer);
  const hits = [];
  const d = new m.HitDetector(sr, r => hits.push({freq: r.freq, conf: r.confidence, win: r.windowSec}),
                              {sensitivity: sens});
  d.setAnalysisOptions(opts);
  for (let i = 0; i < f32.length; i += 128) d.push(f32.subarray(i, i + 128));
  return hits;
}
"""


def run(page, sig, opts, sens=0.5):
    b64 = base64.b64encode(sig.astype("<f4").tobytes()).decode()
    return page.evaluate(JS, {"b64": b64, "sr": SR, "opts": opts, "sens": sens})


def cents(a, b):
    return 1200 * np.log2(a / b)


CASES = [
    # name, list of f0s, synth kwargs, analysis opts, tolerance (cents)
    ("rack toms centre hits", [185, 150, 125, 110], {}, {"fmin": 40, "fmax": 600}, 10),
    ("floor toms centre hits", [98, 85, 75], {}, {"fmin": 35, "fmax": 500}, 10),
    ("kick", [55, 60], {"decay": 0.25}, {"fmin": 30, "fmax": 300}, 15),
    ("snare batter (short decay)", [230, 260], {"decay": 0.12}, {"fmin": 100, "fmax": 900}, 15),
    ("snare reso", [345, 420], {"decay": 0.12}, {"fmin": 150, "fmax": 1200}, 15),
    ("two heads slightly detuned", [130], {"second_head": 133}, {"fmin": 40, "fmax": 600}, 25),
    ("strong pitch glide", [110], {"glide": 0.08}, {"fmin": 40, "fmax": 600}, 15),
]


def main():
    failures = 0
    with serve() as base, browser() as b:
        page = b.new_page()
        page.goto(base + "/tests/harness.html")

        for name, f0s, kw, opts, tol in CASES:
            hits = [drum_hit(f, sr=SR, seed=i, **kw) for i, f in enumerate(f0s)]
            sig = sequence(hits, sr=SR)
            res = run(page, sig, {**opts, "mode": "fundamental"})
            ok = len(res) == len(f0s)
            detail = []
            for f, r in zip(f0s, res):
                c = cents(r["freq"], f) if r else 999
                detail.append(f"{f}->{r['freq']:.1f}Hz ({c:+.0f}c, conf {r['conf']:.2f})")
                if abs(c) > tol:
                    ok = False
            failures += not ok
            print(("PASS" if ok else "FAIL"), name, f"[{len(res)} hits]", "; ".join(detail))

        # Lug mode: taps near the edge where an overtone is the loudest peak.
        # What matters is that a lug tuned 3% high reads ~3% high relative to
        # the others (consistency), not which mode we lock on to.
        lug_f = [150, 150, 154.5, 150, 145.5, 150]
        hits = [drum_hit(f, sr=SR, strike="lug", seed=10 + i) for i, f in enumerate(lug_f)]
        sig = sequence(hits, sr=SR)
        # first lug without reference, the rest locked to the first reading
        res0 = run(page, sequence(hits[:1], sr=SR), {"fmin": 60, "fmax": 900, "mode": "strongest"})
        ref = res0[0]["freq"]
        res = run(page, sig, {"fmin": 60, "fmax": 900, "mode": "strongest", "reference": ref})
        rel = [cents(r["freq"], ref) for r in res]
        want = [cents(f, lug_f[0]) for f in lug_f]
        ok = len(res) == len(lug_f) and all(abs(a - w) < 10 for a, w in zip(rel, want))
        failures += not ok
        print(("PASS" if ok else "FAIL"), "lug consistency",
              f"ref {ref:.1f}Hz", ["%+.0f/%+.0f" % (a, w) for a, w in zip(rel, want)])

        # Quiet hits should still register at default sensitivity; background
        # noise alone should not.
        quiet = sequence([drum_hit(120, sr=SR)], sr=SR, gain=0.03, noise=0.002)
        res = run(page, quiet, {"fmin": 40, "fmax": 600})
        ok = len(res) == 1
        failures += not ok
        print(("PASS" if ok else "FAIL"), "quiet hit detected", res)

        noise = np.random.default_rng(5).normal(0, 0.01, SR * 4).astype(np.float32)
        res = run(page, noise, {"fmin": 40, "fmax": 600})
        ok = len(res) == 0
        failures += not ok
        print(("PASS" if ok else "FAIL"), "no false hits on steady noise", len(res))

        # Rapid double hit: should produce a reading, not crash or hang.
        dbl = drum_hit(140, sr=SR) + np.concatenate(
            [np.zeros(int(0.15 * SR)), drum_hit(140, sr=SR, seed=3)[: int(1.05 * SR)]])
        res = run(page, sequence([dbl], sr=SR), {"fmin": 40, "fmax": 600})
        ok = 1 <= len(res) <= 2 and all(abs(cents(r["freq"], 140)) < 15 for r in res)
        failures += not ok
        print(("PASS" if ok else "FAIL"), "rapid double hit", [round(r["freq"], 1) for r in res])

    print("\nFAILURES:", failures)
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
