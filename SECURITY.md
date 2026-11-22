# Security

## What the app is

A static, client-only web app. There is no server-side code, no accounts, no
cookies, no analytics, and no third-party code. Microphone audio is analysed
in memory on the device and is **never stored or sent anywhere**. The only
data kept is your kit layout, targets and last readings, in the browser's
`localStorage` on your phone.

## Threat model and controls

| Threat | Control |
|---|---|
| Cross-site scripting (XSS) | No HTML-string APIs anywhere. The DOM is built with `createElement`/`textContent` (`js/dom.js`), which also refuses `on*`, `style` and non-local URL attributes. CSP enforces **Trusted Types** (`require-trusted-types-for 'script'`), so the browser itself blocks `innerHTML` and similar sinks. |
| Script injection / third-party compromise | CSP `default-src 'none'; script-src 'self'`: no inline scripts, no `eval`, no CDNs. Script URLs (service worker, audio worklet) go through a Trusted Types policy that allows exactly those two same-origin files (`js/trusted.js`). |
| Tampered or corrupt local storage | All stored data is treated as untrusted. It's parsed in `try/catch`, size-capped, checked field by field against allow-lists and numeric ranges, and rebuilt into new objects (no merging, so no prototype pollution). Unknown keys are dropped. |
| Malicious URL fragments (`#/tune/...`) | Routes are matched against a strict regex and must name a drum that exists. Anything else shows the home screen. The fragment is never written into the page. |
| Clickjacking | The app refuses to run inside a frame (`window.top !== window.self`). CSP `frame-ancestors` can't be set from a `<meta>` tag, and GitHub Pages doesn't allow custom headers. |
| Data exfiltration | CSP `connect-src 'self'`, `img-src 'self'`, `form-action 'none'`, `base-uri 'none'`, and `<meta name="referrer" content="no-referrer">`. The app makes no network requests apart from loading its own files. |
| Service worker abuse / cache poisoning | The SW handles only same-origin `GET` requests within its scope and only caches successful `basic` responses. Old caches are deleted on update. |
| Microphone misuse | The mic is opened only after an explicit tap, stops when you leave the tuning screen or switch apps, and the audio never leaves the device. |
| Supply chain (CI) | GitHub Actions pinned to commit SHAs, least-privilege `permissions`, `persist-credentials: false`, Dependabot for updates. Only `app/` is deployed, never tests or tooling. |

## Hosting notes / known limits

* **Security headers.** GitHub Pages can't send custom headers, so the CSP is
  delivered by `<meta>` tag. That means no `frame-ancestors`, no
  `Permissions-Policy` and no `X-Content-Type-Options` header (GitHub Pages
  already sends `nosniff`). HTTPS is enforced and `github.io` is HSTS-preloaded.
  Hosting on Cloudflare Pages instead would allow a `_headers` file to add
  these.
* **Shared origin.** All of a user's GitHub Pages project sites share one
  origin (`<user>.github.io`), so another of *your own* Pages repos could read
  this app's localStorage. Nothing sensitive is stored. A custom domain or
  Cloudflare Pages gives the app its own origin.

## Verifying

`python tests/test_app.py` includes automated security checks: no CSP
violations during normal use, Trusted Types and `eval` blocked, foreign script
URLs refused, hostile storage payloads (XSS strings, `__proto__`, huge numbers,
wrong types) handled safely, and hostile URL fragments ignored.

## Reporting

Please open a private security advisory on the GitHub repository.
