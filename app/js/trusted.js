// trusted.js — Trusted Types policy.
//
// SECURITY: the page's Content-Security-Policy turns on "Trusted Types".
// With that on, the browser refuses to load a script from a plain string URL
// (and refuses innerHTML etc. entirely). The only way to load a script is
// through this policy, which allows exactly two files from our own site:
// the service worker and the audio worklet. Anything else throws.

const ALLOWED = new Set(['/sw.js', '/js/capture-worklet.js']);

function check(input) {
  const url = new URL(String(input), document.baseURI);
  const appRoot = new URL('../', import.meta.url); // folder containing index.html
  const ok =
    url.origin === location.origin &&
    !url.search &&
    !url.hash &&
    url.pathname.startsWith(appRoot.pathname) &&
    ALLOWED.has('/' + url.pathname.slice(appRoot.pathname.length));
  if (!ok) throw new TypeError(`Blocked script URL: ${url.href}`);
  return url.href;
}

const policy = window.trustedTypes?.createPolicy
  ? window.trustedTypes.createPolicy('drum-tuner', { createScriptURL: check })
  : null;

/** Returns a TrustedScriptURL (or checked string on older browsers). */
export function scriptURL(input) {
  return policy ? policy.createScriptURL(String(input)) : check(input);
}
