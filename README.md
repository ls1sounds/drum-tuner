# Drum Tuner

A phone app for tuning a drum kit with the microphone. Enter your toms (sizes,
single or double headed), snare and kick. The app suggests target pitches and
then listens as you tap each lug and each head.

It's a **Progressive Web App (PWA)**: a website that installs to your home
screen, opens full-screen like a normal app, and works offline.

## Install on your phone

1. Open the app's GitHub Pages link in **Chrome** on Android.
2. Menu (⋮) → **Add to Home screen** → **Install**.
3. Open it from the icon and allow the microphone when asked.

## How tuning works

For each drum the app walks you through these steps:

| Step | What you do | What the app checks |
|---|---|---|
| Top lugs / Bottom lugs | Mute the other head and tap ~1″ in from each lug | All lugs match each other (relative) |
| Top pitch / Bottom pitch | Tap the centre of one head (other muted) | Head is near its estimated target |
| Whole drum | Both heads free, hit the centre normally | The drum's main pitch vs. your target |

* **Targets** come from typical tunings for each drum size (`app/js/tuning.js`).
  Toms are spaced at an even musical interval (auto-picked, or minor 3rd /
  major 3rd / 4th) and snapped to real notes. You can set your own target on
  any drum.
* The **bottom vs top head** setting (higher / equal / lower) sets how far the
  bottom head sits from the top head.
* The **snare** is tuned by its heads; the bottom head sits about a 4th–5th
  above the top.

## Project layout

```
app/                    ← everything that gets published
  index.html            page shell + security policy
  manifest.webmanifest  makes it installable (name, icons, colours)
  sw.js                 service worker: offline support
  css/app.css           styling (dark + light theme)
  js/app.js             screens and user interaction
  js/detector.js        pitch detection: hit detection + FFT + peak picking
  js/tuning.js          drum knowledge: target pitches per size
  js/storage.js         saving to the phone, with input validation
  js/mic.js             microphone access + "hear the target" tone
  js/capture-worklet.js runs on the audio thread, streams mic samples
  js/dom.js             safe helper to build page elements
  js/trusted.js         Trusted Types policy (security)
  icons/                app icons
tests/                  automated tests (not published)
.github/workflows/      GitHub Actions: test, then deploy to Pages
```

There is no build step. The files in `app/` are exactly what the browser runs.

## Pitch detection in a nutshell

1. Watch the mic level in ~5 ms blocks. A sudden jump well above the background
   noise is a hit.
2. Skip the first 30 ms (the stick click), then take up to 400 ms of the
   ringing drum.
3. Window it (Hann), zero-pad it and run an FFT to get the spectrum.
4. Find the peaks. For pitch steps, pick the lowest strong peak (the
   fundamental). For lug steps, lock on to the peak near the other lugs'
   readings so every lug is compared on the same vibration mode.
5. Refine the peak position between FFT bins (parabolic interpolation) to get
   sub-Hz accuracy.

## Run it on your computer

Browsers only allow the microphone on `https://` or `localhost`:

```bash
cd app
python -m http.server 8000
# open http://localhost:8000
```

## Tests

```bash
pip install -r tests/requirements.txt
python tests/test_detector.py   # accuracy on synthetic drum hits
python tests/test_app.py        # full app in Chrome with a fake microphone + security checks
```

`test_app.py` saves screenshots to `tests/screenshots/`.

## Deploying

Every push to `main` runs the tests in GitHub Actions and, if they pass,
publishes `app/` to GitHub Pages. When you change app files, bump `VERSION`
in `app/sw.js` so installed copies pick up the update. The update shows up
the second time you open the app.

## Ideas for next steps

* Wrap it as a real Android `.apk` with [Capacitor](https://capacitorjs.com/)
  to learn the Android Studio toolchain.
* Save several tunings per kit (e.g. "jazz gig" vs "rock").
* Show a tuning history graph per drum.
