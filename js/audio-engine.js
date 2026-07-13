/**
 * DrumEngine — synthesizes drum sounds with the Web Audio API.
 *
 * Three kits, all generated procedurally (no sample files to load):
 *   acoustic — sine-drop kick with beater click, noise+shell-tone snare, bright hat
 *   tr808    — long saturated sine kick, snappy snare, metallic square-stack hat
 *   electro  — pitch-zap kick, clap-style snare, tight resonant hat
 *
 * Every voice takes (ctx, out, noiseBuf, when, velocity) and returns its
 * source nodes so scheduled playback can be cancelled mid-flight.
 */

export class DrumEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.kit = 'acoustic';
    this.scheduled = new Set();

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 18;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    this.noiseBuf = makeNoiseBuffer(ctx);
  }

  setKit(name) {
    if (KITS[name]) this.kit = name;
  }

  /**
   * Play a drum. `track: true` registers the sources so stopScheduled()
   * can cancel them (used by the loop recorder's playback).
   * @param {'kick'|'snare'|'hat'} type
   */
  trigger(type, { when = this.ctx.currentTime, velocity = 1, track = false } = {}) {
    const voice = KITS[this.kit] && KITS[this.kit][type];
    if (!voice) return;
    const v = Math.min(1, Math.max(0.05, velocity));
    const sources = voice(this.ctx, this.master, this.noiseBuf, when, v);
    if (track) {
      for (const s of sources) {
        this.scheduled.add(s);
        s.onended = () => this.scheduled.delete(s);
      }
    }
  }

  stopScheduled() {
    for (const s of this.scheduled) {
      try { s.stop(0); } catch { /* already stopped */ }
    }
    this.scheduled.clear();
  }
}

/* ---------- shared helpers ---------- */

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

/* ---------- kits ---------- */

const KITS = {
  acoustic: {
    kick(ctx, out, noise, t, v) {
      // Body: fast sine pitch drop
      const osc = makeOsc(ctx, 'sine', 160, t, 0.3);
      osc.frequency.exponentialRampToValueAtTime(52, t + 0.09);
      const g = envGain(ctx, t, 0.95 * v, 0.26);
      osc.connect(g).connect(out);
      // Beater click
      const click = makeNoise(ctx, noise, t, 0.03);
      const lp = makeFilter(ctx, 'lowpass', 3500);
      const cg = envGain(ctx, t, 0.3 * v, 0.02);
      click.connect(lp).connect(cg).connect(out);
      return [osc, click];
    },
    snare(ctx, out, noise, t, v) {
      // Wires: broadband noise burst
      const n = makeNoise(ctx, noise, t, 0.22);
      const bp = makeFilter(ctx, 'bandpass', 2200, 0.7);
      const ng = envGain(ctx, t, 0.7 * v, 0.18);
      n.connect(bp).connect(ng).connect(out);
      // Shell: two short tones
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
      // Classic 808 metal: six detuned squares through tight filters
      const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
      const pre = ctx.createGain();
      pre.gain.value = 0.2;
      const bp = makeFilter(ctx, 'bandpass', 10000, 1.2);
      const hp = makeFilter(ctx, 'highpass', 7000);
      const g = envGain(ctx, t, 0.4 * v, 0.05);
      pre.connect(bp).connect(hp).connect(g).connect(out);
      const oscs = ratios.map((r) => {
        const o = makeOsc(ctx, 'square', 40 * r, t, 0.08);
        o.connect(pre);
        return o;
      });
      return oscs;
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
      // Clap-style: three quick bursts, then a noise tail
      const bp = makeFilter(ctx, 'bandpass', 1600, 1.1);
      bp.connect(out);
      const sources = [];
      const bursts = [
        [0, 0.5], [0.012, 0.4], [0.024, 0.35],
      ];
      for (const [dt, level] of bursts) {
        const n = makeNoise(ctx, noise, t + dt, 0.015);
        const g = envGain(ctx, t + dt, level * v, 0.013);
        n.connect(g).connect(bp);
        sources.push(n);
      }
      const tail = makeNoise(ctx, noise, t + 0.036, 0.22);
      const tg = envGain(ctx, t + 0.036, 0.45 * v, 0.2);
      tail.connect(tg).connect(bp);
      sources.push(tail);
      return sources;
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
};
