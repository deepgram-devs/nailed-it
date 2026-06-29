/**
 * Captures mic audio, resamples from the AudioContext rate (usually 48 kHz)
 * down to the target rate, converts to linear16 (Int16), and posts ~80 ms
 * chunks back to the main thread to forward to the proxy.
 */
class RecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const targetRate = options.processorOptions.targetRate;
    this.ratio = sampleRate / targetRate; // `sampleRate` is the global worklet rate
    this.pos = 0; // fractional read position into `tail`
    this.tail = new Float32Array(0);
    this.out = [];
    this.chunk = Math.round(targetRate * 0.08); // ~80 ms per send
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    const data = new Float32Array(this.tail.length + ch.length);
    data.set(this.tail, 0);
    data.set(ch, this.tail.length);

    let i = this.pos;
    while (i < data.length - 1) {
      const i0 = Math.floor(i);
      const frac = i - i0;
      const s = data[i0] * (1 - frac) + data[i0 + 1] * frac;
      const clamped = Math.max(-1, Math.min(1, s));
      this.out.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
      i += this.ratio;
    }

    const used = Math.floor(i);
    this.tail = data.slice(used);
    this.pos = i - used;

    if (this.out.length >= this.chunk) {
      const pcm = Int16Array.from(this.out);
      this.out.length = 0;
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("recorder", RecorderProcessor);
