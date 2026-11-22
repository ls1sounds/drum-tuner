// capture-worklet.js — runs on the browser's dedicated audio thread.
//
// An AudioWorklet receives the microphone audio in tiny 128-sample chunks.
// We collect them into bigger batches (2048 samples ≈ 43 ms) and send each
// batch to the main page, where the detector analyses it.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = new Float32Array(2048);
    this.fill = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let i = 0;
      while (i < channel.length) {
        const take = Math.min(channel.length - i, this.batch.length - this.fill);
        this.batch.set(channel.subarray(i, i + take), this.fill);
        this.fill += take;
        i += take;
        if (this.fill === this.batch.length) {
          this.port.postMessage(this.batch);
          this.batch = new Float32Array(2048);
          this.fill = 0;
        }
      }
    }
    return true; // keep running
  }
}

registerProcessor('capture-processor', CaptureProcessor);
