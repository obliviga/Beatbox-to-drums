/**
 * DrumEngine — synthesizes drum sounds with the Web Audio API.
 *
 * Six kits, all generated procedurally (no sample files to load):
 *   acoustic — sine-drop kick with beater click, noise+shell-tone snare, bright hat
 *   tr808    — saturated sine kick, snappy snare, metallic square-stack hat
 *   trap     — long sub kick, clap-crack snare, tight bright metal hat
 *   electro  — pitch-zap kick, clap-style snare, resonant hat
 *   lofi     — heavily saturated dull kick, dusty snare, muffled hat
 *   perc     — conga, block slap, shaker
 *
 * Every voice takes (ctx, out, noiseBuf, when, velocity) and returns its
 * source nodes so scheduled playback can be cancelled mid-flight.
 *
 * Works against both AudioContext and OfflineAudioContext (WAV export).
 */

import { layerIndex } from './sample-kit.js';

export const KIT_NAMES = ['real', 'acoustic', 'tr808', 'trap', 'electro', 'lofi', 'perc'];

// Subtle stereo placement per instrument, like sitting at a kit
const PAN = { kick: 0, snare: -0.08, hat: 0.14 };

// How much of each drum feeds the shared room reverb — the "recorded
// together in one room" glue. Kick stays tight, snare blooms most.
const REVERB_SEND = { kick: 0.07, snare: 0.22, hat: 0.1 };

export class DrumEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.kit = 'acoustic';
    this.scheduled = new Set();
    this.sampleKits = {};   // name → {kick|snare|hat: {boundaries, buffers}}
    this._rrPhase = { kick: 0, snare: 0, hat: 0 }; // humanization counter

    /*
     * Production chain — what turns triggered one-shots into a mixed,
     * produced-sounding beat:
     *
     *   voices → master ─┬─ dry ────────────────┐
     *                    └─ squash (heavy comp) ─┤→ bus → saturation → limiter → out
     *   voices → per-drum sends → room reverb ───┘
     *
     * Parallel ("New York") compression adds density without killing
     * transients; a generated-impulse room glues the drums into one
     * space; gentle tanh saturation and a limiter finish the bus.
     */
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;

    const dry = ctx.createGain();
    dry.gain.value = 1;

    const squash = ctx.createDynamicsCompressor();
    squash.threshold.value = -32;
    squash.knee.value = 6;
    squash.ratio.value = 12;
    squash.attack.value = 0.003;
    squash.release.value = 0.25;
    const squashGain = ctx.createGain();
    squashGain.gain.value = 0.4;

    this._convolver = ctx.createConvolver();
    this._convolver.buffer = makeRoomIR(ctx);
    const revReturn = ctx.createGain();
    revReturn.gain.value = 0.3;

    const bus = ctx.createGain();
    const saturation = makeDrive(ctx, 1.15); // barely-there glue drive
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.1;

    this.master.connect(dry);
    this.master.connect(squash);
    squash.connect(squashGain);
    this._convolver.connect(revReturn);
    dry.connect(bus);
    squashGain.connect(bus);
    revReturn.connect(bus);
    bus.connect(saturation);
    saturation.connect(limiter);
    limiter.connect(ctx.destination);

    this.noiseBuf = makeNoiseBuffer(ctx);
  }

  setKit(name) {
    if (KITS[name] || this.sampleKits[name] || name === 'real') this.kit = name;
  }

  /** Register decoded sample buffers (see js/sample-kit.js) as a kit. */
  registerSampleKit(name, kit) {
    this.sampleKits[name] = kit;
  }

  /**
   * Play a drum. `track: true` registers the sources so stopScheduled()
   * can cancel them (used by the loop recorder's playback).
   * @param {'kick'|'snare'|'hat'} type
   */
  trigger(type, { when = this.ctx.currentTime, velocity = 1, track = false } = {}) {
    const v = Math.min(1, Math.max(0.05, velocity));
    const sampleKit = this.sampleKits[this.kit];
    let sources;
    if (sampleKit && sampleKit[type]) {
      sources = this._playSample(sampleKit[type], type, when, v);
    } else {
      // synth voice — also the fallback while the 'real' kit is loading
      const kitDef = KITS[this.kit] || KITS.acoustic;
      const voice = kitDef[type];
      if (!voice) return;
      sources = voice(this.ctx, this._outputFor(type), this.noiseBuf, when, v);
    }
    if (track) {
      for (const s of sources) {
        this.scheduled.add(s);
        s.onended = () => this.scheduled.delete(s);
      }
    }
  }

  _playSample(drum, type, when, v) {
    const src = this.ctx.createBufferSource();
    src.buffer = drum.buffers[Math.min(layerIndex(drum.boundaries, v), drum.buffers.length - 1)];
    // Humanize: alternate tiny detunes so fast rolls never repeat a
    // bit-identical file (the kit has one recording per layer).
    const phase = this._rrPhase[type] = (this._rrPhase[type] + 1) % 4;
    src.playbackRate.value = 1 + (phase - 1.5) * 0.01; // ±1.5%
    const gain = this.ctx.createGain();
    // layers carry the timbre; a gentle gain slope smooths steps between them
    gain.gain.value = 0.7 + 0.3 * v;
    src.connect(gain).connect(this._outputFor(type));
    src.start(when);
    return [src];
  }

  /** Metronome click (not part of any kit, never in WAV exports). */
  click(when, accent = false) {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = accent ? 2100 : 1650;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(accent ? 0.35 : 0.2, when);
    g.gain.exponentialRampToValueAtTime(0.001, when + 0.035);
    o.connect(g).connect(this.master);
    o.start(when);
    o.stop(when + 0.06);
  }

  stopScheduled() {
    for (const s of this.scheduled) {
      try { s.stop(0); } catch { /* already stopped */ }
    }
    this.scheduled.clear();
  }

  _outputFor(type) {
    let out;
    if (this.ctx.createStereoPanner) {
      out = this.ctx.createStereoPanner();
      // tiny per-hit jitter keeps repeated hits from sounding machine-identical
      out.pan.value = (PAN[type] || 0) + (Math.random() * 2 - 1) * 0.04;
    } else {
      out = this.ctx.createGain();
    }
    out.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = REVERB_SEND[type] ?? 0.1;
    out.connect(send);
    send.connect(this._convolver);
    return out;
  }
}

/* ---------- shared helpers ---------- */

/**
 * Generated room impulse response: decorrelated exponentially-decaying
 * noise per channel with softened highs — a believable small drum room
 * with zero asset bytes. ConvolverNode's built-in normalization keeps
 * the wet level consistent across sample rates.
 */
function makeRoomIR(ctx, seconds = 0.5) {
  const rate = ctx.sampleRate;
  const len = Math.ceil(seconds * rate);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      // one-pole lowpass on the noise darkens the tail like real walls do
      const smooth = 0.55 + 0.35 * (i / len);
      lp = lp * smooth + (Math.random() * 2 - 1) * (1 - smooth);
      data[i] = lp * Math.exp(-t * 9);
    }
  }
  return buf;
}

function makeNoiseBuffer(ctx) {
  const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function envGain(ctx, when, level, decay) {
  const g = ctx.createGain();
  g.gain.setValueAtTime(Math.max(level, 0.001), when);
  g.gain.exponentialRampToValueAtTime(0.001, when + decay);
  return g;
}

function makeOsc(ctx, type, freq, when, dur) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  o.start(when);
  o.stop(when + dur);
  return o;
}

function makeNoise(ctx, buf, when, dur) {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.start(when);
  s.stop(when + dur);
  return s;
}

function makeFilter(ctx, type, freq, q = 0.707) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function makeDrive(ctx, amount) {
  const shaper = ctx.createWaveShaper();
  const curve = new Float32Array(257);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / 128) - 1;
    curve[i] = Math.tanh(amount * x);
  }
  shaper.curve = curve;
  return shaper;
}

/** Classic 808-style metal: detuned squares through tight band/high-pass. */
function metalHat(ctx, out, t, v, { base = 40, bp = 10000, bpQ = 1.2, hp = 7000, decay = 0.05, level = 0.4 }) {
  const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
  const pre = ctx.createGain();
  pre.gain.value = 0.2;
  const band = makeFilter(ctx, 'bandpass', bp, bpQ);
  const high = makeFilter(ctx, 'highpass', hp);
  const g = envGain(ctx, t, level * v, decay);
  pre.connect(band).connect(high).connect(g).connect(out);
  return ratios.map((r) => {
    const o = makeOsc(ctx, 'square', base * r, t, decay + 0.03);
    o.connect(pre);
    return o;
  });
}

/** Clap-style: quick noise bursts, then a noise tail, through one bandpass. */
function clap(ctx, out, noise, t, v, { bp = 1600, bpQ = 1.1, tailHp = null, tailLevel = 0.45, tailDecay = 0.2 }) {
  const band = makeFilter(ctx, 'bandpass', bp, bpQ);
  band.connect(out);
  const sources = [];
  for (const [dt, level] of [[0, 0.5], [0.012, 0.4], [0.024, 0.35]]) {
    const n = makeNoise(ctx, noise, t + dt, 0.015);
    const g = envGain(ctx, t + dt, level * v, 0.013);
    n.connect(g).connect(band);
    sources.push(n);
  }
  const tail = makeNoise(ctx, noise, t + 0.036, tailDecay + 0.03);
  const tg = envGain(ctx, t + 0.036, tailLevel * v, tailDecay);
  if (tailHp) {
    const f = makeFilter(ctx, 'highpass', tailHp);
    tail.connect(f).connect(tg).connect(band);
  } else {
    tail.connect(tg).connect(band);
  }
  sources.push(tail);
  return sources;
}

/* ---------- kits ---------- */

const KITS = {
  acoustic: {
    kick(ctx, out, noise, t, v) {
      const osc = makeOsc(ctx, 'sine', 160, t, 0.3);
      osc.frequency.exponentialRampToValueAtTime(52, t + 0.09);
      const g = envGain(ctx, t, 0.95 * v, 0.26);
      osc.connect(g).connect(out);
      const click = makeNoise(ctx, noise, t, 0.03);
      const lp = makeFilter(ctx, 'lowpass', 3500);
      const cg = envGain(ctx, t, 0.3 * v, 0.02);
      click.connect(lp).connect(cg).connect(out);
      return [osc, click];
    },
    snare(ctx, out, noise, t, v) {
      const n = makeNoise(ctx, noise, t, 0.22);
      const bp = makeFilter(ctx, 'bandpass', 2200, 0.7);
      const ng = envGain(ctx, t, 0.7 * v, 0.18);
      n.connect(bp).connect(ng).connect(out);
      const o1 = makeOsc(ctx, 'triangle', 196, t, 0.12);
      const g1 = envGain(ctx, t, 0.5 * v, 0.09);
      o1.connect(g1).connect(out);
      const o2 = makeOsc(ctx, 'triangle', 330, t, 0.08);
      const g2 = envGain(ctx, t, 0.2 * v, 0.06);
      o2.connect(g2).connect(out);
      return [n, o1, o2];
    },
    hat(ctx, out, noise, t, v) {
      const n = makeNoise(ctx, noise, t, 0.08);
      const hp = makeFilter(ctx, 'highpass', 7200);
      const g = envGain(ctx, t, 0.45 * v, 0.055);
      n.connect(hp).connect(g).connect(out);
      return [n];
    },
  },

  tr808: {
    kick(ctx, out, noise, t, v) {
      const osc = makeOsc(ctx, 'sine', 110, t, 0.55);
      osc.frequency.exponentialRampToValueAtTime(41, t + 0.12);
      const drive = makeDrive(ctx, 2.5);
      const g = envGain(ctx, t, 0.95 * v, 0.5);
      osc.connect(drive).connect(g).connect(out);
      return [osc];
    },
    snare(ctx, out, noise, t, v) {
      const o = makeOsc(ctx, 'sine', 185, t, 0.12);
      const og = envGain(ctx, t, 0.5 * v, 0.09);
      o.connect(og).connect(out);
      const n = makeNoise(ctx, noise, t, 0.16);
      const hp = makeFilter(ctx, 'highpass', 900);
      const ng = envGain(ctx, t, 0.55 * v, 0.14);
      n.connect(hp).connect(ng).connect(out);
      return [o, n];
    },
    hat(ctx, out, noise, t, v) {
      return metalHat(ctx, out, t, v, { base: 40, bp: 10000, hp: 7000, decay: 0.05, level: 0.4 });
    },
  },

  trap: {
    kick(ctx, out, noise, t, v) {
      // Long saturated sub with a sharp click on top
      const osc = makeOsc(ctx, 'sine', 100, t, 0.75);
      osc.frequency.exponentialRampToValueAtTime(36, t + 0.1);
      const drive = makeDrive(ctx, 3.5);
      const g = envGain(ctx, t, 0.95 * v, 0.65);
      osc.connect(drive).connect(g).connect(out);
      const click = makeNoise(ctx, noise, t, 0.012);
      const hp = makeFilter(ctx, 'highpass', 3000);
      const cg = envGain(ctx, t, 0.2 * v, 0.008);
      click.connect(hp).connect(cg).connect(out);
      return [osc, click];
    },
    snare(ctx, out, noise, t, v) {
      const sources = clap(ctx, out, noise, t, v, { bp: 1500, bpQ: 1, tailHp: 1400, tailLevel: 0.5, tailDecay: 0.22 });
      const o = makeOsc(ctx, 'sine', 180, t, 0.08);
      const og = envGain(ctx, t, 0.35 * v, 0.06);
      o.connect(og).connect(out);
      sources.push(o);
      return sources;
    },
    hat(ctx, out, noise, t, v) {
      return metalHat(ctx, out, t, v, { base: 46, bp: 11500, bpQ: 1, hp: 8500, decay: 0.03, level: 0.45 });
    },
  },

  electro: {
    kick(ctx, out, noise, t, v) {
      // Zap: very fast pitch sweep into a low hold, saturated
      const osc = makeOsc(ctx, 'sine', 500, t, 0.35);
      osc.frequency.exponentialRampToValueAtTime(48, t + 0.04);
      const drive = makeDrive(ctx, 4);
      const g = envGain(ctx, t, 0.9 * v, 0.32);
      osc.connect(drive).connect(g).connect(out);
      const click = makeNoise(ctx, noise, t, 0.012);
      const hp = makeFilter(ctx, 'highpass', 2000);
      const cg = envGain(ctx, t, 0.25 * v, 0.01);
      click.connect(hp).connect(cg).connect(out);
      return [osc, click];
    },
    snare(ctx, out, noise, t, v) {
      return clap(ctx, out, noise, t, v, { bp: 1600, bpQ: 1.1, tailLevel: 0.45, tailDecay: 0.2 });
    },
    hat(ctx, out, noise, t, v) {
      const n = makeNoise(ctx, noise, t, 0.05);
      const bp = makeFilter(ctx, 'bandpass', 9500, 2);
      const hp = makeFilter(ctx, 'highpass', 8000);
      const g = envGain(ctx, t, 0.5 * v, 0.035);
      n.connect(bp).connect(hp).connect(g).connect(out);
      return [n];
    },
  },

  lofi: {
    kick(ctx, out, noise, t, v) {
      // Crushed and dull: heavy drive into a closed-down lowpass
      const osc = makeOsc(ctx, 'sine', 120, t, 0.28);
      osc.frequency.exponentialRampToValueAtTime(50, t + 0.07);
      const drive = makeDrive(ctx, 5);
      const lp = makeFilter(ctx, 'lowpass', 1800);
      const g = envGain(ctx, t, 0.9 * v, 0.22);
      osc.connect(drive).connect(lp).connect(g).connect(out);
      return [osc];
    },
    snare(ctx, out, noise, t, v) {
      const n = makeNoise(ctx, noise, t, 0.18);
      const bp = makeFilter(ctx, 'bandpass', 1100, 0.8);
      const lp = makeFilter(ctx, 'lowpass', 3200);
      const ng = envGain(ctx, t, 0.75 * v, 0.15);
      n.connect(bp).connect(lp).connect(ng).connect(out);
      const o = makeOsc(ctx, 'triangle', 170, t, 0.09);
      const og = envGain(ctx, t, 0.4 * v, 0.07);
      o.connect(og).connect(out);
      return [n, o];
    },
    hat(ctx, out, noise, t, v) {
      // Dusty: band-limited between 5–7 kHz so it sits behind the beat
      const n = makeNoise(ctx, noise, t, 0.06);
      const lp = makeFilter(ctx, 'lowpass', 7000);
      const hp = makeFilter(ctx, 'highpass', 5000);
      const g = envGain(ctx, t, 0.5 * v, 0.04);
      n.connect(lp).connect(hp).connect(g).connect(out);
      return [n];
    },
  },

  perc: {
    kick(ctx, out, noise, t, v) {
      // Conga: tuned head with a bit of slap
      const osc = makeOsc(ctx, 'sine', 165, t, 0.22);
      osc.frequency.exponentialRampToValueAtTime(150, t + 0.02);
      const g = envGain(ctx, t, 0.8 * v, 0.18);
      osc.connect(g).connect(out);
      const slap = makeNoise(ctx, noise, t, 0.025);
      const bp = makeFilter(ctx, 'bandpass', 1000, 1);
      const sg = envGain(ctx, t, 0.25 * v, 0.02);
      slap.connect(bp).connect(sg).connect(out);
      return [osc, slap];
    },
    snare(ctx, out, noise, t, v) {
      // Block slap: short woody ping plus a click of noise
      const o = makeOsc(ctx, 'triangle', 800, t, 0.08);
      const og = envGain(ctx, t, 0.5 * v, 0.055);
      o.connect(og).connect(out);
      const n = makeNoise(ctx, noise, t, 0.035);
      const bp = makeFilter(ctx, 'bandpass', 2500, 2.5);
      const ng = envGain(ctx, t, 0.3 * v, 0.03);
      n.connect(bp).connect(ng).connect(out);
      return [o, n];
    },
    hat(ctx, out, noise, t, v) {
      // Shaker
      const n = makeNoise(ctx, noise, t, 0.08);
      const bp = makeFilter(ctx, 'bandpass', 5200, 1.4);
      const hp = makeFilter(ctx, 'highpass', 3500);
      const g = envGain(ctx, t, 0.45 * v, 0.06);
      n.connect(bp).connect(hp).connect(g).connect(out);
      return [n];
    },
  },
};
