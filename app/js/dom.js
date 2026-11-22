// dom.js — a tiny, safe helper for building page elements.
//
// SECURITY: the app never uses innerHTML / outerHTML / insertAdjacentHTML /
// document.write. Text always goes in via textContent, so even if some text
// contained "<script>", it would show up as plain characters, never run.
// The page's Content-Security-Policy also enforces "Trusted Types", which makes
// the browser itself refuse those HTML-injection functions.

const SVG_NS = 'http://www.w3.org/2000/svg';
const BLOCKED_ATTR = /^(on|style$|srcdoc$|formaction$)/i;
const URL_ATTRS = new Set(['href', 'src', 'xlink:href', 'action']);

function apply(el, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.setAttribute('class', String(value));
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'on') {
      // Event listeners are attached as real functions, never as strings.
      for (const [evt, fn] of Object.entries(value)) el.addEventListener(evt, fn);
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) el.dataset[k] = String(v);
    } else if (key in PROP_KEYS && !(el instanceof SVGElement)) {
      el[key] = value; // value, checked, disabled, selected, type ...
    } else {
      if (BLOCKED_ATTR.test(key)) throw new Error(`Refusing unsafe attribute: ${key}`);
      if (URL_ATTRS.has(key) && !/^(#|\.\/|[a-z0-9_-]+\.(svg|png|html)$)/i.test(String(value))) {
        throw new Error(`Refusing non-local URL in ${key}`);
      }
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

const PROP_KEYS = { value: 1, checked: 1, disabled: 1, selected: 1, type: 1, min: 1, max: 1, step: 1 };

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** h('div', {class: 'x'}, 'text', childEl) → <div class="x">text…</div> */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, children);
  return el;
}

/** Same as h() but for SVG drawings. */
export function svg(tag, props, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, props);
  append(el, children);
  return el;
}

/** Remove all children and add new ones. */
export function replaceChildren(el, ...children) {
  el.replaceChildren();
  append(el, children);
}
