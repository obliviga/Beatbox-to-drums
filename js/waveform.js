/**
 * Waveform — voice-memo-style scrolling amplitude display.
 *
 * One AnalyserNode taps whatever should be visible: the microphone while
 * you record, and the drum engine's output while the converted beat plays.
 * Each animation frame samples the current peak amplitude and pushes one
 * bar into a ring buffer that scrolls right-to-left.
 */

export class Waveform {
  constructor(canvas) {
    this.canvas = canvas;
    this.g = canvas.getContext('2d');
    this.analyser = null;
    this.data = null;
    this.bars = [];
    this.maxBars = 0;
  }

  /**
   * Create (once per context) and return the analyser to connect sources
   * into. If called with a different context (the app rebuilds its audio
   * pipeline after mic sessions), a fresh analyser is created for it.
   */
  attach(ctx) {
    if (!this.analyser || this._ctx !== ctx) {
      this._ctx = ctx;
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.data = new Float32Array(this.analyser.fftSize);
    }
    return this.analyser;
  }

  /** Sample the current amplitude — call once per animation frame. */
  sample() {
    if (!this.analyser) return;
    this.analyser.getFloatTimeDomainData(this.data);
    let peak = 0;
    for (let i = 0; i < this.data.length; i++) {
      const a = this.data[i] < 0 ? -this.data[i] : this.data[i];
      if (a > peak) peak = a;
    }
    this.bars.push(Math.min(1, peak));
    if (this.maxBars && this.bars.length > this.maxBars) {
      this.bars.splice(0, this.bars.length - this.maxBars);
    }
  }

  /** @param {{live?:boolean, recording?:boolean}} view */
  render({ live = false, recording = false } = {}) {
    const { canvas, g } = this;
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const barW = 3;
    const gap = 2;
    this.maxBars = Math.max(16, Math.floor(w / (barW + gap)));
    const mid = h / 2;

    // center line
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, mid);
    g.lineTo(w, mid);
    g.stroke();

    const n = this.bars.length;
    for (let i = 0; i < n; i++) {
      const v = this.bars[i];
      // perceptual-ish scaling so quiet input is still visible
      const bh = Math.max(2, Math.pow(v, 0.6) * (h - 8));
      const x = w - (n - i) * (barW + gap);
      if (x + barW < 0) continue;
      const bright = 0.35 + 0.65 * Math.min(1, v * 2);
      g.fillStyle = recording
        ? `rgba(255, 93, 93, ${bright})`
        : live
          ? `rgba(108, 140, 255, ${bright})`
          : `rgba(108, 140, 255, ${0.25 + 0.4 * v})`;
      g.fillRect(x, mid - bh / 2, barW, bh);
    }
  }
}
