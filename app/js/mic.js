// mic.js — opens the microphone and streams raw samples to a callback.
//
// Browsers only allow microphone access on secure pages (https:// or
// localhost) and only after the user taps something, so start() must be
// called from a button press.

import { scriptURL } from './trusted.js';

export class Mic {
  constructor(onSamples) {
    this.onSamples = onSamples;
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }

  get running() {
    return !!this.ctx;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  async start() {
    if (this.ctx) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('This browser can’t access the microphone here. Open the app over https:// in Chrome.');
    }
    // Turn off phone call processing (echo cancel, noise suppression, auto
    // gain). Those are designed for voices and would mangle drum sounds.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const source = this.ctx.createMediaStreamSource(this.stream);

    if (this.ctx.audioWorklet) {
      await this.ctx.audioWorklet.addModule(scriptURL(new URL('./capture-worklet.js', import.meta.url)));
      this.node = new AudioWorkletNode(this.ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
      });
      this.node.port.onmessage = (e) => this.onSamples(e.data);
    } else {
      // Older browsers: the deprecated ScriptProcessorNode does the same job.
      this.node = this.ctx.createScriptProcessor(2048, 1, 1);
      this.node.onaudioprocess = (e) =>
        this.onSamples(new Float32Array(e.inputBuffer.getChannelData(0)));
    }
    source.connect(this.node);
    // The node must be connected to the output to keep running, but we send
    // silence so you don't hear yourself.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.destination);
  }

  async stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = null;
    this.stream = null;
    this.node = null;
  }
}

/** Play a short drum-like tone at `freq` so you can hear the target pitch. */
let toneCtx = null;
export function playTone(freq, seconds = 1.6) {
  toneCtx = toneCtx || new AudioContext();
  if (toneCtx.state === 'suspended') toneCtx.resume();
  const now = toneCtx.currentTime;
  const out = toneCtx.createGain();
  out.gain.setValueAtTime(0.0001, now);
  out.gain.exponentialRampToValueAtTime(0.5, now + 0.01);
  out.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  out.connect(toneCtx.destination);
  // Pure tone plus a quieter octave so it's audible on small phone speakers
  // (which can't reproduce low notes well).
  [[1, 1], [2, 0.5], [3, 0.2]].forEach(([mult, amp]) => {
    const osc = toneCtx.createOscillator();
    const g = toneCtx.createGain();
    osc.frequency.value = freq * mult;
    g.gain.value = amp;
    osc.connect(g).connect(out);
    osc.start(now);
    osc.stop(now + seconds);
  });
}
