// tuning.js — the "drum knowledge" part of the app.
//
// Given the kit you entered (sizes, heads, preferences) it works out a target
// pitch for every drum and every head. These are *starting points* based on
// typical tunings: your ears get the final say, and every target can be
// overridden in the app.
//
// Terminology:
//   batter head – the top head you hit
//   reso head   – resonant (bottom) head
//   fundamental – the lowest, main pitch you hear when you hit the whole drum

// Typical "sweet spot" fundamental (whole drum, both heads on) for toms of a
// given diameter at medium tension, in Hz. Values in between are interpolated.
const TOM_MID = [
  [6, 235], [8, 190], [10, 155], [12, 128], [13, 117],
  [14, 104], [15, 95], [16, 87], [18, 74], [20, 64],
];

const KICK_MID = [[16, 78], [18, 68], [20, 60], [22, 54], [24, 48], [26, 44]];

// Snare batter head pitch (tapped in the centre, bottom head muted).
const SNARE_BATTER_MID = [[10, 320], [12, 280], [13, 262], [14, 245], [15, 230]];

// Each tension preset shifts everything by this many semitones.
export const TENSION = {
  low: { label: 'Low / fat', semis: -2.5 },
  medium: { label: 'Medium', semis: 0 },
  high: { label: 'High / jazz', semis: 3 },
};

// Reso (bottom) head relative to the batter (top) head, in semitones.
export const STYLES = {
  resoHigher: { label: 'Bottom slightly higher', semis: 2,
    hint: 'Good sustain, slight pitch drop after the hit. A great all‑round default.' },
  equal: { label: 'Top and bottom equal', semis: 0,
    hint: 'Most sustain and the most open, singing tone.' },
  resoLower: { label: 'Bottom lower', semis: -2,
    hint: 'Punchier and shorter with more attack.' },
};

export const INTERVALS = {
  auto: 'Auto (best fit for your sizes)',
  3: 'Minor 3rd (3 semitones)',
  4: 'Major 3rd (4 semitones)',
  5: 'Perfect 4th (5 semitones)',
};

// A single head (other head muted) sounds higher than the whole drum's
// fundamental, because with both heads free they move together and the drum
// "sinks" lower. This factor turns a fundamental target into an approximate
// single-head target. It's an estimate — the whole-drum check is the real test.
const HEAD_OVER_FUNDAMENTAL = 1.3;

// Snare: bottom head usually sits about a 4th–5th above the top head.
const SNARE_RESO_SEMIS = 6;

const semis = (s) => Math.pow(2, s / 12);

function interp(table, x) {
  if (x <= table[0][0]) return table[0][1] * (table[0][0] / x);
  const last = table[table.length - 1];
  if (x >= last[0]) return last[1] * (last[0] / x);
  for (let i = 0; i < table.length - 1; i++) {
    const [x0, y0] = table[i];
    const [x1, y1] = table[i + 1];
    if (x >= x0 && x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return Math.exp(Math.log(y0) + t * (Math.log(y1) - Math.log(y0)));
    }
  }
  return last[1];
}

/** Sensible default number of tension rods for a drum. */
export function defaultLugs(kind, diameter) {
  if (kind === 'snare') return 10;
  if (kind === 'kick') return diameter >= 20 ? 10 : 8;
  return diameter >= 14 ? 8 : 6;
}

let idCounter = 0;
export function newId(prefix) {
  idCounter++;
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`;
}

/** A brand-new kit: snare, 3 toms (10, 12, 16 floor), kick. */
export function defaultKit() {
  return {
    version: 1,
    tension: 'medium',
    style: 'resoHigher',
    interval: 'auto',
    snare: { id: 'snare', diameter: 14, depth: 5.5, lugs: 10, override: null },
    toms: [
      { id: newId('tom'), diameter: 10, reso: true, lugs: 6, override: null },
      { id: newId('tom'), diameter: 12, reso: true, lugs: 6, override: null },
      { id: newId('tom'), diameter: 16, reso: true, lugs: 8, override: null },
    ],
    kick: { id: 'kick', enabled: true, diameter: 22, reso: true, lugs: 10, override: null },
  };
}

/**
 * Space the toms at an even musical interval. Returns { semitones, pitches[] }
 * with pitches in the same order as `mids` (smallest drum first).
 */
export function spaceToms(mids, interval) {
  if (mids.length === 0) return { semitones: null, pitches: [] };
  if (mids.length === 1) {
    return { semitones: null, pitches: [440 * Math.pow(2, Math.round(12 * Math.log2(mids[0] / 440)) / 12)] };
  }
  const m = mids.map((f) => 12 * Math.log2(f / 440)); // semitones relative to A4
  const candidates = interval === 'auto' ? [3, 4, 5] : [Number(interval)];
  let best = null;
  for (const s of candidates) {
    // Best "anchor" (pitch of the smallest tom) for this spacing = average.
    // Rounded to a whole semitone so every tom lands exactly on a note.
    const anchor = Math.round(m.reduce((acc, v, i) => acc + v + s * i, 0) / m.length);
    const pos = m.map((_, i) => anchor - s * i);
    const err = pos.reduce((acc, p, i) => acc + (p - m[i]) ** 2, 0);
    if (!best || err < best.err - 0.5 || (Math.abs(err - best.err) <= 0.5 && s === 4)) {
      best = { s, pos, err };
    }
  }
  return {
    semitones: best.s,
    pitches: best.pos.map((p) => 440 * Math.pow(2, p / 12)),
  };
}

/** Name toms "Rack tom 1", "Floor tom 1" etc. in size order. */
function tomNames(sorted) {
  let rack = 0;
  let floor = 0;
  const floors = sorted.filter((t) => t.diameter >= 14).length;
  const racks = sorted.length - floors;
  return sorted.map((t) => {
    if (t.diameter >= 14) {
      floor++;
      return floors > 1 ? `Floor tom ${floor}` : 'Floor tom';
    }
    rack++;
    return racks > 1 ? `Rack tom ${rack}` : 'Rack tom';
  });
}

/**
 * Build the list of drums with all their targets. This is what the screens
 * display. Each drum:
 *   { id, kind, name, diameter, hasReso, lugs,
 *     fundamental, batter, reso, range: [lo, hi], auto, warning }
 */
export function computeDrums(kit) {
  const tension = semis(TENSION[kit.tension]?.semis ?? 0);
  const styleSemis = STYLES[kit.style]?.semis ?? 0;
  const drums = [];

  // --- Snare -------------------------------------------------------------
  const sn = kit.snare;
  {
    const autoBatter = interp(SNARE_BATTER_MID, sn.diameter) * tension;
    const batter = sn.override ?? autoBatter;
    drums.push({
      id: sn.id,
      kind: 'snare',
      name: 'Snare',
      diameter: sn.diameter,
      depth: sn.depth,
      hasReso: true,
      lugs: sn.lugs,
      batter,
      reso: batter * semis(SNARE_RESO_SEMIS),
      fundamental: null, // snare is tuned by its heads; whole-drum check is by ear
      range: [autoBatter * semis(-5), autoBatter * semis(6)],
      auto: autoBatter,
      overridden: sn.override != null,
    });
  }

  // --- Toms (smallest = highest first) -----------------------------------
  const sorted = [...kit.toms].sort((a, b) => a.diameter - b.diameter);
  const mids = sorted.map((t) => interp(TOM_MID, t.diameter) * tension);
  const spaced = spaceToms(mids, kit.interval);
  const names = tomNames(sorted);
  sorted.forEach((t, i) => {
    const auto = spaced.pitches[i];
    const fundamental = t.override ?? auto;
    const lo = mids[i] * semis(-4);
    const hi = mids[i] * semis(4);
    const batter = fundamental * HEAD_OVER_FUNDAMENTAL;
    let warning = null;
    if (fundamental < lo) warning = 'This is very low for this size — the head may get floppy and lose tone.';
    else if (fundamental > hi) warning = 'This is very high for this size — it may sound choked.';
    drums.push({
      id: t.id,
      kind: 'tom',
      name: names[i],
      diameter: t.diameter,
      hasReso: t.reso,
      lugs: t.lugs,
      fundamental,
      batter,
      reso: t.reso ? batter * semis(styleSemis) : null,
      range: [lo, hi],
      auto,
      overridden: t.override != null,
      warning,
    });
  });

  // --- Kick ----------------------------------------------------------------
  const k = kit.kick;
  if (k.enabled) {
    const auto = interp(KICK_MID, k.diameter) * tension;
    const fundamental = k.override ?? auto;
    const batter = fundamental * HEAD_OVER_FUNDAMENTAL;
    drums.push({
      id: k.id,
      kind: 'kick',
      name: 'Kick',
      diameter: k.diameter,
      hasReso: k.reso,
      lugs: k.lugs,
      fundamental,
      batter,
      reso: k.reso ? batter * semis(styleSemis) : null,
      range: [auto * semis(-4), auto * semis(4)],
      auto,
      overridden: k.override != null,
    });
  }

  return { drums, tomInterval: spaced.semitones };
}

export const INTERVAL_NAMES = {
  1: 'minor 2nd', 2: 'major 2nd', 3: 'minor 3rd', 4: 'major 3rd', 5: 'perfect 4th',
  6: 'tritone', 7: 'perfect 5th', 8: 'minor 6th', 9: 'major 6th', 10: 'minor 7th',
  11: 'major 7th', 12: 'octave',
};

/** Find a drum's settings object inside the kit by id (for editing). */
export function findDrumSettings(kit, id) {
  if (kit.snare.id === id) return kit.snare;
  if (kit.kick.id === id) return kit.kick;
  return kit.toms.find((t) => t.id === id);
}
