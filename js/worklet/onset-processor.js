/**
 * OnsetProcessor — runs on the audio rendering thread (AudioWorklet).
 *
 * Watches the mic signal for percussive onsets. When one is detected it
 * captures the first ~21 ms of the attack (1024 samples) and posts the raw
 * samples to the main thread, which classifies the hit (kick/snare/hat)
 * and triggers the drum sound.
 *
 * Detection = block RMS must (a) exceed an absolute minimum, (b) exceed the
 * adaptive noise floor by a configurable ratio, and (c) jump versus the
 * previous block (rising edge, so sustained sounds like humming don't
 * retrigger). A refractory period suppresses double-triggers on one hit.
 */

const CAPTURE_SAMPLES = 1024; // ~21 ms @ 48 kHz — enough attack to classify
const STREAM_CHUNK = 8192;    // raw-audio streaming block (~170 ms @ 48 kHz)

class OnsetProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Tunable from the main thread ('config' message / sensitivity slider)
    this.thresholdRatio = 5.5; // onset must exceed noise floor by this factor
    this.minRms = 0.012;       // absolute RMS gate

    this.refractorySec = 0.08; // ignore new onsets this long after a trigger
    this.noiseFloor = 0.002;
    this.prevRms = 0;
    this.refractory = 0;       // samples remaining
    this.capture = null;
    this.captureIdx = 0;
    this.peak = 0;
    this.levelCounter = 0;

    // Raw-audio streaming (lets the app keep what the user actually said)
    this.streaming = false;
    this.streamBuf = null;
    this.streamIdx = 0;

    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'config') {
        if (typeof d.thresholdRatio === 'number') this.thresholdRatio = d.thresholdRatio;
        if (typeof d.minRms === 'number') this.minRms = d.minRms;
      } else if (d.type === 'suppress') {
        // Speaker guard: hold detection closed while our own drum sound
        // is coming out of the speakers, so it can't re-trigger the mic.
        const samples = Math.round((d.sec || 0) * sampleRate);
        if (samples > this.refractory) this.refractory = samples;
      } else if (d.type === 'stream') {
        if (d.on && !this.streaming) {
          this.streaming = true;
          this.streamBuf = new Float32Array(STREAM_CHUNK);
          this.streamIdx = 0;
        } else if (!d.on && this.streaming) {
          this.streaming = false;
          if (this.streamIdx > 0) {
            const tail = this.streamBuf.subarray(0, this.streamIdx).slice();
            this.port.postMessage({ type: 'chunk', samples: tail, last: true }, [tail.buffer]);
          } else {
            this.port.postMessage({ type: 'chunk', samples: new Float32Array(0), last: true });
          }
          this.streamBuf = null;
          this.streamIdx = 0;
        }
      }
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let sum = 0;
    let peak = 0;
    for (let i = 0; i < channel.length; i++) {
      const v = channel[i];
      sum += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(sum / channel.length);

    if (this.streaming) {
      this.streamBuf.set(channel, this.streamIdx);
      this.streamIdx += channel.length;
      if (this.streamIdx >= STREAM_CHUNK) {
        const full = this.streamBuf;
        this.port.postMessage({ type: 'chunk', samples: full, last: false }, [full.buffer]);
        this.streamBuf = new Float32Array(STREAM_CHUNK);
        this.streamIdx = 0;
      }
    }

    if (this.capture) {
      // Capture in progress: append this block, flush when full.
      const room = CAPTURE_SAMPLES - this.captureIdx;
      const n = room < channel.length ? room : channel.length;
      this.capture.set(channel.subarray(0, n), this.captureIdx);
      this.captureIdx += n;
      if (peak > this.peak) this.peak = peak;
      if (this.captureIdx >= CAPTURE_SAMPLES) {
        const samples = this.capture;
        this.capture = null;
        this.port.postMessage({ type: 'onset', peak: this.peak, samples }, [samples.buffer]);
      }
    } else if (
      this.refractory <= 0 &&
      rms > this.minRms &&
      rms > this.noiseFloor * this.thresholdRatio &&
      rms > this.prevRms * 1.3
    ) {
      this.capture = new Float32Array(CAPTURE_SAMPLES);
      this.capture.set(channel);
      this.captureIdx = channel.length;
      this.peak = peak;
      this.refractory = Math.round(this.refractorySec * sampleRate);
    }

    // Track the ambient noise floor, but only from quiet blocks so the
    // hits themselves don't raise the gate.
    if (rms < this.noiseFloor * 3) {
      this.noiseFloor += (rms - this.noiseFloor) * 0.02;
      if (this.noiseFloor < 0.0005) this.noiseFloor = 0.0005;
    }

    if (this.refractory > 0) this.refractory -= channel.length;
    this.prevRms = rms;

    // Level meter update every 4 blocks (~11 ms)
    if (++this.levelCounter >= 4) {
      this.levelCounter = 0;
      this.port.postMessage({ type: 'level', rms });
    }
    return true;
  }
}

registerProcessor('onset-processor', OnsetProcessor);
