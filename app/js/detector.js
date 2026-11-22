// detector.js — turns raw microphone samples into drum pitch readings.
//
// How it works (in plain terms):
//   1. We watch the loudness of the incoming audio in small blocks (~5 ms).
//   2. When the loudness suddenly jumps well above the background noise,
//      that's a drum hit ("onset").
//   3. We skip the first few milliseconds after the hit (the stick "click"
//      is noisy and has no clear pitch), then grab a few hundred
//      milliseconds of the ringing drum.
//   4. We run an FFT on that slice to see how much energy is at each
//      frequency, find the peaks, and pick the one that represents the
//      drum's pitch.
//
// This file has no browser-specific code, so it can be tested by feeding it
// samples from a file instead of a live microphone.

// ---------------------------------------------------------------------------
// FFT (Fast Fourier Transform). Converts a block of samples (amplitude over
// time) into a spectrum (amplitude per frequency). Classic in-place radix-2.
// ---------------------------------------------------------------------------
const twiddleCache = new Map();

function getTwiddles(n) {
  let t = twiddleCache.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let i = 0; i < n / 2; i++) {
      t.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      t.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
    twiddleCache.set(n, t);
  }
  return t;
}

/** In-place FFT on real/imag arrays whose length is a power of two. */
export function fft(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const { cos, sin } = getTwiddles(n);
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Spectrum analysis of one drum hit
// ---------------------------------------------------------------------------

/**
 * Analyse a slice of samples and return the detected pitch.
 *
 * @param {Float32Array} samples  audio slice (already trimmed past the attack)
 * @param {number} sampleRate
 * @param {object} opts
 *   fmin, fmax  – frequency search range in Hz
 *   mode        – 'fundamental' (lowest strong peak) or 'strongest'
 *   reference   – optional Hz; if given, prefer a peak near it (lug mode)
 */
export function analyzeSlice(samples, sampleRate, opts = {}) {
  const fmin = opts.fmin ?? 30;
  const fmax = opts.fmax ?? 1200;
  const mode = opts.mode ?? 'fundamental';

  const len = samples.length;
  // Zero-pad to at least 64k points so the spectrum is finely sampled
  // (~0.7 Hz per bin at 48 kHz). Padding doesn't add real resolution, but it
  // makes peak positions much easier to pinpoint.
  let n = 65536;
  while (n < len * 2) n <<= 1;

  const re = new Float64Array(n);
  const im = new Float64Array(n);

  // Remove DC offset and apply a Hann window (reduces "spectral leakage",
  // which would otherwise smear each peak across many frequencies).
  let mean = 0;
  for (let i = 0; i < len; i++) mean += samples[i];
  mean /= len;
  for (let i = 0; i < len; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (len - 1));
    re[i] = (samples[i] - mean) * w;
  }

  fft(re, im);

  const binHz = sampleRate / n;
  const lo = Math.max(2, Math.floor(fmin / binHz));
  const hi = Math.min(n / 2 - 2, Math.ceil(fmax / binHz));

  // Magnitude spectrum for the search range only.
  const mag = new Float64Array(hi - lo + 1);
  let maxMag = 0;
  for (let k = lo; k <= hi; k++) {
    const m = Math.hypot(re[k], im[k]);
    mag[k - lo] = m;
    if (m > maxMag) maxMag = m;
  }
  if (maxMag <= 0) return null;

  // Find local peaks. A peak must be the biggest value within ±~3 Hz and
  // stand out from the overall spectrum.
  const halfWidth = Math.max(2, Math.round(3 / binHz));
  const peaks = [];
  for (let i = 1; i < mag.length - 1; i++) {
    const m = mag[i];
    if (m < maxMag * 0.05) continue;
    let isPeak = true;
    for (let j = Math.max(0, i - halfWidth); j <= Math.min(mag.length - 1, i + halfWidth); j++) {
      if (mag[j] > m || (mag[j] === m && j < i)) { isPeak = false; break; }
    }
    if (!isPeak) continue;
    // Parabolic interpolation on log-magnitude (very accurate for a Hann
    // window) to estimate where the true peak lies between bins.
    const a = Math.log(mag[i - 1] + 1e-12);
    const b = Math.log(m + 1e-12);
    const c = Math.log(mag[i + 1] + 1e-12);
    const denom = a - 2 * b + c;
    const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const freq = (lo + i + offset) * binHz;
    peaks.push({ freq, mag: m / maxMag });
  }
  if (!peaks.length) return null;

  let chosen;
  if (opts.reference) {
    // Lug mode: we already know roughly where this head's pitch is (from the
    // other lugs). Lock on to the strongest peak within ±20% of it so we
    // don't jump between different vibration modes from lug to lug.
    const near = peaks.filter(
      (p) => p.mag >= 0.2 && Math.abs(Math.log(p.freq / opts.reference)) < Math.log(1.2)
    );
    if (near.length) chosen = near.reduce((x, y) => (y.mag > x.mag ? y : x));
  }
  if (!chosen) {
    if (mode === 'strongest') {
      chosen = peaks.reduce((x, y) => (y.mag > x.mag ? y : x));
    } else {
      // The drum's pitch (fundamental) is normally the lowest strong peak;
      // higher peaks are overtones. "Strong" = at least 35% of the loudest.
      chosen = peaks.filter((p) => p.mag >= 0.35).sort((x, y) => x.freq - y.freq)[0];
    }
  }

  // Confidence: how clearly the chosen peak stands out from everything else.
  const others = peaks.filter((p) => p !== chosen).map((p) => p.mag);
  const runnerUp = others.length ? Math.max(...others) : 0;
  const confidence = Math.max(0, Math.min(1, chosen.mag - 0.5 * runnerUp));

  // A small, downsampled spectrum for drawing on screen.
  const display = downsampleSpectrum(mag, lo, binHz, fmin, fmax, 200);

  return {
    freq: chosen.freq,
    confidence,
    peaks: peaks.sort((x, y) => y.mag - x.mag).slice(0, 8),
    spectrum: display,
  };
}

function downsampleSpectrum(mag, lo, binHz, fmin, fmax, points) {
  // Log-spaced frequency axis so low and high drums both look sensible.
  const out = { fmin, fmax, values: new Float32Array(points) };
  let max = 0;
  for (let p = 0; p < points; p++) {
    const f0 = fmin * Math.pow(fmax / fmin, p / points);
    const f1 = fmin * Math.pow(fmax / fmin, (p + 1) / points);
    const k0 = Math.max(0, Math.floor(f0 / binHz) - lo);
    const k1 = Math.min(mag.length - 1, Math.ceil(f1 / binHz) - lo);
    let v = 0;
    for (let k = k0; k <= k1; k++) if (mag[k] > v) v = mag[k];
    out.values[p] = v;
    if (v > max) max = v;
  }
  if (max > 0) for (let p = 0; p < points; p++) out.values[p] /= max;
  return out;
}

// ---------------------------------------------------------------------------
// Hit detector: feed it audio continuously, it calls back once per drum hit.
// ---------------------------------------------------------------------------
export class HitDetector {
  /**
   * @param {number} sampleRate
   * @param {(result) => void} onHit  called with analysis results
   * @param {object} options
   *   sensitivity – 0..1, higher = triggers on softer hits (default 0.5)
   */
  constructor(sampleRate, onHit, options = {}) {
    this.sampleRate = sampleRate;
    this.onHit = onHit;
    this.blockSize = 256; // ~5 ms at 48 kHz
    this.bufferLen = Math.round(sampleRate * 1.5);
    this.buffer = new Float32Array(this.bufferLen); // ring buffer
    this.writePos = 0;
    this.total = 0; // total samples ever received

    this.pending = new Float32Array(this.blockSize);
    this.pendingLen = 0;

    this.noiseFloor = 0.002;
    this.prevRms = 0;
    this.level = 0; // last block RMS (for the on-screen level meter)
    this.peakSinceOnset = 0;
    this.state = 'idle';
    this.onsetAt = 0;
    this.refractoryUntil = 0;
    this.setSensitivity(options.sensitivity ?? 0.5);
    this.analysisOptions = {};

    this.skipSec = 0.03;   // ignore stick attack
    this.maxWinSec = 0.4;  // longest slice we analyse
    this.minWinSec = 0.08; // shortest slice worth analysing
  }

  setSensitivity(s) {
    this.sensitivity = Math.max(0, Math.min(1, s));
    // Absolute minimum loudness (RMS) that counts as a hit: from 0.1 (very
    // insensitive) down to ~0.0016 (very sensitive).
    this.minLevel = 0.1 * Math.pow(0.016, this.sensitivity);
    // How far above background noise a hit must jump.
    this.noiseRatio = 12 - 8 * this.sensitivity;
  }

  /** Options passed through to analyzeSlice (fmin, fmax, mode, reference). */
  setAnalysisOptions(opts) {
    this.analysisOptions = { ...opts };
  }

  reset() {
    this.state = 'idle';
    this.pendingLen = 0;
  }

  /** Push a chunk of mono samples (any length). */
  push(chunk) {
    let i = 0;
    while (i < chunk.length) {
      const take = Math.min(chunk.length - i, this.blockSize - this.pendingLen);
      this.pending.set(chunk.subarray(i, i + take), this.pendingLen);
      this.pendingLen += take;
      i += take;
      if (this.pendingLen === this.blockSize) {
        this._processBlock(this.pending);
        this.pendingLen = 0;
      }
    }
  }

  _processBlock(block) {
    // Store in ring buffer
    for (let i = 0; i < block.length; i++) {
      this.buffer[this.writePos] = block[i];
      this.writePos = (this.writePos + 1) % this.bufferLen;
    }
    this.total += block.length;

    let sum = 0;
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i];
    const rms = Math.sqrt(sum / block.length);
    this.level = rms;

    const threshold = Math.max(this.minLevel, this.noiseFloor * this.noiseRatio);
    const sharpRise = rms > this.prevRms * 2.5;

    if (this.state === 'idle') {
      // Track background noise slowly while nothing is happening.
      if (rms < threshold) {
        const k = rms < this.noiseFloor ? 0.05 : 0.01;
        this.noiseFloor = Math.max(1e-5, this.noiseFloor + k * (rms - this.noiseFloor));
      }
      if (rms > threshold && sharpRise && this.total > this.refractoryUntil) {
        this.state = 'collecting';
        this.onsetAt = this.total - block.length;
        this.peakSinceOnset = rms;
      }
    } else if (this.state === 'collecting') {
      if (rms > this.peakSinceOnset) this.peakSinceOnset = rms;
      const elapsed = this.total - this.onsetAt;
      const skip = Math.round(this.skipSec * this.sampleRate);
      const maxWin = Math.round(this.maxWinSec * this.sampleRate);
      const minWin = Math.round(this.minWinSec * this.sampleRate);

      // A second, louder hit while we're still listening: start over from it.
      if (elapsed > skip && rms > this.prevRms * 1.8 && rms > this.peakSinceOnset * 0.6 && rms > threshold) {
        this.onsetAt = this.total - block.length;
        this.peakSinceOnset = rms;
        this.prevRms = rms;
        return;
      }

      const decayedOut = rms < Math.max(this.noiseFloor * 2, this.peakSinceOnset * 0.02);
      if (elapsed >= skip + maxWin || (decayedOut && elapsed >= skip + minWin)) {
        const winLen = Math.min(maxWin, elapsed - skip);
        this._analyse(this.onsetAt + skip, winLen);
        this.state = 'idle';
        this.refractoryUntil = this.total + Math.round(0.05 * this.sampleRate);
      } else if (decayedOut) {
        // Too short to be a drum ring (e.g. a click). Ignore.
        this.state = 'idle';
      }
    }
    this.prevRms = Math.max(rms, this.prevRms * 0.9);
  }

  _analyse(startAbs, len) {
    const slice = new Float32Array(len);
    const oldest = this.total - this.bufferLen;
    if (startAbs < oldest) return;
    let pos = (this.writePos - (this.total - startAbs) + this.bufferLen * 2) % this.bufferLen;
    for (let i = 0; i < len; i++) {
      slice[i] = this.buffer[pos];
      pos = (pos + 1) % this.bufferLen;
    }
    const result = analyzeSlice(slice, this.sampleRate, this.analysisOptions);
    if (result) {
      result.level = this.peakSinceOnset;
      result.windowSec = len / this.sampleRate;
      this.onHit(result);
    }
  }
}

// ---------------------------------------------------------------------------
// Music helpers
// ---------------------------------------------------------------------------
const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/** 147 → { name: 'D3', cents: +8 } */
export function freqToNote(freq) {
  const midi = 69 + 12 * Math.log2(freq / 440);
  const nearest = Math.round(midi);
  const cents = Math.round((midi - nearest) * 100);
  const name = NOTE_NAMES[((nearest % 12) + 12) % 12] + (Math.floor(nearest / 12) - 1);
  return { name, cents, midi };
}

/** Difference in cents (100 cents = 1 semitone) from b to a. */
export function centsBetween(a, b) {
  return 1200 * Math.log2(a / b);
}
