// app.js — screens and user interaction.
//
// Three screens, chosen by the part of the URL after "#":
//   #/            → your kit (list of drums with their targets)
//   #/setup       → enter/edit your drums
//   #/tune/<id>   → tune one drum with the microphone
//
// Data flow: kit (what you entered) → computeDrums() → targets → screens.
// Mic samples → HitDetector → one reading per drum hit → shown + saved.

import { h, svg, replaceChildren } from './dom.js';
import { HitDetector, freqToNote, centsBetween } from './detector.js';
import { Mic, playTone } from './mic.js';
import {
  computeDrums, findDrumSettings, defaultLugs, newId,
  TENSION, STYLES, INTERVALS, INTERVAL_NAMES,
} from './tuning.js';
import {
  loadKit, saveKit, loadReadings, saveReadings, loadSettings, saveSettings, clearAll,
  sanitizeReadings, SIZES, SNARE_DEPTHS, MAX_TOMS, LUG_CHOICES, num,
} from './storage.js';
import { scriptURL } from './trusted.js';

// ---------------------------------------------------------------------------
// Refuse to run inside someone else's page (prevents "clickjacking", where a
// malicious site shows this app in an invisible frame to trick taps).
// ---------------------------------------------------------------------------
if (window.top !== window.self) {
  document.body.replaceChildren(document.createTextNode('This app can’t be embedded in another page.'));
  throw new Error('framed');
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------
const root = document.getElementById('app');
const loaded = loadKit();
const state = {
  kit: loaded.kit,
  firstRun: loaded.isNew,
  readings: null,
  settings: loadSettings(),
  drums: [],
  tomInterval: null,
};
state.readings = loadReadings(state.kit);
recompute();

function recompute() {
  const { drums, tomInterval } = computeDrums(state.kit);
  // Display order: snare, toms high→low, kick.
  state.drums = drums;
  state.tomInterval = tomInterval;
}

function persistKit() {
  saveKit(state.kit);
  // Drop readings for drums that no longer exist / resize lug lists.
  state.readings = sanitizeReadings(Object.fromEntries(state.readings), state.kit);
  saveReadings(state.readings);
  recompute();
}

const drumById = (id) => state.drums.find((d) => d.id === id);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const fmtHz = (f, digits = 1) => (f == null ? '—' : `${f.toFixed(digits)} Hz`);
const inch = (d) => `${d}″`;

function noteLabel(f) {
  if (f == null) return '';
  const n = freqToNote(f);
  const c = n.cents === 0 ? '' : ` ${n.cents > 0 ? '+' : '−'}${Math.abs(n.cents)}¢`;
  return `${n.name}${c}`;
}

/** Colour class for a deviation in cents. */
function statusClass(cents, good = 10, ok = 35) {
  const a = Math.abs(cents);
  if (a <= good) return 'good';
  if (a <= ok) return 'ok';
  return 'bad';
}

function median(values) {
  const v = values.filter((x) => x != null).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.sqrt(v[m - 1] * v[m]);
}

// ---------------------------------------------------------------------------
// Microphone + detector (shared by all tuning screens)
// ---------------------------------------------------------------------------
const tuner = {
  mic: null,
  detector: null,
  onHit: null,
  options: {},
  wakeLock: null,
  error: null,

  get running() {
    return !!this.mic?.running;
  },

  async start() {
    this.error = null;
    try {
      this.mic = new Mic((samples) => this.detector?.push(samples));
      await this.mic.start();
      this.detector = new HitDetector(
        this.mic.sampleRate,
        (r) => this.onHit && this.onHit(r),
        { sensitivity: state.settings.sensitivity },
      );
      this.detector.setAnalysisOptions(this.options);
      try {
        this.wakeLock = await navigator.wakeLock?.request('screen');
      } catch {
        /* screen may dim; not critical */
      }
    } catch (err) {
      await this.stop();
      if (err?.name === 'NotAllowedError') {
        this.error = 'Microphone permission was denied. Allow it in your browser’s site settings (tap the icon next to the address), then try again.';
      } else if (err?.name === 'NotFoundError') {
        this.error = 'No microphone was found.';
      } else {
        this.error = `Couldn’t start the microphone. ${err?.message || ''}`;
      }
    }
  },

  async stop() {
    if (this.mic) await this.mic.stop();
    this.mic = null;
    this.detector = null;
    try {
      await this.wakeLock?.release();
    } catch {
      /* ignore */
    }
    this.wakeLock = null;
  },

  setOptions(opts) {
    this.options = opts;
    this.detector?.setAnalysisOptions(opts);
    this.detector?.reset();
  },

  setSensitivity(s) {
    this.detector?.setSensitivity(s);
  },

  get level() {
    return this.detector ? this.detector.level : 0;
  },
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function parseRoute() {
  const hash = location.hash || '#/';
  if (hash === '#/setup') return { view: 'setup' };
  const m = /^#\/tune\/([a-z0-9-]{1,40})$/.exec(hash);
  if (m && drumById(m[1])) return { view: 'tune', id: m[1] };
  return { view: 'home' };
}

let cleanupView = null;

async function render() {
  if (cleanupView) {
    await cleanupView();
    cleanupView = null;
  }
  const route = parseRoute();
  if (state.firstRun && route.view === 'home') {
    location.replace('#/setup');
    return;
  }
  window.scrollTo(0, 0);
  if (route.view === 'setup') renderSetup();
  else if (route.view === 'tune') cleanupView = renderTune(route.id);
  else renderHome();
}

window.addEventListener('hashchange', render);

// ---------------------------------------------------------------------------
// Screen: home (your kit)
// ---------------------------------------------------------------------------
function renderHome() {
  document.title = 'Drum Tuner';
  const cards = state.drums.map((d) => {
    const r = state.readings.get(d.id);
    const target = d.kind === 'snare' ? d.batter : d.fundamental;
    const measured = d.kind === 'snare' ? r?.batter : r?.drum;
    let status = null;
    if (measured != null && target != null) {
      const c = centsBetween(measured, target);
      status = h('span', { class: `pill ${statusClass(c, 15, 40)}` },
        `Last: ${fmtHz(measured, 0)}`);
    }
    const heads = d.hasReso ? '2 heads' : 'single head';
    return h('a', { class: 'drum-card', href: `#/tune/${d.id}` },
      h('div', { class: 'drum-card-main' },
        h('div', { class: 'drum-name' }, d.name),
        h('div', { class: 'drum-meta' },
          d.kind === 'snare' ? `${inch(d.diameter)} × ${d.depth}″ · ${d.lugs} lugs` : `${inch(d.diameter)} · ${heads} · ${d.lugs} lugs`)),
      h('div', { class: 'drum-card-target' },
        h('div', { class: 'target-hz' }, fmtHz(target, 0)),
        h('div', { class: 'target-note' }, d.kind === 'snare' ? `top head · ${noteLabel(target)}` : noteLabel(target)),
        status),
      h('span', { class: 'chev', 'aria-hidden': 'true' }, '›'));
  });

  const intervalText = state.tomInterval
    ? `Toms spaced a ${INTERVAL_NAMES[state.tomInterval]} apart`
    : null;

  replaceChildren(root,
    h('header', { class: 'topbar topbar-home' },
      h('h1', {}, 'Drum Tuner'),
      h('a', { class: 'btn btn-ghost', href: '#/setup' }, 'Edit kit')),
    h('section', { class: 'summary' },
      h('span', { class: 'chip' }, TENSION[state.kit.tension].label),
      h('span', { class: 'chip' }, STYLES[state.kit.style].label),
      intervalText && h('span', { class: 'chip' }, intervalText)),
    h('nav', { class: 'drum-list', 'aria-label': 'Drums' }, cards),
    h('section', { class: 'tips' },
      h('h2', {}, 'How to use'),
      h('ol', {},
        h('li', {}, 'Pick a drum.'),
        h('li', {}, 'Even out each head: tap near every lug and match them.'),
        h('li', {}, 'Bring each head to its target pitch.'),
        h('li', {}, 'Check the whole drum and fine-tune by ear.')),
      h('p', { class: 'muted' },
        'Targets are starting points based on typical tunings for each size. Trust your ears — you can set your own target on any drum.')),
  );
}

// ---------------------------------------------------------------------------
// Screen: setup (enter your kit)
// ---------------------------------------------------------------------------
function select(label, value, options, onChange, fmt = String) {
  const id = `sel-${Math.random().toString(36).slice(2, 9)}`;
  return h('label', { class: 'field', for: id },
    h('span', { class: 'field-label' }, label),
    h('select', { id, on: { change: (e) => onChange(e.target.value) } },
      options.map((o) => h('option', { value: String(o), selected: String(o) === String(value) }, fmt(o)))));
}

function toggle(label, checked, onChange) {
  return h('label', { class: 'toggle' },
    h('input', { type: 'checkbox', checked, on: { change: (e) => onChange(e.target.checked) } }),
    h('span', { class: 'toggle-track', 'aria-hidden': 'true' }),
    h('span', {}, label));
}

function segmented(name, value, options, onChange) {
  return h('div', { class: 'segmented', role: 'radiogroup' },
    Object.entries(options).map(([key, opt]) =>
      h('label', { class: 'seg' },
        h('input', { type: 'radio', name, value: key, checked: key === value,
          on: { change: () => onChange(key) } }),
        h('span', {}, typeof opt === 'string' ? opt : opt.label))));
}

function renderSetup() {
  document.title = 'Your kit · Drum Tuner';
  const kit = state.kit;
  const update = () => {
    persistKit();
    renderSetup();
  };

  const tomRows = kit.toms.map((t, i) =>
    h('div', { class: 'tom-row' },
      h('div', { class: 'tom-row-head' },
        h('strong', {}, `Tom ${i + 1}`),
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', 'aria-label': `Remove tom ${i + 1}`,
          on: { click: () => { kit.toms.splice(i, 1); update(); } } }, 'Remove')),
      h('div', { class: 'row-fields' },
        select('Size', t.diameter, SIZES.tom, (v) => {
          t.diameter = Number(v);
          t.lugs = defaultLugs('tom', t.diameter);
          t.override = null;
          update();
        }, inch),
        select('Lugs', t.lugs, LUG_CHOICES, (v) => { t.lugs = Number(v); update(); })),
      toggle('Has a bottom (resonant) head', t.reso, (v) => { t.reso = v; update(); })));

  replaceChildren(root,
    h('header', { class: 'topbar' },
      state.firstRun ? h('span') : h('a', { class: 'btn btn-ghost', href: '#/' }, '‹ Kit'),
      h('h1', {}, 'Your kit'),
      h('span')),

    state.firstRun && h('p', { class: 'intro' },
      'Welcome! Tell the app about your drums. Everything is saved on this phone only.'),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, `Toms (${kit.toms.length})`),
        h('button', {
          class: 'btn btn-small', type: 'button', disabled: kit.toms.length >= MAX_TOMS,
          on: { click: () => {
            const last = kit.toms[kit.toms.length - 1];
            const dia = last ? Math.min(20, last.diameter + 2) : 12;
            const size = SIZES.tom.find((s) => s >= dia) ?? 16;
            kit.toms.push({ id: newId('tom'), diameter: size, reso: true, lugs: defaultLugs('tom', size), override: null });
            update();
          } },
        }, '+ Add tom')),
      tomRows.length ? tomRows : h('p', { class: 'muted' }, 'No toms. Tap “Add tom”.')),

    h('section', { class: 'card' },
      h('h2', {}, 'Snare'),
      h('div', { class: 'row-fields' },
        select('Diameter', kit.snare.diameter, SIZES.snare, (v) => {
          kit.snare.diameter = Number(v); kit.snare.override = null; update();
        }, inch),
        select('Depth', kit.snare.depth, SNARE_DEPTHS, (v) => { kit.snare.depth = Number(v); update(); }, inch),
        select('Lugs', kit.snare.lugs, LUG_CHOICES, (v) => { kit.snare.lugs = Number(v); update(); }))),

    h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('h2', {}, 'Kick'),
        toggle('Include', kit.kick.enabled, (v) => { kit.kick.enabled = v; update(); })),
      kit.kick.enabled && h('div', {},
        h('div', { class: 'row-fields' },
          select('Diameter', kit.kick.diameter, SIZES.kick, (v) => {
            kit.kick.diameter = Number(v); kit.kick.lugs = defaultLugs('kick', kit.kick.diameter);
            kit.kick.override = null; update();
          }, inch),
          select('Lugs', kit.kick.lugs, LUG_CHOICES, (v) => { kit.kick.lugs = Number(v); update(); })),
        toggle('Has a front (resonant) head', kit.kick.reso, (v) => { kit.kick.reso = v; update(); }))),

    h('section', { class: 'card' },
      h('h2', {}, 'Sound'),
      h('div', { class: 'field-label' }, 'Overall tension'),
      segmented('tension', kit.tension, TENSION, (v) => { kit.tension = v; update(); }),
      h('div', { class: 'field-label spaced' }, 'Bottom head vs top head'),
      h('div', { class: 'style-list' },
        Object.entries(STYLES).map(([key, s]) =>
          h('label', { class: `style-option ${key === kit.style ? 'selected' : ''}` },
            h('input', { type: 'radio', name: 'style', value: key, checked: key === kit.style,
              on: { change: () => { kit.style = key; update(); } } }),
            h('span', { class: 'style-text' },
              h('strong', {}, s.label),
              h('span', { class: 'muted' }, s.hint))))),
      select('Spacing between toms', kit.interval, Object.keys(INTERVALS),
        (v) => { kit.interval = v; update(); }, (k) => INTERVALS[k])),

    h('div', { class: 'actions' },
      h('button', { class: 'btn btn-primary btn-block', type: 'button',
        on: { click: () => { state.firstRun = false; persistKit(); location.hash = '#/'; } } },
        state.firstRun ? 'Save kit' : 'Done'),
      !state.firstRun && h('button', { class: 'btn btn-ghost btn-block', type: 'button',
        on: { click: () => {
          if (!confirm('Reset everything (kit, targets and readings) to defaults?')) return;
          clearAll();
          const fresh = loadKit();
          state.kit = fresh.kit;
          state.firstRun = true;
          state.readings = loadReadings(state.kit);
          state.settings = loadSettings();
          recompute();
          renderSetup();
        } } }, 'Reset to defaults')),
  );
}

// ---------------------------------------------------------------------------
// Screen: tune one drum
// ---------------------------------------------------------------------------
function stepsFor(d) {
  const steps = [];
  const top = d.kind === 'kick' ? 'Batter' : 'Top';
  const bottom = d.kind === 'kick' ? 'Front' : 'Bottom';
  steps.push({ key: 'batterLugs', kind: 'lugs', head: 'batter', label: d.hasReso ? `${top} lugs` : 'Lugs',
    approx: d.hasReso ? d.batter : d.fundamental });
  if (d.hasReso) {
    steps.push({ key: 'resoLugs', kind: 'lugs', head: 'reso', label: `${bottom} lugs`, approx: d.reso });
    steps.push({ key: 'batter', kind: 'pitch', label: `${top} pitch`, target: d.batter,
      editable: d.kind === 'snare' });
    steps.push({ key: 'reso', kind: 'pitch', label: `${bottom} pitch`, target: d.reso });
    steps.push({ key: 'drum', kind: 'pitch', label: 'Whole drum', target: d.fundamental,
      editable: d.kind !== 'snare' });
  } else {
    steps.push({ key: 'drum', kind: 'pitch', label: 'Pitch', target: d.fundamental, editable: true });
  }
  return steps;
}

function instructions(d, step) {
  const mute = d.kind === 'kick'
    ? 'Mute the other head (press a hand or pillow against it).'
    : 'Mute the other head: rest the drum on a pillow, towel or your lap, or press a hand against it.';
  const snaresOff = d.kind === 'snare' ? ' Turn the snares off.' : '';
  switch (step.key) {
    case 'batterLugs':
    case 'resoLugs':
      return [
        (d.hasReso ? mute : '') + snaresOff,
        'Lug 1 is the one closest to you; the rest go clockwise. Tap lightly about 1″ (2–3 cm) in from the selected lug, the same way each time. The app moves to the next lug after each tap.',
        'Adjust any lug that’s off (red/yellow) until they all match. They only need to match each other here.',
      ];
    case 'batter':
    case 'reso':
      return [
        `${mute}${snaresOff} Tap the centre of the head lightly.`,
        'Turn every lug by the same amount (e.g. a quarter turn each, in a star pattern) to move toward the target, then re-check the lugs.',
        d.kind === 'snare' ? '' : 'This target is an estimate — the Whole drum step is the real test.',
      ];
    case 'drum':
    default:
      if (d.kind === 'snare') {
        return ['Snares on, both heads free. Hit the centre at normal strength.',
          'There’s no fixed target here — use your ears. The reading lets you get back to this sound later.'];
      }
      return [
        d.hasReso ? 'Unmute both heads. Put the drum on its stand or legs and hit the centre at normal playing strength.'
          : 'Put the drum on its stand and hit the centre at normal playing strength.',
        d.hasReso ? 'If it’s off, raise or lower both heads by about the same amount to keep their relationship.'
          : 'If it’s off, turn every lug the same amount.',
        d.kind === 'kick' ? 'Phone mics struggle with very low notes. If readings jump around, move the phone close to the front head.' : '',
      ];
  }
}

function analysisOptionsFor(d, step, reading) {
  const clamp = (f) => Math.min(2000, Math.max(25, f));
  if (step.kind === 'lugs') {
    const list = reading[step.key];
    const ref = median(list);
    return { fmin: clamp(step.approx / 2.5), fmax: clamp(step.approx * 3.2), mode: 'strongest', reference: ref ?? undefined };
  }
  const t = step.target ?? (d.kind === 'snare' ? d.batter / 1.3 : 100);
  const lowSpan = step.target == null ? 3 : 2;
  return { fmin: clamp(t / lowSpan), fmax: clamp(t * 2.2), mode: 'fundamental' };
}

function renderTune(id) {
  const view = {
    stepIndex: 0,
    activeLug: 0,
    history: [], // recent readings in this step
    lastHit: null,
    message: null,
    editing: false,
    raf: 0,
  };
  let d = drumById(id);
  let steps = stepsFor(d);
  const reading = state.readings.get(id);
  document.title = `${d.name} · Drum Tuner`;

  // Persistent containers (only the parts that change get rebuilt)
  const els = {
    tabs: h('div', { class: 'steps', role: 'tablist' }),
    instr: h('div', { class: 'instructions' }),
    target: h('div', { class: 'target-box' }),
    readout: h('div', { class: 'readout', 'aria-live': 'polite' }),
    detail: h('div', { class: 'detail' }),
    spectrum: h('canvas', { class: 'spectrum', 'aria-label': 'Spectrum of last hit', role: 'img' }),
    micBtn: h('button', { class: 'btn btn-primary mic-btn', type: 'button' }),
    micStatus: h('div', { class: 'mic-status' }),
    level: h('div', { class: 'level-fill' }),
  };

  const step = () => steps[view.stepIndex];

  function firstUnmeasured(list) {
    const i = list.findIndex((v) => v == null);
    return i === -1 ? 0 : i;
  }

  function selectStep(i) {
    view.stepIndex = i;
    view.history = [];
    view.lastHit = null;
    view.message = null;
    view.editing = false;
    const s = step();
    if (s.kind === 'lugs') view.activeLug = firstUnmeasured(reading[s.key]);
    tuner.setOptions(analysisOptionsFor(d, s, reading));
    renderAll();
  }

  function save() {
    reading.at = Date.now();
    saveReadings(state.readings);
  }

  // --- a drum hit arrived from the detector ---------------------------------
  tuner.onHit = (r) => {
    const s = step();
    if (r.confidence < 0.12) {
      view.message = 'Couldn’t hear a clear pitch — try again a little softer or harder.';
      view.lastHit = r;
      renderDynamic();
      return;
    }
    view.message = null;
    view.lastHit = r;
    if (s.kind === 'lugs') {
      const list = reading[s.key];
      list[view.activeLug] = r.freq;
      if (state.settings.autoAdvance) view.activeLug = (view.activeLug + 1) % list.length;
      tuner.setOptions(analysisOptionsFor(d, s, reading)); // lock on to new reference
    } else {
      view.history.unshift(r.freq);
      view.history = view.history.slice(0, 6);
      reading[s.key] = r.freq;
    }
    save();
    renderDynamic();
  };

  // --- rendering --------------------------------------------------------------
  function renderAll() {
    renderTabs();
    const lines = instructions(d, step()).filter(Boolean);
    replaceChildren(els.instr, lines.map((l) => h('p', {}, l)));
    renderTarget();
    renderDynamic();
  }

  function renderTabs() {
    replaceChildren(els.tabs, steps.map((s, i) => {
      const done = s.kind === 'lugs'
        ? reading[s.key].every((v) => v != null)
        : reading[s.key] != null;
      return h('button', {
        class: `step ${i === view.stepIndex ? 'active' : ''} ${done ? 'done' : ''}`,
        type: 'button', role: 'tab', 'aria-selected': String(i === view.stepIndex),
        on: { click: () => selectStep(i) },
      }, h('span', { class: 'step-num' }, String(i + 1)), s.label);
    }));
  }

  function renderTarget() {
    const s = step();
    if (s.kind === 'lugs') {
      replaceChildren(els.target,
        h('div', { class: 'target-line' },
          h('span', { class: 'muted' }, 'Goal'),
          h('strong', {}, 'All lugs the same pitch')));
      return;
    }
    if (s.target == null) {
      replaceChildren(els.target,
        h('div', { class: 'target-line' }, h('span', { class: 'muted' }, 'Target'), h('strong', {}, 'By ear')));
      return;
    }
    const children = [
      h('div', { class: 'target-line' },
        h('span', { class: 'muted' }, s.key === 'drum' ? 'Target' : 'Target ≈'),
        h('strong', { class: 'target-big' }, fmtHz(s.target, 0)),
        h('span', { class: 'muted' }, noteLabel(s.target)),
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', 'aria-label': 'Play target pitch',
          on: { click: () => playTone(s.target) } }, '▶ Hear it')),
    ];
    if (d.warning && s.key === 'drum') children.push(h('p', { class: 'warn' }, d.warning));
    if (s.editable) {
      if (!view.editing) {
        children.push(h('div', { class: 'target-actions' },
          h('button', { class: 'btn btn-small btn-ghost', type: 'button',
            on: { click: () => { view.editing = true; renderTarget(); } } }, 'Set my own target'),
          d.overridden && h('button', { class: 'btn btn-small btn-ghost', type: 'button',
            on: { click: () => setOverride(null) } }, `Use suggested (${fmtHz(d.auto, 0)})`)));
      } else {
        const input = h('input', { type: 'number', inputmode: 'decimal', min: 20, max: 2000, step: 0.5,
          value: String(Math.round(s.target * 10) / 10), 'aria-label': 'Target in hertz', class: 'num-input' });
        const err = h('p', { class: 'warn hidden' });
        const lastVal = reading[s.key];
        children.push(h('form', { class: 'target-edit', novalidate: true,
          on: { submit: (e) => {
            e.preventDefault();
            const v = num(Number.parseFloat(input.value), 20, 2000);
            if (v == null) {
              err.textContent = 'Enter a number between 20 and 2000 Hz.';
              err.classList.remove('hidden');
              return;
            }
            setOverride(v);
          } } },
          input, h('span', { class: 'muted' }, 'Hz'),
          h('button', { class: 'btn btn-small btn-primary', type: 'submit' }, 'Save'),
          lastVal != null && h('button', { class: 'btn btn-small btn-ghost', type: 'button',
            on: { click: () => setOverride(Math.round(lastVal * 10) / 10) } }, `Use last (${fmtHz(lastVal, 1)})`),
          h('button', { class: 'btn btn-small btn-ghost', type: 'button',
            on: { click: () => { view.editing = false; renderTarget(); } } }, 'Cancel'),
          err));
      }
    }
    replaceChildren(els.target, children);
  }

  function setOverride(v) {
    const settings = findDrumSettings(state.kit, d.id);
    settings.override = v;
    persistKit();
    d = drumById(id);
    steps = stepsFor(d);
    view.editing = false;
    tuner.setOptions(analysisOptionsFor(d, step(), reading));
    renderAll();
  }

  function meter(cents) {
    const clamped = Math.max(-100, Math.min(100, cents));
    const needle = h('div', { class: `meter-needle ${statusClass(cents)}` });
    needle.style.left = `${50 + clamped / 2}%`; // CSSOM (allowed by our CSP)
    return h('div', { class: 'meter', 'aria-hidden': 'true' },
      h('div', { class: 'meter-zone' }),
      h('div', { class: 'meter-center' }),
      needle,
      h('span', { class: 'meter-label left' }, 'flat'),
      h('span', { class: 'meter-label right' }, 'sharp'));
  }

  function advice(cents, measured, target) {
    const diff = measured - target;
    const cls = statusClass(cents);
    if (cls === 'good') return h('div', { class: 'advice good' }, '✓ In tune');
    const dir = diff < 0 ? 'Tighten' : 'Loosen';
    return h('div', { class: `advice ${cls}` },
      `${dir} — ${Math.abs(diff).toFixed(1)} Hz ${diff < 0 ? 'low' : 'high'}`);
  }

  function renderDynamic() {
    const s = step();
    renderTabs();
    if (s.kind === 'lugs') renderLugs(s);
    else renderPitch(s);
    drawSpectrum();
  }

  function renderPitch(s) {
    const f = view.lastHit && view.lastHit.confidence >= 0.12 ? view.lastHit.freq : null;
    const shown = f ?? reading[s.key];
    const parts = [];
    if (shown == null) {
      parts.push(h('div', { class: 'big-hz muted' }, '—'),
        h('div', { class: 'note' }, tuner.running ? 'Hit the drum' : 'Start the mic below'));
    } else {
      parts.push(h('div', { class: 'big-hz' }, shown.toFixed(1), h('small', {}, ' Hz')),
        h('div', { class: 'note' }, noteLabel(shown), f == null ? ' · saved reading' : ''));
      if (s.target != null) {
        const c = centsBetween(shown, s.target);
        parts.push(meter(c), advice(c, shown, s.target));
      }
    }
    if (view.message) parts.push(h('div', { class: 'advice bad' }, view.message));
    replaceChildren(els.readout, parts);

    // History & relationships
    const extra = [];
    if (view.history.length) {
      const avg = view.history.length >= 3
        ? Math.exp(view.history.slice(0, 3).reduce((a, v) => a + Math.log(v), 0) / 3) : null;
      extra.push(h('div', { class: 'history' },
        h('span', { class: 'muted' }, 'Recent: '),
        view.history.map((v) => h('span', { class: 'hist' }, v.toFixed(1))),
        avg && h('span', { class: 'muted' }, ` · avg of last 3: ${avg.toFixed(1)} Hz`)));
    }
    if ((s.key === 'reso' || s.key === 'batter') && reading.batter != null && reading.reso != null) {
      const semi = centsBetween(reading.reso, reading.batter) / 100;
      const wanted = centsBetween(d.reso, d.batter) / 100;
      extra.push(h('p', { class: 'muted' },
        `Bottom is ${Math.abs(semi).toFixed(1)} semitones ${semi >= 0 ? 'above' : 'below'} the top (goal: ${Math.abs(wanted).toFixed(1)} ${wanted >= 0 ? 'above' : 'below'}).`));
    }
    if (s.key === 'drum' && d.kind === 'tom') extra.push(neighbourInfo());
    replaceChildren(els.detail, extra);
  }

  function neighbourInfo() {
    const toms = state.drums.filter((x) => x.kind === 'tom');
    const i = toms.findIndex((x) => x.id === d.id);
    const items = [];
    const me = reading.drum;
    for (const other of [toms[i - 1], toms[i + 1]]) {
      if (!other) continue;
      const theirs = state.readings.get(other.id)?.drum;
      if (me == null || theirs == null) continue;
      const semi = Math.abs(centsBetween(me, theirs)) / 100;
      const nearest = Math.round(semi);
      items.push(h('li', {},
        `${other.name}: ${fmtHz(theirs, 0)} — ${semi.toFixed(1)} semitones apart` +
        (INTERVAL_NAMES[nearest] ? ` (≈ ${INTERVAL_NAMES[nearest]})` : '')));
    }
    if (!items.length) return null;
    return h('div', {}, h('div', { class: 'field-label' }, 'Next to its neighbours'), h('ul', { class: 'plain' }, items));
  }

  function renderLugs(s) {
    const list = reading[s.key];
    const ref = median(list);
    const measuredCount = list.filter((v) => v != null).length;

    // Ring of lugs, as seen from above. Lug 1 at the bottom (closest to you).
    const n = list.length;
    const ring = svg('svg', { viewBox: '0 0 220 220', class: 'lug-ring', role: 'group', 'aria-label': 'Lugs' },
      svg('circle', { cx: 110, cy: 110, r: 78, class: 'head' }));
    for (let i = 0; i < n; i++) {
      const ang = Math.PI / 2 + (i * 2 * Math.PI) / n;
      const x = 110 + 92 * Math.cos(ang);
      const y = 110 + 92 * Math.sin(ang);
      const v = list[i];
      let cls = 'lug';
      if (v != null && ref != null && measuredCount >= 2) cls += ` ${statusClass(centsBetween(v, ref), 12, 30)}`;
      else if (v != null) cls += ' measured';
      if (i === view.activeLug) cls += ' active';
      const g = svg('g', { class: cls, tabindex: 0, role: 'button',
        'aria-label': `Lug ${i + 1}${v != null ? `, ${v.toFixed(1)} hertz` : ', not measured'}`,
        on: {
          click: () => { view.activeLug = i; renderDynamic(); },
          keydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); view.activeLug = i; renderDynamic(); } },
        } },
      svg('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 14 }),
      svg('text', { x: x.toFixed(1), y: (y + 5).toFixed(1), 'text-anchor': 'middle' }, String(i + 1)));
      ring.append(g);
      // Tap-here marker inside the head
      if (i === view.activeLug) {
        ring.append(svg('circle', { cx: (110 + 62 * Math.cos(ang)).toFixed(1), cy: (110 + 62 * Math.sin(ang)).toFixed(1),
          r: 6, class: 'tap-here' }));
      }
    }
    ring.append(svg('text', { x: 110, y: 106, 'text-anchor': 'middle', class: 'ring-label' }, `Tap near`),
      svg('text', { x: 110, y: 126, 'text-anchor': 'middle', class: 'ring-label strong' }, `lug ${view.activeLug + 1}`));

    // Summary
    const parts = [ring];
    const vals = list.filter((v) => v != null);
    if (vals.length >= 2) {
      const spread = Math.max(...vals) - Math.min(...vals);
      const spreadCents = centsBetween(Math.max(...vals), Math.min(...vals));
      const even = spreadCents <= 20 && vals.length === n;
      parts.push(h('div', { class: `advice ${even ? 'good' : statusClass(spreadCents / 2, 10, 30)}` },
        even ? '✓ Lugs are even' : `Spread: ${spread.toFixed(1)} Hz across ${vals.length}/${n} lugs`));
    } else {
      parts.push(h('div', { class: 'note' }, tuner.running ? `Tap near lug ${view.activeLug + 1}` : 'Start the mic below'));
    }
    if (view.message) parts.push(h('div', { class: 'advice bad' }, view.message));
    replaceChildren(els.readout, parts);

    const rows = list.map((v, i) => {
      let action = 'not measured';
      let cls = 'muted';
      if (v != null && ref != null && vals.length >= 2) {
        const c = centsBetween(v, ref);
        cls = statusClass(c, 12, 30);
        action = cls === 'good' ? 'OK' : c < 0 ? `${(ref - v).toFixed(1)} Hz low → tighten` : `${(v - ref).toFixed(1)} Hz high → loosen`;
      } else if (v != null) action = '';
      return h('li', { class: `lug-row ${i === view.activeLug ? 'active' : ''}`,
        on: { click: () => { view.activeLug = i; renderDynamic(); } } },
      h('span', { class: 'lug-num' }, `Lug ${i + 1}`),
      h('span', {}, v != null ? `${v.toFixed(1)} Hz` : '—'),
      h('span', { class: `lug-action ${cls}` }, action));
    });
    replaceChildren(els.detail,
      ref != null && h('p', { class: 'muted' }, `Middle value: ${ref.toFixed(1)} Hz`),
      h('ul', { class: 'lug-list plain' }, rows),
      h('div', { class: 'row-buttons' },
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', on: { click: () => {
          reading[s.key] = new Array(n).fill(null);
          view.activeLug = 0;
          save();
          tuner.setOptions(analysisOptionsFor(d, s, reading));
          renderDynamic();
        } } }, 'Clear lugs'),
        toggle('Auto-advance to next lug', state.settings.autoAdvance, (v) => {
          state.settings.autoAdvance = v;
          saveSettings(state.settings);
        })));
  }

  function drawSpectrum() {
    const c = els.spectrum;
    const r = view.lastHit;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, c.clientWidth || 320);
    const hgt = 90;
    c.width = Math.round(w * dpr);
    c.height = Math.round(hgt * dpr);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(document.documentElement);
    const fg = css.getPropertyValue('--accent').trim() || '#4fb3ff';
    const grid = css.getPropertyValue('--line').trim() || '#333';
    const text = css.getPropertyValue('--muted').trim() || '#888';
    ctx.clearRect(0, 0, w, hgt);
    ctx.font = '11px system-ui, sans-serif';
    if (!r?.spectrum) {
      ctx.fillStyle = text;
      ctx.fillText('Spectrum of your last hit appears here', 8, hgt / 2);
      return;
    }
    const { fmin, fmax, values } = r.spectrum;
    const xOf = (f) => (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;
    ctx.strokeStyle = grid;
    ctx.beginPath();
    ctx.moveTo(0, hgt - 14.5);
    ctx.lineTo(w, hgt - 14.5);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.globalAlpha = 0.85;
    const bw = w / values.length;
    for (let i = 0; i < values.length; i++) {
      const bh = values[i] * (hgt - 20);
      ctx.fillRect(i * bw, hgt - 15 - bh, Math.max(1, bw - 0.5), bh);
    }
    ctx.globalAlpha = 1;
    const s = step();
    if (s.target) {
      ctx.strokeStyle = text;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(xOf(s.target), 0);
      ctx.lineTo(xOf(s.target), hgt - 15);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (r.freq && r.confidence >= 0.12) {
      const x = xOf(r.freq);
      ctx.fillStyle = text;
      const label = `${r.freq.toFixed(1)} Hz`;
      const tw = ctx.measureText(label).width;
      ctx.fillText(label, Math.min(w - tw - 2, Math.max(2, x - tw / 2)), hgt - 2);
    }
  }

  // --- mic bar ------------------------------------------------------------------
  function renderMic() {
    els.micBtn.textContent = tuner.running ? '■ Stop listening' : '● Start listening';
    els.micBtn.classList.toggle('listening', tuner.running);
    els.micStatus.textContent = tuner.error || (tuner.running ? 'Listening…' : 'Mic is off');
    els.micStatus.classList.toggle('warn', !!tuner.error);
  }

  els.micBtn.addEventListener('click', async () => {
    els.micBtn.disabled = true;
    if (tuner.running) await tuner.stop();
    else {
      tuner.setOptions(analysisOptionsFor(d, step(), reading));
      await tuner.start();
    }
    els.micBtn.disabled = false;
    renderMic();
    renderDynamic();
  });

  const sens = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: String(state.settings.sensitivity),
    'aria-label': 'Sensitivity',
    on: { input: (e) => {
      const v = num(Number(e.target.value), 0, 1) ?? 0.55;
      state.settings.sensitivity = v;
      tuner.setSensitivity(v);
      saveSettings(state.settings);
    } } });

  function levelLoop() {
    const lvl = tuner.level;
    // Map RMS (0.0005..0.5) onto 0..100% on a log scale
    const pct = lvl > 0 ? Math.max(0, Math.min(100, ((Math.log10(lvl) + 3.3) / 3) * 100)) : 0;
    els.level.style.width = `${pct.toFixed(0)}%`;
    view.raf = requestAnimationFrame(levelLoop);
  }

  // --- assemble page --------------------------------------------------------------
  replaceChildren(root,
    h('header', { class: 'topbar' },
      h('a', { class: 'btn btn-ghost', href: '#/' }, '‹ Kit'),
      h('h1', {}, d.name),
      h('span', { class: 'muted small' }, inch(d.diameter))),
    els.tabs,
    els.instr,
    els.target,
    els.readout,
    els.spectrum,
    els.detail,
    h('div', { class: 'mic-bar' },
      h('div', { class: 'mic-row' },
        els.micBtn,
        h('div', { class: 'level', 'aria-hidden': 'true' }, els.level)),
      h('div', { class: 'mic-row small' },
        els.micStatus,
        h('label', { class: 'sens' }, h('span', { class: 'muted' }, 'Sensitivity'), sens))),
  );

  selectStep(0);
  renderMic();
  levelLoop();
  const onResize = () => drawSpectrum();
  window.addEventListener('resize', onResize);

  // Stop the mic if the app goes to the background (saves battery; Android
  // would cut it off anyway). You stay on the same step.
  const onVisibility = async () => {
    if (document.hidden && tuner.running) {
      await tuner.stop();
      renderMic();
      renderDynamic();
    }
  };
  document.addEventListener('visibilitychange', onVisibility);

  return async () => {
    cancelAnimationFrame(view.raf);
    window.removeEventListener('resize', onResize);
    document.removeEventListener('visibilitychange', onVisibility);
    tuner.onHit = null;
    await tuner.stop();
  };
}

// ---------------------------------------------------------------------------
// Offline support: register the service worker (see sw.js).
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register(scriptURL('./sw.js'), { scope: './' }).catch(() => {
    /* offline support unavailable; app still works online */
  });
}

render();

