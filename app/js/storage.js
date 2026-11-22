// storage.js — saves your kit and readings on the phone (localStorage).
//
// SECURITY: anything read back from storage is treated as untrusted input.
// Someone could edit it with dev tools, or a future bug could write junk, so
// we never trust its shape. Every field is checked, numbers are clamped to
// sane ranges, and we build brand-new objects field by field rather than
// merging the stored object (which avoids "prototype pollution" tricks such
// as a stored "__proto__" key).

import { defaultKit, defaultLugs, newId, TENSION, STYLES, INTERVALS } from './tuning.js';

const KIT_KEY = 'drumTuner.kit.v1';
const READINGS_KEY = 'drumTuner.readings.v1';
const SETTINGS_KEY = 'drumTuner.settings.v1';
const MAX_STORED_CHARS = 200_000;

export const SIZES = {
  tom: [6, 8, 10, 12, 13, 14, 15, 16, 18, 20],
  snare: [10, 12, 13, 14, 15],
  kick: [16, 18, 20, 22, 24, 26],
};
export const SNARE_DEPTHS = [3.5, 4, 5, 5.5, 6, 6.5, 7, 8];
export const MAX_TOMS = 8;
export const LUG_CHOICES = [4, 5, 6, 8, 10, 12, 14, 16];
const ID_RE = /^[a-z]{3,5}(-[a-z0-9]{1,16}){0,2}$/;

// ---- small validators ------------------------------------------------------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);
const own = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** A finite number inside [min, max], or null. */
export function num(v, min, max) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null;
}

const freqOrNull = (v) => num(v, 15, 5000);
const lugs = (v, kind, diameter) => oneOf(v, LUG_CHOICES, defaultLugs(kind, diameter));

function safeRead(key) {
  try {
    const raw = localStorage.getItem(key);
    if (typeof raw !== 'string' || raw.length > MAX_STORED_CHARS) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined; // storage blocked, or corrupt JSON
  }
}

function safeWrite(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false; // private mode / storage full — app keeps working in memory
  }
}

// ---- kit -------------------------------------------------------------------

/** Turn arbitrary (possibly hostile) data into a valid kit object. */
export function sanitizeKit(raw) {
  const d = defaultKit();
  if (!isObj(raw)) return d;

  const kit = {
    version: 1,
    tension: oneOf(own(raw, 'tension'), Object.keys(TENSION), d.tension),
    style: oneOf(own(raw, 'style'), Object.keys(STYLES), d.style),
    interval: oneOf(String(own(raw, 'interval')), Object.keys(INTERVALS), d.interval),
  };

  const s = own(raw, 'snare');
  const sDia = oneOf(own(s, 'diameter'), SIZES.snare, d.snare.diameter);
  kit.snare = {
    id: 'snare',
    diameter: sDia,
    depth: oneOf(own(s, 'depth'), SNARE_DEPTHS, d.snare.depth),
    lugs: lugs(own(s, 'lugs'), 'snare', sDia),
    override: freqOrNull(own(s, 'override')),
  };

  const rawToms = own(raw, 'toms');
  const seen = new Set(['snare', 'kick']);
  kit.toms = (Array.isArray(rawToms) ? rawToms : d.toms).slice(0, MAX_TOMS).map((t) => {
    let id = own(t, 'id');
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) id = newId('tom');
    seen.add(id);
    const dia = oneOf(own(t, 'diameter'), SIZES.tom, 12);
    return {
      id,
      diameter: dia,
      reso: bool(own(t, 'reso'), true),
      lugs: lugs(own(t, 'lugs'), 'tom', dia),
      override: freqOrNull(own(t, 'override')),
    };
  });

  const k = own(raw, 'kick');
  const kDia = oneOf(own(k, 'diameter'), SIZES.kick, d.kick.diameter);
  kit.kick = {
    id: 'kick',
    enabled: bool(own(k, 'enabled'), d.kick.enabled),
    diameter: kDia,
    reso: bool(own(k, 'reso'), true),
    lugs: lugs(own(k, 'lugs'), 'kick', kDia),
    override: freqOrNull(own(k, 'override')),
  };
  return kit;
}

/** Returns { kit, isNew } — isNew is true on first launch. */
export function loadKit() {
  const raw = safeRead(KIT_KEY);
  if (raw === undefined) return { kit: defaultKit(), isNew: true };
  return { kit: sanitizeKit(raw), isNew: false };
}

export function saveKit(kit) {
  return safeWrite(KIT_KEY, sanitizeKit(kit));
}

// ---- readings (what you last measured on each drum) -------------------------

function sanitizeLugList(v, count) {
  const out = new Array(count).fill(null);
  if (Array.isArray(v)) for (let i = 0; i < count; i++) out[i] = freqOrNull(v[i]);
  return out;
}

/**
 * Readings for each drum, keyed by drum id. Only ids that exist in the kit
 * are kept; everything else in storage is dropped.
 */
export function sanitizeReadings(raw, kit) {
  const out = new Map();
  const drums = [kit.snare, ...kit.toms, kit.kick];
  for (const drum of drums) {
    const r = own(raw, drum.id);
    out.set(drum.id, {
      batterLugs: sanitizeLugList(own(r, 'batterLugs'), drum.lugs),
      resoLugs: sanitizeLugList(own(r, 'resoLugs'), drum.lugs),
      batter: freqOrNull(own(r, 'batter')),
      reso: freqOrNull(own(r, 'reso')),
      drum: freqOrNull(own(r, 'drum')),
      at: num(own(r, 'at'), 0, 8.64e15),
    });
  }
  return out;
}

export function loadReadings(kit) {
  return sanitizeReadings(safeRead(READINGS_KEY), kit);
}

export function saveReadings(readings) {
  const obj = {};
  for (const [id, r] of readings) obj[id] = r;
  return safeWrite(READINGS_KEY, obj);
}

// ---- app settings ------------------------------------------------------------

export function loadSettings() {
  const raw = safeRead(SETTINGS_KEY);
  return {
    sensitivity: num(own(raw, 'sensitivity'), 0, 1) ?? 0.55,
    autoAdvance: bool(own(raw, 'autoAdvance'), true),
  };
}

export function saveSettings(s) {
  return safeWrite(SETTINGS_KEY, {
    sensitivity: num(s.sensitivity, 0, 1) ?? 0.55,
    autoAdvance: !!s.autoAdvance,
  });
}

export function clearAll() {
  try {
    [KIT_KEY, READINGS_KEY, SETTINGS_KEY].forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}
